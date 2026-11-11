// RabbitMQ connection + topology for the Area C event path.
//
// The monolith is both a publisher (outbox relay) and a consumer (saga outcomes). Next.js bundles
// lib code into more than one server chunk, so the connection/channel promises live on globalThis —
// the same reason the Keycloak JWKS cache does. Without that, the relay and the saga consumer each
// open their own connection to the same broker.
import amqp from "amqplib";
import { config } from "../config.js";
import { logger } from "../logger.js";

const CONNECTION = Symbol.for("edemand.rabbit.connection");
const CONNECTING = Symbol.for("edemand.rabbit.connecting");
const CONFIRM_CHANNEL = Symbol.for("edemand.rabbit.confirm-channel");
const CONSUMER_CHANNEL = Symbol.for("edemand.rabbit.consumer-channel");

function checkEnabled() {
  if (!config.rabbitmq.enabled) {
    throw new Error("RabbitMQ is not configured (set RABBITMQ_URL)");
  }
}

async function openConnection() {
  const conn = await amqp.connect(config.rabbitmq.url, { heartbeat: 30 });
  conn.on("error", (err) => logger.error({ err: err.message }, "rabbitmq: connection error"));
  conn.on("close", () => {
    logger.warn("rabbitmq: connection closed");
    globalThis[CONNECTION] = null;
    globalThis[CONFIRM_CHANNEL] = null;
    globalThis[CONSUMER_CHANNEL] = null;
  });
  globalThis[CONNECTION] = conn;
  return conn;
}

export async function getConnection() {
  checkEnabled();
  if (globalThis[CONNECTION]) return globalThis[CONNECTION];
  if (!globalThis[CONNECTING]) {
    globalThis[CONNECTING] = openConnection().finally(() => {
      globalThis[CONNECTING] = null;
    });
  }
  return globalThis[CONNECTING];
}

async function makeChannel(kind, cacheKey) {
  const conn = await getConnection();
  const channel =
    kind === "confirm" ? await conn.createConfirmChannel() : await conn.createChannel();
  channel.on("error", (err) => logger.error({ err: err.message }, "rabbitmq: channel error"));
  channel.on("close", () => {
    globalThis[cacheKey] = null;
  });
  await channel.assertExchange(config.rabbitmq.exchange, "topic", { durable: true });
  globalThis[cacheKey] = channel;
  return channel;
}

export async function getConfirmChannel() {
  if (globalThis[CONFIRM_CHANNEL]) return globalThis[CONFIRM_CHANNEL];
  return makeChannel("confirm", CONFIRM_CHANNEL);
}

export async function getConsumerChannel() {
  if (globalThis[CONSUMER_CHANNEL]) return globalThis[CONSUMER_CHANNEL];
  return makeChannel("consume", CONSUMER_CHANNEL);
}

// Publisher confirms: the publish callback fires only once RabbitMQ has persisted the message to the
// durable exchange/queue, so the relay can safely mark the outbox row processed afterwards.
export function publishEnvelope(envelope) {
  return getConfirmChannel().then(
    (channel) =>
      new Promise((resolve, reject) => {
        let settled = false;
        const done = (err) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve();
        };
        const ok = channel.publish(
          config.rabbitmq.exchange,
          envelope.type,
          Buffer.from(JSON.stringify(envelope)),
          {
            persistent: true,
            contentType: "application/json",
            contentEncoding: "utf-8",
            messageId: envelope.event_uid,
            type: envelope.type,
            timestamp: Date.now(),
            // Area E: a standard W3C header, so any OpenTelemetry consumer can join the trace.
            headers: envelope.trace_parent ? { traceparent: envelope.trace_parent } : undefined,
          },
          done
        );
        if (!ok) {
          // Applying backpressure is not an error; the confirm callback still decides success.
          logger.debug({ type: envelope.type }, "rabbitmq: publish buffered");
        }
      })
  );
}

export async function closeRabbit() {
  const conn = globalThis[CONNECTION];
  globalThis[CONNECTION] = null;
  globalThis[CONFIRM_CHANNEL] = null;
  globalThis[CONSUMER_CHANNEL] = null;
  if (conn) {
    try {
      await conn.close();
    } catch {
      // already closed
    }
  }
}
