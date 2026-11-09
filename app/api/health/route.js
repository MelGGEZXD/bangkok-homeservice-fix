export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";

// Liveness: never touches the database.
export const GET = handle(async () => json({ status: "ok" }));
