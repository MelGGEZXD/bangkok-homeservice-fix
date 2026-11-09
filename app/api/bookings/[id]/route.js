export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parseId } from "#lib/http/validate.js";
import * as booking from "#lib/modules/booking/service.js";

export const GET = handle(async (req, { params }) => {
  const auth = getAuth(req, ["customer", "provider"]);
  return json(booking.getBooking(parseId(params.id, "booking id"), auth));
});
