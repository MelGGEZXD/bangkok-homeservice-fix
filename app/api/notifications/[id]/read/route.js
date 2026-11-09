export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth, getToken } from "#lib/http/auth.js";
import { parseId } from "#lib/http/validate.js";
import * as notifications from "#lib/modules/notifications/client.js";

export const POST = handle(async (req, { params }, requestId) => {
  getAuth(req); // local 401 before crossing the boundary
  return json(
    await notifications.markRead(parseId(params.id, "notification id"), getToken(req), requestId)
  );
});
