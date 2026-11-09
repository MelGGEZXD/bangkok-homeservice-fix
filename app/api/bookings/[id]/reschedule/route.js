export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parse, parseId, readJson } from "#lib/http/validate.js";
import * as booking from "#lib/modules/booking/service.js";

const schema = z.object({
  service_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "service_date must be YYYY-MM-DD"),
  starting_time: z.string().regex(/^\d{2}:\d{2}$/, "starting_time must be HH:MM"),
});

export const POST = handle(async (req, { params }) => {
  const auth = getAuth(req, ["customer", "provider"]);
  const input = parse(schema, await readJson(req));
  return json(booking.rescheduleBooking(parseId(params.id, "booking id"), auth, input));
});
