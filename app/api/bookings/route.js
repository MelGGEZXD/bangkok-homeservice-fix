export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parse, readJson } from "#lib/http/validate.js";
import { parsePagination, paginationHeaders } from "#lib/http/pagination.js";
import * as booking from "#lib/modules/booking/service.js";

const placeSchema = z.object({
  provider_id: z.coerce.number().int().positive(),
  address_id: z.coerce.number().int().positive().optional(),
  service_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "service_date must be YYYY-MM-DD"),
  starting_time: z.string().regex(/^\d{2}:\d{2}$/, "starting_time must be HH:MM"),
  items: z.array(
    z.object({
      service_id: z.coerce.number().int().positive(),
      quantity: z.coerce.number().int().positive().default(1),
    })
  ).min(1),
  payment_method: z.enum(["cod", "gateway"]),
});

function idempotencyKeyOf(req) {
  const h = req.headers.get("idempotency-key");
  return h && h.trim() ? h.trim() : null;
}

export const POST = handle(async (req) => {
  const auth = getAuth(req, "customer");
  const input = parse(placeSchema, await readJson(req));
  const { statusCode, body } = booking.placeBooking(auth.sub, input, idempotencyKeyOf(req));
  return json(body, { status: statusCode, headers: { Location: `/api/bookings/${body.order.id}` } });
});

export const GET = handle(async (req) => {
  const auth = getAuth(req, ["customer", "provider"]);
  const sp = new URL(req.url).searchParams;
  const { page, size } = parsePagination(sp);
  const { items, total } = booking.listBookings(auth, {
    status: sp.get("status") || undefined,
    page,
    size,
  });
  return json(items, { headers: paginationHeaders({ total, page }) });
});
