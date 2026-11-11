// Saga outcome consumer. The monolith orchestrates provider approval, so it subscribes to the
// Notifications service's outcome events on its own durable queue. A boot retry handles RabbitMQ
// still starting; after that the queue is bound to notification.created / notification.failed.
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { getConsumerChannel } from "../../messaging/rabbit.js";
import { handleNotificationOutcome } from "./service.js";
import { getTracer, extractTraceparent, context, trace, SpanKind } from "../../telemetry.js";

const CONSUMER = Symbol.for("edemand.saga.consumer");
const BOOT_ATTEMPTS = 60;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startSagaConsumer() {
  if (!config.rabbitmq.enabled) {
    logger.warn("saga consumer not started: RABBITMQ_URL is not configured");
    return false;
  }
  if (globalThis[CONSUMER]) return true;

  for (let attempt = 1; attempt <= BOOT_ATTEMPTS; attempt++) {
    try {
      const channel = await getConsumerChannel();
      await channel.assertQueue(config.rabbitmq.sagaQueue, { durable: true });
      await channel.bindQueue(config.rabbitmq.sagaQueue, config.rabbitmq.exchange, "notification.created");
      await channel.bindQueue(config.rabbitmq.sagaQueue, config.rabbitmq.exchange, "notification.failed");
      await channel.prefetch(20);

      const tag = await channel.consume(config.rabbitmq.sagaQueue, (msg) => {
        if (!msg) return;
        // Area E: close the loop. The notifications consumer put its traceparent on the outcome,
        // so this span is the last child of the trace that began at the approval request.
        const parent = extractTraceparent(msg.properties && msg.properties.headers);
        const span = getTracer("edemand").startSpan(
          `consume ${(msg.properties && msg.properties.type) || "saga outcome"}`,
          {
            kind: SpanKind.CONSUMER,
            attributes: {
              "messaging.system": "rabbitmq",
              "messaging.destination": config.rabbitmq.sagaQueue,
            },
          },
          parent
        );
        context.with(trace.setSpan(context.active(), span), () => {
          try {
            const envelope = JSON.parse(msg.content.toString());
            handleNotificationOutcome(envelope);
            channel.ack(msg);
          } catch (err) {
            logger.error({ err: err.message }, "saga consumer: outcome failed; requeueing");
            channel.nack(msg, false, true);
          } finally {
            span.end();
          }
        });
      });

      globalThis[CONSUMER] = { channel, tag };
      logger.info(
        { queue: config.rabbitmq.sagaQueue, exchange: config.rabbitmq.exchange },
        "saga consumer started"
      );
      return true;
    } catch (err) {
      if (attempt === BOOT_ATTEMPTS) throw err;
      logger.warn({ attempt, err: err.message }, "saga consumer: broker not ready; retrying");
      await sleep(1000);
    }
  }
  return false;
}

export async function stopSagaConsumer() {
  const current = globalThis[CONSUMER];
  globalThis[CONSUMER] = null;
  if (!current) return;
  try {
    await current.channel.cancel(current.tag);
  } catch {
    // connection already gone
  }
}
