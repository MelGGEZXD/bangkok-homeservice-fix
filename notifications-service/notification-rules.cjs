// Event -> notification projection, owned by the Notifications service.
//
// Area C moved this rule here from the monolith's relay. The published message is the raw domain
// event (`{event_uid, type, aggregate_type, aggregate_id, payload, occurred_at}`), so the producer
// no longer knows how a notification is worded. Adding a recipient or changing copy is a deploy of
// this service only.
//
// `source_event_id` is the outbox event UUID. It is half of the service's unique key, which is what
// makes a duplicate RabbitMQ delivery (or a relay retry) produce exactly one notification row.
//
// Pure and synchronous so the node:test helpers can share the exact same projection as production.
function command(envelope, recipientRole, recipientId, type, title, body, orderId = null) {
  return {
    source_event_id: envelope.event_uid,
    recipient_role: recipientRole,
    recipient_id: Number(recipientId),
    type,
    title,
    body,
    order_id: orderId == null ? null : Number(orderId),
  };
}

function project(event) {
  const p = event.payload || {};
  const out = [];

  switch (event.type) {
    case "review.created":
      out.push(
        command(
          event,
          "provider",
          p.provider_id,
          "new_review",
          "New review",
          `You received a ${p.rating}-star review on booking #${p.order_id}.`,
          p.order_id
        )
      );
      break;

    case "provider.approved":
      out.push(
        command(
          event,
          "provider",
          p.provider_id,
          "provider_approved",
          "You're approved",
          "Your provider account has been approved. Your services are now visible to customers."
        )
      );
      break;

    // The saga's compensating action. The provider is told the approval was rolled back rather than
    // silently disappearing from the directory.
    case "provider.approval_reverted":
      out.push(
        command(
          event,
          "provider",
          p.provider_id,
          "provider_approval_reverted",
          "Approval reverted",
          `Your approval could not be completed (${p.reason || "notification delivery failed"}). Please contact support.`
        )
      );
      break;

    case "booking.status_changed": {
      // Notify the counterparty of whoever drove the transition.
      const toCustomer = p.actor_role === "provider";
      out.push(
        command(
          event,
          toCustomer ? "customer" : "provider",
          toCustomer ? p.customer_id : p.provider_id,
          "booking_status",
          `Booking ${p.to}`,
          `Booking #${p.order_id} is now ${p.to}.`,
          p.order_id
        )
      );
      break;
    }

    case "booking.completed":
      out.push(
        command(
          event,
          "customer",
          p.customer_id,
          "rating_request",
          "How did it go?",
          `Booking #${p.order_id} is complete — leave a review for your provider.`,
          p.order_id
        )
      );
      break;

    case "bid.accepted":
      out.push(
        command(
          event,
          "provider",
          p.winner_provider_id,
          "bid_accepted",
          "Your bid was accepted",
          `Your bid on job #${p.job_request_id} was accepted — booking #${p.order_id} created.`,
          p.order_id
        )
      );
      for (const loserId of p.loser_provider_ids || []) {
        out.push(
          command(
            event,
            "provider",
            loserId,
            "bid_rejected",
            "Bid not selected",
            `Your bid on job #${p.job_request_id} was not selected.`
          )
        );
      }
      break;

    case "payment.succeeded":
      if (p.provider_id != null) {
        out.push(
          command(
            event,
            "provider",
            p.provider_id,
            "payment_received",
            "Payment received",
            `Payment of ${p.amount_cents} cents was received for booking #${p.order_id}.`,
            p.order_id
          )
        );
      }
      break;

    default:
      // Saga outcome events and future event types are not notification sources.
      break;
  }

  return out;
}

module.exports = { project };
