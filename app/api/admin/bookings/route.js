export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parsePagination, paginationHeaders } from "#lib/http/pagination.js";
import * as booking from "#lib/modules/booking/service.js";

export const GET = handle(async (req) => {
  getAuth(req, "admin");
  const sp = new URL(req.url).searchParams;
  const { page, size } = parsePagination(sp);
  const { items, total } = booking.listAllBookings({ status: sp.get("status") || undefined, page, size });
  return json(items, { headers: paginationHeaders({ total, page }) });
});
