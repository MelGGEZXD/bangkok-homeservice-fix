export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parse, parseId, readJson } from "#lib/http/validate.js";
import * as bidding from "#lib/modules/bidding/service.js";

const schema = z.object({
  counter_price_cents: z.coerce.number().int().min(0),
  note: z.string().max(1000).optional(),
  duration_min: z.coerce.number().int().positive(),
});

export const POST = handle(async (req, { params }) => {
  const auth = getAuth(req, "provider");
  const input = parse(schema, await readJson(req));
  const bid = bidding.placeBid(parseId(params.id, "job id"), auth.sub, input);
  return json(bid, { status: 201 });
});
