// Prometheus scrape endpoint for the monolith (Area E). nginx refuses /metrics at the public edge;
// Prometheus reaches edemand:3000/metrics over the compose network.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { metricsText, metricsContentType } from "#lib/metrics.js";

export async function GET() {
  return new Response(await metricsText(), {
    status: 200,
    headers: { "content-type": metricsContentType() },
  });
}
