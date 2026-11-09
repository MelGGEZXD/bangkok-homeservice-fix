export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parse, readJson } from "#lib/http/validate.js";
import * as catalog from "#lib/modules/catalog/service.js";

const createSchema = z.object({
  category_id: z.coerce.number().int().positive(),
  title: z.string().min(1),
  description: z.string().optional(),
  price_cents: z.coerce.number().int().min(0),
  duration_min: z.coerce.number().int().positive(),
  tax_percent: z.coerce.number().min(0).optional(),
});

export const GET = handle(async (req) => {
  const auth = getAuth(req, "provider");
  return json(catalog.listOwnServices(auth.sub));
});

export const POST = handle(async (req) => {
  const auth = getAuth(req, "provider");
  const input = parse(createSchema, await readJson(req));
  const service = catalog.createService(auth.sub, input);
  return json(service, { status: 201, headers: { Location: `/api/services/${service.id}` } });
});
