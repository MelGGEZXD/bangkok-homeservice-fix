// Invokes an App Router route handler in-process against a real web Request, the way Next would.
// This is the App Router analogue of Ride's supertest-against-app: no socket, no server, just the
// exported handler function called with (request, { params }).
export async function call(handler, opts = {}) {
  const { params = {}, query = {}, body, token, headers = {}, method, secret } = opts;

  const url = new URL("http://test.local/");
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const h = new Headers(headers);
  if (token) h.set("authorization", `Bearer ${token}`);
  if (secret) h.set("x-webhook-secret", secret);

  const m = method || (body !== undefined ? "POST" : "GET");
  const init = { method: m, headers: h };
  if (body !== undefined && m !== "GET" && m !== "HEAD") {
    if (typeof body === "string") {
      init.body = body;
      if (!h.has("content-type")) h.set("content-type", "application/json");
    } else {
      init.body = JSON.stringify(body);
      h.set("content-type", "application/json");
    }
  }

  const req = new Request(url, init);
  const res = await handler(req, { params });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, headers: res.headers, body: parsed };
}
