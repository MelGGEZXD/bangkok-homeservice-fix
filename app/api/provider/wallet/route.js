export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth, getToken } from "#lib/http/auth.js";
import * as payments from "#lib/modules/payments/client.js";

// Area A: the wallet rows moved to the payments service. The monolith verifies the token locally,
// then forwards the same token so the service verifies it again and scopes the query to local_id.
export const GET = handle(async (req) => {
  getAuth(req, "provider");
  return json(await payments.getWallet(getToken(req), req.headers.get("x-request-id") || undefined));
});
