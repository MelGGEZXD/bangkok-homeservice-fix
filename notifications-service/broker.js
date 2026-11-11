// RabbitMQ consumer for the Notifications service (Area C).
//
// This replaces the monolith's HTTP delivery as the production ingest path. The message is the raw
// domain event; this service owns the event -> notification projection. After projecting it
// publishes an outcome so the orchestrating monolith can finish or compensate its saga:
//
//   notification.created  -> the saga's remote step succeeded
//   notification.failed   -> the saga must run its compensating action
//
// Delivery is at-least-once. The unique key on
// (source_event_id, recipient_role, recipient_id, type) makes a redelivered event a no-op, which is
// exactly the duplicate-delivery proof the demo shows.
const amqp = require("amqplib");
const { randomUUID } = require("node:crypto");
const config = require("./config");
const { insertNotification } = require("./db");
const { project } = require("./notification-rules.cjs");
const faults = require("./faults");

// Every event type this context knows how to project. Bind explicitly instead of "#": a future
// event without a rule must not silently enter the notifications queue.
const EVENT_TYPES = [
  "review.created",
  "provider.approved",
  "provider.approval_reverted",
  "booking.status_changed",
  "booking.completed",
  "bid.accepted",
  "payment.succeeded",
];

let connection;
let consumerChannel;
let publisherChannel;
let consumerTag;
let state = "stopped";
let connecting;

function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ level, service: "notifications", msg, ...extra }));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openConnection() {
  const conn = await amqp.connect(config.rabbitmq.url, { heartbeat: 30 });
  conn.on("error", (err) => log("error", "rabbitmq connection error", { err: err.message }));
  conn.on("close", () => {
    state = "disconnected";
    connection = undefined;
    consumerChannel = undefined;
    publisherChannel = undefined;
    consumerTag = undefined;
    log("warn", "rabbitmq connection closed");
  });
  connection = conn;
  return conn;
}

async function ensurePublisher() {
  if (publisherChannel) return publisherChannel;
  const channel = await connection.createConfirmChannel();
  channel.on("error", (err) => log("error", "rabbitmq publisher channel error", { err: err.message }));
  channel.on("close", () => {
    publisherChannel = undefined;
  });
  await channel.assertExchange(config.rabbitmq.exchange, "topic", { durable: true });
  publisherChannel = channel;
  return channel;
}

// Confirm-mode publish: resolves only when RabbitMQ accepted the outcome message.
async function publishOutcome(type, payload) {
  const channel = await ensurePublisher();
  const envelope = {
    event_uid: randomUUID(),
    type,
    aggregate_type: "saga",
    aggregate_id: payload.saga_id,
    payload,
    occurred_at: new Date().toISOString(),
  };
  await new Promise((resolve, reject) => {
    channel.publish(
      config.rabbitmq.exchange,
      type,
      Buffer.from(JSON.stringify(envelope)),
      {
        persistent: true,
        contentType: "application/json",
        contentEncoding: "utf-8",
        messageId: envelope.event_uid,
        type,
        timestamp: Date.now(),
      },
      (err) => (err ? reject(err) : resolve())
    );
  });
  log("info", "saga outcome published", { type, saga_id: payload.saga_id });
}

async function handleMessage(msg) {
  let envelope;
  try {
    envelope = JSON.parse(msg.content.toString());
  } catch (err) {
    log("error", "dropping unparseable message", { err: err.message });
    consumerChannel.ack(msg);
    return;
  }

  const sagaId = envelope.payload && envelope.payload.saga_id;
  const projections = project(envelope);

  if (projections.length === 0) {
    log("warn", "no projection for event; acknowledging", { type: envelope.type });
    consumerChannel.ack(msg);
    return;
  }

  try {
    if (faults.consumeNotificationFailure()) {
      const err = new Error("injected notification failure");
      err.injected = true;
      throw err;
    }

    let created = 0;
    let duplicates = 0;
    for (const notification of projections) {
      const result = await insertNotification(notification);
      if (result.duplicate) duplicates += 1;
      else created += 1;
    }

    if (sagaId) {
      await publishOutcome("notification.created", {
        saga_id: sagaId,
        source_event_id: envelope.event_uid,
        source_type: envelope.type,
        created,
        duplicates,
      });
    }
    log("info", "event projected", {
      type: envelope.type,
      event_uid: envelope.event_uid,
      created,
      duplicates,
    });
    consumerChannel.ack(msg);
  } catch (err) {
    log("error", "event projection failed", {
      type: envelope.type,
      event_uid: envelope.event_uid,
      saga_id: sagaId || null,
      err: err.message,
    });

    if (sagaId) {
      // Escalate to the orchestrator: the saga's compensating action is the recovery path.
      // Requeueing a permanently failing projection would just spin.
      try {
        await publishOutcome("notification.failed", {
          saga_id: sagaId,
          source_event_id: envelope.event_uid,
          source_type: envelope.type,
          error: err.message,
        });
        consumerChannel.ack(msg);
      } catch (publishErr) {
        log("error", "could not publish failure outcome; requeueing", { err: publishErr.message });
        consumerChannel.nack(msg, false, true);
      }
      return;
    }

    if (err.injected) {
      log("warn", "injected fault on non-saga event; acknowledging", { type: envelope.type });
      consumerChannel.ack(msg);
      return;
    }

    // Transient failure (database/broker): retry via redelivery.
    consumerChannel.nack(msg, false, true);
  }
}

async function connectOnce() {
  if (!connection) await openConnection();
  const channel = await connection.createChannel();
  channel.on("error", (err) => log("error", "rabbitmq consumer channel error", { err: err.message }));
  channel.on("close", () => {
    consumerChannel = undefined;
    consumerTag = undefined;
  });

  await channel.assertExchange(config.rabbitmq.exchange, "topic", { durable: true });
  await channel.assertQueue(config.rabbitmq.queue, { durable: true });
  for (const type of EVENT_TYPES) {
    await channel.bindQueue(config.rabbitmq.queue, config.rabbitmq.exchange, type);
  }
  await channel.prefetch(config.rabbitmq.prefetch);

  consumerTag = await channel.consume(config.rabbitmq.queue, (msg) => {
    if (!msg) return;
    handleMessage(msg).catch((err) => {
      log("error", "unhandled consumer error", { err: err.stack || err.message });
      try {
        consumerChannel.nack(msg, false, true);
      } catch {
        // channel already gone; broker will redeliver after reconnect
      }
    });
  });

  consumerChannel = channel;
  state = "running";
  log("info", "notifications consumer started", {
    queue: config.rabbitmq.queue,
    exchange: config.rabbitmq.exchange,
    eventTypes: EVENT_TYPES,
  });
}

async function startBroker({ attempts = 60 } = {}) {
  if (!config.rabbitmq.enabled) {
    log("warn", "rabbitmq consumer not started: RABBITMQ_URL is not configured");
    return false;
  }
  if (state === "running") return true;
  if (connecting) return connecting;

  connecting = (async () => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await connectOnce();
        return true;
      } catch (err) {
        state = "retrying";
        if (attempt === attempts) {
          log("fatal", "could not start rabbitmq consumer", { err: err.message });
          throw err;
        }
        log("warn", "rabbitmq not ready; retrying", { attempt, err: err.message });
        await sleep(1000);
      }
    }
    return false;
  })().finally(() => {
    connecting = undefined;
  });

  return connecting;
}

function getBrokerStatus() {
  return {
    state,
    queue: config.rabbitmq.queue,
    exchange: config.rabbitmq.exchange,
    enabled: config.rabbitmq.enabled,
  };
}

async function stopBroker() {
  state = "stopped";
  try {
    if (consumerChannel && consumerTag) await consumerChannel.cancel(consumerTag);
    if (publisherChannel) await publisherChannel.close();
    if (consumerChannel) await consumerChannel.close();
    if (connection) await connection.close();
  } catch (err) {
    log("warn", "error while closing rabbitmq", { err: err.message });
  } finally {
    connection = undefined;
    consumerChannel = undefined;
    publisherChannel = undefined;
    consumerTag = undefined;
  }
}

module.exports = { startBroker, stopBroker, getBrokerStatus, EVENT_TYPES };
