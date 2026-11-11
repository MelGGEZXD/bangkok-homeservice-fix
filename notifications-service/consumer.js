const amqp = require("amqplib");
const { insertNotification, notificationCommand } = require("./app");

async function startNotificationConsumer(url, pool) {
  const connection = await amqp.connect(url, { timeout: 3000 });
  connection.on("error", (err) => console.error("RabbitMQ connection:", err.message));

  try {
    const channel = await connection.createChannel();
    channel.on("error", (err) => console.error("RabbitMQ channel:", err.message));

    let channelOpen = true;
    channel.on("close", () => { channelOpen = false; });

    const queue = "homeservice.notifications";
    await channel.assertQueue(queue, { durable: true });
    await channel.prefetch(1);

    await channel.consume(queue, async (message) => {
      if (!message) return;

      let event;
      try {
        event = JSON.parse(message.content.toString("utf8"));
      } catch {
        console.warn("Invalid notification message: expected JSON");
        channel.reject(message, false);
        return;
      }

      const parsed = notificationCommand.safeParse(event?.notification);
      const expectedType = event?.type === "provider.approved"
        ? "provider_approved"
        : event?.type === "booking.status_changed"
          ? "booking_status"
          : null;

      if (!expectedType || !parsed.success || parsed.data.type !== expectedType) {
        console.warn("Invalid notification event");
        channel.reject(message, false);
        return;
      }

      try {
        const row = await insertNotification(pool, parsed.data);
        if (channelOpen) channel.ack(message);
        console.log("Notification processed:", parsed.data.source_event_id, {
          eventType: event.type,
          duplicate: row === null,
        });
      } catch (err) {
        console.error("Notification write failed:", err.message);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (channelOpen) channel.nack(message, false, true);
      }
    }, { noAck: false });

    console.log(`Listening on RabbitMQ queue ${queue}`);
    return connection;
  } catch (err) {
    await connection.close().catch(() => {});
    throw err;
  }
}

module.exports = { startNotificationConsumer };