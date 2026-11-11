// Prometheus metrics for the extracted Payments & Wallet service (Area E). The same metric names
// and labels as the monolith, so one Grafana panel can select `service` and compare all three.
const client = require("prom-client");

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: "payments_" });

const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "HTTP requests handled, by service, method, normalised route and status.",
  labelNames: ["service", "method", "route", "status"],
  registers: [registry],
});

const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds, by service, method, normalised route and status.",
  labelNames: ["service", "method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

function routeLabel(path) {
  return String(path || "/")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\/\d+(?=\/|$)/g, "/:id");
}

function metricsMiddleware(serviceName) {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const labels = {
        service: serviceName,
        method: req.method,
        route: routeLabel(req.path),
        status: String(res.statusCode),
      };
      httpRequestsTotal.inc(labels);
      httpRequestDuration.observe(labels, seconds);
    });
    next();
  };
}

module.exports = { registry, metricsMiddleware, routeLabel };
