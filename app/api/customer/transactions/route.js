export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth, getToken } from "#lib/http/auth.js";
import * as payments from "#lib/modules/payments/client.js";

// Area A: the ledger moved to the payments service; the caller's token crosses the seam with it.
export const GET = handle(async (req) => {
  getAuth(req, "customer");
  return json(await payments.listCustomerTransactions(getToken(req), req.headers.get("x-request-id") || undefined));
});
