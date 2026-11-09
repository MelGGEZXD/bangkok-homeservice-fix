export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { parseId } from "#lib/http/validate.js";
import * as providers from "#lib/modules/providers/service.js";

export const GET = handle(async (_req, { params }) => {
  return json(providers.getPublicProvider(parseId(params.id, "provider id")));
});
