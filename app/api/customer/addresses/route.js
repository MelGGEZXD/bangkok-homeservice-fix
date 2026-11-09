export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parse, readJson } from "#lib/http/validate.js";
import * as booking from "#lib/modules/booking/service.js";

const schema = z.object({
  label: z.string().min(1),
  line1: z.string().min(1),
  area: z.string().optional(),
  city: z.string().min(1),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
  is_default: z.coerce.boolean().optional(),
});

export const GET = handle(async (req) => {
  const auth = getAuth(req, "customer");
  return json(booking.listAddresses(auth.sub));
});

export const POST = handle(async (req) => {
  const auth = getAuth(req, "customer");
  const input = parse(schema, await readJson(req));
  return json(booking.addAddress(auth.sub, input), { status: 201 });
});
