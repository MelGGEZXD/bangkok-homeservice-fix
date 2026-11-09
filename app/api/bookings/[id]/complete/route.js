export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parse, parseId, readJson } from "#lib/http/validate.js";
import * as booking from "#lib/modules/booking/service.js";

// OTP is required and must be the 6-digit code the customer holds.
const schema = z.object({ otp: z.coerce.number().int() });

export const POST = handle(async (req, { params }) => {
  const auth = getAuth(req, "provider");
  const { otp } = parse(schema, await readJson(req));
  return json(booking.completeBooking(parseId(params.id, "booking id"), auth.sub, otp));
});
