export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parse, readJson } from "#lib/http/validate.js";
import { BadRequestError } from "#lib/errors.js";
import * as providers from "#lib/modules/providers/service.js";

const HHMM = z.string().regex(/^\d{2}:\d{2}$/, "must be HH:MM");
const putSchema = z.object({
  timings: z.array(
    z.object({
      weekday: z.coerce.number().int().min(0).max(6),
      opening_time: HHMM,
      closing_time: HHMM,
      is_open: z.coerce.boolean(),
    })
  ).min(1),
});

export const GET = handle(async (req) => {
  const auth = getAuth(req, "provider");
  return json(providers.getTimings(auth.sub));
});

export const PUT = handle(async (req) => {
  const auth = getAuth(req, "provider");
  const { timings } = parse(putSchema, await readJson(req));
  for (const t of timings) {
    if (t.closing_time <= t.opening_time) {
      throw new BadRequestError("validation failed", [
        { path: `timings.${t.weekday}`, message: "closing_time must be after opening_time" },
      ]);
    }
  }
  return json(providers.replaceTimings(auth.sub, timings));
});
