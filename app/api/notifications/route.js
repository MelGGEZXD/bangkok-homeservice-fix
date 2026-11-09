export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth, getToken } from "#lib/http/auth.js";
import * as notifications from "#lib/modules/notifications/client.js";

// Proxy, not owner. The notifications table lives in the extracted service; the monolith verifies
// the caller locally (consistent 401) and forwards the same JWT so the service can verify it too.
export const GET = handle(async (req, _ctx, requestId) => {
  getAuth(req); // local 401 before crossing the boundary
  return json(await notifications.listForUser(getToken(req), requestId));
});
