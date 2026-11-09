export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import * as identity from "#lib/modules/identity/service.js";

export const GET = handle(async (req) => {
  const auth = getAuth(req);
  return json(identity.getMe(auth));
});
