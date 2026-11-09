export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parseId } from "#lib/http/validate.js";
import * as providers from "#lib/modules/providers/service.js";

export const POST = handle(async (req, { params }) => {
  getAuth(req, "admin");
  return json(providers.approveProvider(parseId(params.id, "provider id")));
});
