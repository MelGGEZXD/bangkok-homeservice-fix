// OpenTelemetry wiring for the monolith (Area E).
//
// The important part is not the SDK: it is that one trace survives every seam. A request span is
// started in handle(); the payments client injects its `traceparent` into the outbound HTTP call;
// the payments service continues the same trace and injects it again on its way back. For the
// asynchronous seam, the outbox row stores the traceparent of the change that created it, the relay
// reparents the publish span to that context, and the notifications consumer extracts it from the
// message. Jaeger therefore shows the whole request, not two unrelated fragments.
//
// Tracing is enabled by setting OTEL_EXPORTER_OTLP_ENDPOINT (compose points it at jaeger:4318).
// Without it the API returns no-op spans, so node:test and a bare `npm run dev` stay quiet.
import { context, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const INVALID_TRACE = "00000000000000000000000000000000";

let started = false;

export function startTelemetry(serviceName) {
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

export function getTracer(name = "edemand") {
  return trace.getTracer(name);
}

// Turn an incoming W3C traceparent into a remote parent context. A malformed header is ignored
// rather than trusted; a forged trace id must not let a caller splice into someone else's trace.
export function extractTraceparent(headers) {
  const raw = typeof headers?.get === "function" ? headers.get("traceparent") : headers?.traceparent;
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

export function traceparentOf(span) {
  if (!span) return null;
  const sc = span.spanContext();
  if (!sc || !sc.traceId || sc.traceId === INVALID_TRACE) return null;
  const flags = (sc.traceFlags ?? 1).toString(16).padStart(2, "0");
  return `00-${sc.traceId}-${sc.spanId}-${flags}`;
}

export function traceparentFromActive() {
  return traceparentOf(trace.getSpan(context.active()));
}

export { context, trace, SpanKind, SpanStatusCode };
