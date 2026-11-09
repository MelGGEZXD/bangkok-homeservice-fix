export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parse, parseId, readJson } from "#lib/http/validate.js";
import * as providers from "#lib/modules/providers/service.js";

const schema = z.object({ commission_pct: z.coerce.number().min(0).max(100) });

export const PATCH = handle(async (req, { params }) => {
  getAuth(req, "admin");
  const { commission_pct } = parse(schema, await readJson(req));
  return json(providers.setCommission(parseId(params.id, "provider id"), commission_pct));
});
