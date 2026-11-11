import amqp from "amqplib";
import { logger } from "../../logger.js";

export async function publishNotification(url, eventType, notification) {
  const connection = await amqp.connect(url, { timeout: 3000 });
  connection.on("error", (err) => {
    logger.warn({ err: err.message }, "RabbitMQ connection error");
  });

  try {
    const channel = await connection.createConfirmChannel();
    channel.on("error", (err) => {
      logger.warn({ err: err.message }, "RabbitMQ channel error");
    });

    const queue = "homeservice.notifications";
    await channel.assertQueue(queue, { durable: true });

    const message = { type: eventType, notification };
    channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)), {
      persistent: true,
      contentType: "application/json",
      messageId: notification.source_event_id,
    });

    await channel.waitForConfirms();
  } finally {
    await connection.close().catch(() => {});
  }
}