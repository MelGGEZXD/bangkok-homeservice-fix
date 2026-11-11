export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parse, readJson } from "#lib/http/validate.js";
import * as bookingRepository from "#lib/modules/booking/repository.js";
import * as payments from "#lib/modules/payments/client.js";
import { NotFoundError, ForbiddenError } from "#lib/errors.js";

// The mock gateway's "Pay now" for the UI. Ownership is checked HERE because the monolith owns
// orders; the money side (intent + ledger + webhook dedupe) is handled by the payments service.
const schema = z.object({ order_id: z.coerce.number().int().positive() });

export const POST = handle(async (req) => {
  const auth = getAuth(req, "customer");
  const { order_id } = parse(schema, await readJson(req));

  const order = bookingRepository.findOrderById(order_id);
  if (!order) throw new NotFoundError(`booking ${order_id} not found`);
  if (order.customer_id !== auth.sub) throw new ForbiddenError("you are not the customer on this booking");

  return json(await payments.simulate(order_id, req.headers.get("x-request-id") || undefined));
});
