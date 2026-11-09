export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parse, parseId, readJson } from "#lib/http/validate.js";
import * as catalog from "#lib/modules/catalog/service.js";

const patchSchema = z.object({
  category_id: z.coerce.number().int().positive().optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  price_cents: z.coerce.number().int().min(0).optional(),
  duration_min: z.coerce.number().int().positive().optional(),
  tax_percent: z.coerce.number().min(0).optional(),
  status: z.coerce.number().int().min(0).max(1).optional(),
});

export const PATCH = handle(async (req, { params }) => {
  const auth = getAuth(req, "provider");
  const input = parse(patchSchema, await readJson(req));
  return json(catalog.updateOwnService(auth.sub, parseId(params.id, "service id"), input));
});
