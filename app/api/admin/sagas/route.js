export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import * as sagas from "#lib/modules/sagas/service.js";

// The admin saga list. Newest first; the demo uses this to show completion or compensation.
export const GET = handle(async (req) => {
  getAuth(req, "admin");
  return json(sagas.listSagas());
});
