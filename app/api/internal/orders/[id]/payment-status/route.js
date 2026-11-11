export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { parse, parseId, readJson } from "#lib/http/validate.js";
import { config } from "#lib/config.js";
import { UnauthorizedError } from "#lib/errors.js";
import * as booking from "#lib/modules/booking/service.js";

// Area A boundary, order side. The payments service owns the money rows, but the monolith owns
// orders, so after a settlement commits the payments service posts here. Internal-key only, and
// nginx refuses /api/internal from the public edge. The update is conditional, so a redelivered
// webhook or a retried call is a no-op instead of a second payment.succeeded event.
const schema = z.object({
  payment_status: z.enum(["paid", "refunded"]),
  gateway_ref: z.string().min(1).max(128).optional(),
});

export const POST = handle(async (req, { params }) => {
  const key = req.headers.get("x-internal-key");
  if (!key || key !== config.internalApiKey) {
    throw new UnauthorizedError("invalid internal key");
  }
  const input = parse(schema, await readJson(req));
  return json(
    booking.markOrderPaymentStatus(parseId(params.id, "order id"), {
      paymentStatus: input.payment_status,
      gatewayRef: input.gateway_ref,
    })
  );
});
