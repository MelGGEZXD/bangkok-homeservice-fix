export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parse, readJson } from "#lib/http/validate.js";
import * as providers from "#lib/modules/providers/service.js";

const patchSchema = z.object({
  company_name: z.string().optional(),
  about: z.string().optional(),
  service_radius_km: z.coerce.number().min(0).optional(),
  is_accepting_custom_jobs: z.coerce.boolean().optional(),
});

export const GET = handle(async (req) => {
  const auth = getAuth(req, "provider");
  return json(providers.getOwnProfile(auth.sub));
});

export const PATCH = handle(async (req) => {
  const auth = getAuth(req, "provider");
  const input = parse(patchSchema, await readJson(req));
  return json(providers.updateOwnProfile(auth.sub, input));
});
