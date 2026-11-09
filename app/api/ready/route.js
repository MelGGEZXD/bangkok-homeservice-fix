export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getDb } from "#lib/db/index.js";

// Readiness: the database must answer SELECT 1, else 503.
export const GET = handle(async () => {
  try {
    getDb().prepare("SELECT 1").get();
    return json({ status: "ok" });
  } catch {
    return json({ status: "error", error: "database unavailable" }, { status: 503 });
  }
});
