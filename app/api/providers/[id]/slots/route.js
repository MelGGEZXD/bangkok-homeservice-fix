export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { parse, parseId } from "#lib/http/validate.js";
import * as slots from "#lib/modules/booking/availability.js";

const querySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  duration: z.coerce.number().int().positive(),
});

export const GET = handle(async (req, { params }) => {
  const sp = new URL(req.url).searchParams;
  const { date, duration } = parse(querySchema, { date: sp.get("date"), duration: sp.get("duration") });
  const providerId = parseId(params.id, "provider id");
  return json(slots.availableSlots(providerId, date, duration));
});
