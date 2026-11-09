export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { parse, readJson } from "#lib/http/validate.js";
import * as identity from "#lib/modules/identity/service.js";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  phone: z.string().optional(),
});

export const POST = handle(async (req) => {
  const input = parse(schema, await readJson(req));
  const customer = await identity.registerCustomer(input);
  return json(
    { id: customer.id, email: customer.email, name: customer.name },
    { status: 201, headers: { Location: `/api/customers/${customer.id}` } }
  );
});
