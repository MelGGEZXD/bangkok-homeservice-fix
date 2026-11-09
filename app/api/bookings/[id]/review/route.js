export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parse, parseId, readJson } from "#lib/http/validate.js";
import * as reviews from "#lib/modules/reviews/service.js";

const schema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
});

export const POST = handle(async (req, { params }) => {
  const auth = getAuth(req, "customer");
  const input = parse(schema, await readJson(req));
  const review = reviews.createReview(parseId(params.id, "booking id"), auth.sub, input);
  return json(review, { status: 201 });
});
