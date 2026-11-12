export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth, getToken } from "#lib/http/auth.js";
import * as payments from "#lib/modules/payments/service.js";

export const GET = handle(async (req) => {
  const auth = getAuth(req, "customer");
  return json(await payments.listCustomerTransactions(auth.sub, getToken(req)));
});
