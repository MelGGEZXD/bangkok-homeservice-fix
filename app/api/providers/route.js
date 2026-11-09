export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import * as providers from "#lib/modules/providers/service.js";

export const GET = handle(async () => json(providers.listProviders()));
