// The single wrapper every route handler is built with. It derives a request id, runs the handler,
// stamps X-Request-Id on whatever response comes back, and funnels any thrown error through
// toResponse so status + body + logging stay uniform. This is the App Router analogue of Ride's
// requestId + errorHandler middleware pair.
import { requestId } from "./requestId.js";
import { toResponse } from "./respond.js";

export function handle(fn) {
  return async (req, ctx = {}) => {
    const id = requestId(req);
    try {
      const res = await fn(req, ctx, id);
      if (res && res.headers && !res.headers.get("X-Request-Id")) {
        res.headers.set("X-Request-Id", id);
      }
      return res;
    } catch (err) {
      return toResponse(err, id);
    }
  };
}
