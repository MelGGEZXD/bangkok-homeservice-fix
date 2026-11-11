// Prometheus metrics for the monolith (Area E).
//
// Every route handler goes through lib/http/handle.js, so instrumenting there gives request rate,
// error rate and latency for the whole monolith without touching individual routes. The route label
// is normalised (ids become :id) so a booking id does not create a new time series.
import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: "edemand_" });

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "HTTP requests handled, by service, method, normalised route and status.",
  labelNames: ["service", "method", "route", "status"],
  registers: [registry],
});

export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds, by service, method, normalised route and status.",
  labelNames: ["service", "method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// Ids are unbounded; collapsing them keeps the label set finite.
export function routeLabel(path) {
  return String(path || "/")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\/\d+(?=\/|$)/g, "/:id");
}

export function observeHttp({ service = "edemand", method, route, status, durationSeconds }) {
  const labels = { service, method, route, status: String(status) };
  httpRequestsTotal.inc(labels);
  httpRequestDuration.observe(labels, durationSeconds);
}

export function metricsContentType() {
  return registry.contentType;
}

export function metricsText() {
  return registry.metrics();
}
