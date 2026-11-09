export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parse, readJson } from "#lib/http/validate.js";
import * as bidding from "#lib/modules/bidding/service.js";

const postSchema = z.object({
  category_id: z.coerce.number().int().positive(),
  title: z.string().min(1),
  description: z.string().optional(),
  min_price_cents: z.coerce.number().int().min(0),
  max_price_cents: z.coerce.number().int().min(0),
  window_start: z.string().min(1),
  window_end: z.string().min(1),
});

export const POST = handle(async (req) => {
  const auth = getAuth(req, "customer");
  const input = parse(postSchema, await readJson(req));
  const job = bidding.postJob(auth.sub, input);
  return json(job, { status: 201, headers: { Location: `/api/jobs/${job.id}` } });
});

export const GET = handle(async (req) => {
  const auth = getAuth(req, ["customer", "provider"]);
  const sp = new URL(req.url).searchParams;
  const cat = sp.get("category_id");
  return json(bidding.listJobs(auth, { categoryIds: cat ? [Number(cat)] : undefined }));
});
