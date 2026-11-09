// One pagination convention shared by every list endpoint: ?page & ?size on the query, X-Total-Count
// and X-Page on the response. Mirrors the Ride bar exactly.
import { z } from "zod";
import { parse } from "./validate.js";

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
});

export function parsePagination(searchParams) {
  return parse(paginationSchema, {
    page: searchParams.get("page") ?? undefined,
    size: searchParams.get("size") ?? undefined,
  });
}

export function paginationHeaders({ total, page }) {
  return { "X-Total-Count": String(total), "X-Page": String(page) };
}
