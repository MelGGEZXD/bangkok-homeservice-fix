export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import * as sagas from "#lib/modules/sagas/service.js";

// Area C observability: the admin can follow the provider-approval saga from the same API surface
// that started it. `state` is awaiting_notification | completed | compensated | failed.
export const GET = handle(async (req, { params }) => {
  getAuth(req, "admin");
  return json(sagas.getSaga(params.id));
});
