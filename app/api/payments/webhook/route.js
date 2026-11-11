export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { parse, readJson } from "#lib/http/validate.js";
import * as payments from "#lib/modules/payments/client.js";

const schema = z.object({
  gateway_event_id: z.string().min(1),
  type: z.string().min(1),
  gateway_ref: z.string().min(1),
});

// Area A: the webhook is now handled by the payments service, which owns webhook_events and the
// ledger. This monolith route remains for local dev / direct access; through the gateway nginx
// sends /api/payments/webhook straight to the service. The shared secret is forwarded, never
// replaced, so a bad secret is rejected by the owner of the data.
export const POST = handle(async (req) => {
  const secret = req.headers.get("x-webhook-secret");
  const input = parse(schema, await readJson(req));
  const result = await payments.sendWebhook(input, secret, req.headers.get("x-request-id") || undefined);
  return json({ received: true, ...result }, { status: 200 });
});
