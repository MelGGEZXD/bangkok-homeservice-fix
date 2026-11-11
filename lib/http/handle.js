// The single wrapper every route handler is built with. It derives a request id, starts the Area E
// server span, runs the handler inside that trace context (so outbound calls inherit it), records
// request metrics, and stamps X-Request-Id / traceparent / x-trace-id on the response. Any thrown
// error still funnels through toResponse, so status + body + logging stay uniform.
import { requestId } from "./requestId.js";
import { toResponse } from "./respond.js";
import { getTracer, extractTraceparent, traceparentOf, context, trace, SpanKind, SpanStatusCode } from "../telemetry.js";
import { observeHttp, routeLabel } from "../metrics.js";

export function handle(fn) {
  return async (req, ctx = {}) => {
    const id = requestId(req);
    const method = req.method || "GET";
    const path = new URL(req.url).pathname;
    const route = routeLabel(path);
    const parent = extractTraceparent(req.headers);
    const span = getTracer("edemand").startSpan(
      `${method} ${route}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": method,
          "http.route": route,
          "url.path": path,
          "service.name": "edemand",
        },
      },
      parent
    );
    const started = performance.now();
    let status = 500;

    try {
      const res = await context.with(trace.setSpan(context.active(), span), () => fn(req, ctx, id));
      status = res?.status ?? 200;
      if (res && res.headers) {
        if (!res.headers.get("X-Request-Id")) res.headers.set("X-Request-Id", id);
        const traceparent = traceparentOf(span);
        if (traceparent) res.headers.set("traceparent", traceparent);
        res.headers.set("x-trace-id", span.spanContext().traceId);
      }
      span.setStatus({ code: SpanStatusCode.OK });
      return res;
    } catch (err) {
      status = err.statusCode ?? 500;
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      const res = toResponse(err, id);
      const traceparent = traceparentOf(span);
      if (traceparent) res.headers.set("traceparent", traceparent);
      res.headers.set("x-trace-id", span.spanContext().traceId);
      return res;
    } finally {
      observeHttp({
        method,
        route,
        status,
        durationSeconds: (performance.now() - started) / 1000,
      });
      span.end();
    }
  };
}
