export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { parsePagination, paginationHeaders } from "#lib/http/pagination.js";
import * as catalog from "#lib/modules/catalog/service.js";

export const GET = handle(async (req) => {
  const sp = new URL(req.url).searchParams;
  const { page, size } = parsePagination(sp);
  const { items, total } = catalog.searchServices({
    category_id: sp.get("category_id") ? Number(sp.get("category_id")) : undefined,
    provider_id: sp.get("provider_id") ? Number(sp.get("provider_id")) : undefined,
    q: sp.get("q") || undefined,
    page,
    size,
  });
  return json(items, { headers: paginationHeaders({ total, page }) });
});
