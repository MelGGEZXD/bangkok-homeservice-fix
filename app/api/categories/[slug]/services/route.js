export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import * as catalog from "#lib/modules/catalog/service.js";

export const GET = handle(async (_req, { params }) => {
  return json(catalog.servicesInCategory(params.slug));
});
