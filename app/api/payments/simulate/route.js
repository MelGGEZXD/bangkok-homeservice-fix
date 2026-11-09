export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parse, readJson } from "#lib/http/validate.js";
import { simulateSucceeded } from "#lib/modules/payments/gateway.js";

// The mock gateway's "Pay now" for the UI: mints a gateway event id and drives it through the same
// idempotent webhook path (§3.3), so a double click replays a duplicate event id and credits once.
const schema = z.object({ order_id: z.coerce.number().int().positive() });

export const POST = handle(async (req) => {
  const auth = getAuth(req, "customer");
  const { order_id } = parse(schema, await readJson(req));
  return json(simulateSucceeded(order_id, auth.sub));
});
