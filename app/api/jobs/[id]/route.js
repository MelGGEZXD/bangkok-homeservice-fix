export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parseId } from "#lib/http/validate.js";
import * as bidding from "#lib/modules/bidding/service.js";

export const GET = handle(async (req, { params }) => {
  const auth = getAuth(req);
  return json(bidding.getJob(parseId(params.id, "job id"), auth));
});
