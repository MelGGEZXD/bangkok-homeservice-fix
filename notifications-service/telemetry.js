// OpenTelemetry for the extracted Notifications service (Area E).
//
// The HTTP side continues whatever traceparent reaches the gateway. The asynchronous side is the
// interesting one: the consumer extracts the traceparent that the relay put on the RabbitMQ message,
// starts a CONSUMER span as its child, and publishes its outcome with the current span's
// traceparent so the monolith's saga consumer stays in the same trace.
//
// Tracing is off unless OTEL_EXPORTER_OTLP_ENDPOINT is set, so a bare `npm test` stays quiet.
const { context, trace, SpanKind, SpanStatusCode } = require("@opentelemetry/api");
const { AsyncLocalStorageContextManager } = require("@opentelemetry/context-async-hooks");
const { NodeTracerProvider, BatchSpanProcessor } = require("@opentelemetry/sdk-trace-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { Resource } = require("@opentelemetry/resources");
const { ATTR_SERVICE_NAME } = require("@opentelemetry/semantic-conventions");

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const INVALID_TRACE = "00000000000000000000000000000000";

let started = false;

function startTelemetry(serviceName) {
  if (started) return;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;

  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  const exporter = new OTLPTraceExporter({
    url: `${endpoint.replace(/\/+$/, "")}/v1/traces`,
    timeoutMillis: 5000,
  });
  const provider = new NodeTracerProvider({
    resource: new Resource({ [ATTR_SERVICE_NAME]: serviceName }),
  });
  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  provider.register();
  started = true;
}

function getTracer(name) {
  return trace.getTracer(name);
}

function extractTraceparent(source) {
  const raw = source && (typeof source.get === "function" ? source.get("traceparent") : source.traceparent);
  if (!raw) return context.active();
  const match = TRACEPARENT_RE.exec(String(raw).trim().toLowerCase());
  if (!match) return context.active();
  const [, traceId, spanId, flags] = match;
  if (traceId === INVALID_TRACE) return context.active();
  return trace.setSpanContext(context.active(), {
    traceId,
    spanId,
    traceFlags: parseInt(flags, 16),
    isRemote: true,
  });
}

function traceparentOf(span) {
  if (!span) return null;
  const sc = span.spanContext();
  if (!sc || !sc.traceId || sc.traceId === INVALID_TRACE) return null;
  const flags = (sc.traceFlags ?? 1).toString(16).padStart(2, "0");
  return `00-${sc.traceId}-${sc.spanId}-${flags}`;
}

function traceparentFromActive() {
  return traceparentOf(trace.getSpan(context.active()));
}

function tracingMiddleware(serviceName) {
  return (req, res, next) => {
    const parent = extractTraceparent(req.headers);
    const span = getTracer(serviceName).startSpan(
      `${req.method} ${req.path}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": req.method,
          "url.path": req.path,
          "service.name": serviceName,
        },
      },
      parent
    );
    req.span = span;
    const traceparent = traceparentOf(span);
    if (traceparent) res.setHeader("traceparent", traceparent);
    // Same response header the monolith uses, so a demo can find the trace from any seam.
    res.setHeader("x-trace-id", span.spanContext().traceId);
    res.on("finish", () => {
      span.setAttribute("http.response.status_code", res.statusCode);
      span.setStatus({ code: res.statusCode >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      span.end();
    });
    context.with(trace.setSpan(context.active(), span), next);
  };
}

module.exports = {
  startTelemetry,
  getTracer,
  extractTraceparent,
  traceparentOf,
  traceparentFromActive,
  tracingMiddleware,
  context,
  trace,
  SpanKind,
  SpanStatusCode,
};
