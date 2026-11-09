"use client";
// Every mutation in the UI goes through a route handler via fetch — the honest client/server split
// for a monolith. The httpOnly edemand_token cookie rides along automatically on same-origin
// requests, so these components never handle the JWT themselves.
import { useState } from "react";

async function postJSON(url, body, method = "POST") {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  return { ok: res.ok, status: res.status, data };
}

function errText(data) {
  if (!data) return "Request failed";
  if (Array.isArray(data.details) && data.details.length) {
    return `${data.error}: ${data.details.map((d) => `${d.path} ${d.message}`).join("; ")}`;
  }
  return data.error || "Request failed";
}

export function LogoutButton() {
  return (
    <button
      className="secondary"
      onClick={async () => {
        await postJSON("/api/auth/logout");
        window.location.href = "/";
      }}
    >
      Log out
    </button>
  );
}

// Generic POST button for state actions (confirm/start/cancel/accept/withdraw/approve/read/pay).
export function ActionButton({ url, body, method = "POST", label, redirectTo, className = "", confirm: confirmMsg }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  return (
    <span>
      <button
        className={className}
        disabled={busy}
        onClick={async () => {
          if (confirmMsg && !window.confirm(confirmMsg)) return;
          setBusy(true);
          setErr(null);
          const r = await postJSON(url, body, method);
          setBusy(false);
          if (r.ok) {
            if (redirectTo) window.location.href = redirectTo;
            else window.location.reload();
          } else {
            setErr(errText(r.data));
          }
        }}
      >
        {busy ? "…" : label}
      </button>
      {err ? <div className="err">{err}</div> : null}
    </span>
  );
}

// Generic form driven by a field spec. Used for auth + simple entity creation.
export function Form({ endpoint, method = "POST", fields, submitLabel, redirectTo, coerceNumber = [] }) {
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((f) => [f.name, f.default ?? ""])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  return (
    <form
      className="panel"
      style={{ maxWidth: 420 }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        const body = {};
        for (const f of fields) {
          let v = values[f.name];
          if (v === "" && f.optional) continue;
          if (coerceNumber.includes(f.name)) v = Number(v);
          body[f.name] = v;
        }
        const r = await postJSON(endpoint, body, method);
        setBusy(false);
        if (r.ok) window.location.href = redirectTo || "/";
        else setErr(errText(r.data));
      }}
    >
      {fields.map((f) => (
        <div className="field" key={f.name}>
          <label>{f.label}</label>
          {f.type === "select" ? (
            <select value={values[f.name]} onChange={(e) => setValues((s) => ({ ...s, [f.name]: e.target.value }))}>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ) : f.type === "textarea" ? (
            <textarea rows={3} value={values[f.name]} onChange={(e) => setValues((s) => ({ ...s, [f.name]: e.target.value }))} />
          ) : (
            <input
              type={f.type || "text"}
              value={values[f.name]}
              onChange={(e) => setValues((s) => ({ ...s, [f.name]: e.target.value }))}
            />
          )}
        </div>
      ))}
      {err ? <div className="err" style={{ marginBottom: 8 }}>{err}</div> : null}
      <button disabled={busy}>{busy ? "…" : submitLabel}</button>
    </form>
  );
}

// The booking form: address, live slot picker, quantity, payment method. On success it reveals the
// OTP and (for gateway) a "Pay now (simulate)" button that drives the mock gateway -> webhook.
export function BookingForm({ serviceId, providerId, duration, addresses }) {
  const [addressId, setAddressId] = useState(addresses[0]?.id ? String(addresses[0].id) : "");
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState([]);
  const [slot, setSlot] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [payment, setPayment] = useState("cod");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);
  const [paid, setPaid] = useState(false);

  async function loadSlots(d, qty) {
    setSlot("");
    if (!d) return setSlots([]);
    const res = await fetch(`/api/providers/${providerId}/slots?date=${d}&duration=${duration * qty}`);
    const data = await res.json();
    setSlots(res.ok ? data.slots : []);
  }

  if (result) {
    return (
      <div className="panel stack">
        <div className="notice">Booking <strong>#{result.order.id}</strong> placed — status <em>{result.order.status}</em>.</div>
        <div>
          <div className="small muted">Read this OTP to your provider at completion:</div>
          <div className="otp">{result.otp}</div>
        </div>
        {result.payment_intent && !paid ? (
          <button
            onClick={async () => {
              const r = await postJSON("/api/payments/simulate", { order_id: result.order.id });
              if (r.ok) setPaid(true);
              else setErr(errText(r.data));
            }}
          >
            Pay now (simulate)
          </button>
        ) : null}
        {paid ? <div className="notice">Payment received. Thank you.</div> : null}
        <a className="btn secondary" href={`/bookings/${result.order.id}`}>View booking</a>
      </div>
    );
  }

  return (
    <form
      className="panel"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        const body = {
          provider_id: providerId,
          address_id: addressId ? Number(addressId) : undefined,
          service_date: date,
          starting_time: slot,
          items: [{ service_id: serviceId, quantity: Number(quantity) }],
          payment_method: payment,
        };
        const r = await postJSON("/api/bookings", body);
        setBusy(false);
        if (r.ok) setResult(r.data);
        else setErr(errText(r.data));
      }}
    >
      <div className="field">
        <label>Address</label>
        {addresses.length ? (
          <select value={addressId} onChange={(e) => setAddressId(e.target.value)}>
            {addresses.map((a) => (
              <option key={a.id} value={a.id}>{a.label} — {a.line1}, {a.city}</option>
            ))}
          </select>
        ) : (
          <div className="small muted">No saved address — <a href="/bookings">add one first</a>.</div>
        )}
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label>Quantity</label>
          <input type="number" min="1" value={quantity} onChange={(e) => { setQuantity(e.target.value); loadSlots(date, Number(e.target.value) || 1); }} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Date</label>
          <input type="date" value={date} onChange={(e) => { setDate(e.target.value); loadSlots(e.target.value, Number(quantity) || 1); }} />
        </div>
      </div>
      <div className="field">
        <label>Available start times</label>
        {date ? (
          slots.length ? (
            <div className="row">
              {slots.map((s) => (
                <button type="button" key={s} className={s === slot ? "" : "secondary"} onClick={() => setSlot(s)}>{s}</button>
              ))}
            </div>
          ) : (
            <div className="small muted">No open slots for that date.</div>
          )
        ) : (
          <div className="small muted">Pick a date to see slots.</div>
        )}
      </div>
      <div className="field">
        <label>Payment</label>
        <select value={payment} onChange={(e) => setPayment(e.target.value)}>
          <option value="cod">Cash on delivery</option>
          <option value="gateway">Pay online (simulated)</option>
        </select>
      </div>
      {err ? <div className="err" style={{ marginBottom: 8 }}>{err}</div> : null}
      <button disabled={busy || !slot || !date}>{busy ? "…" : "Confirm booking"}</button>
    </form>
  );
}

// Provider completion: enter the 6-digit OTP the customer reads out.
export function CompleteForm({ orderId }) {
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  return (
    <form
      className="row"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        const r = await postJSON(`/api/bookings/${orderId}/complete`, { otp: Number(otp) });
        setBusy(false);
        if (r.ok) window.location.reload();
        else setErr(errText(r.data));
      }}
    >
      <input style={{ width: 140 }} placeholder="OTP" value={otp} onChange={(e) => setOtp(e.target.value)} />
      <button disabled={busy}>Complete</button>
      {err ? <div className="err">{err}</div> : null}
    </form>
  );
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Provider weekly availability editor -> PUT /api/provider/timings (upsert by weekday).
export function TimingsForm({ timings }) {
  const seed = WD.map((_, wd) => {
    const t = timings.find((x) => x.weekday === wd);
    return { weekday: wd, opening_time: t?.opening_time || "09:00", closing_time: t?.closing_time || "18:00", is_open: t ? Boolean(t.is_open) : wd !== 0 };
  });
  const [rows, setRows] = useState(seed);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const set = (wd, key, val) => setRows((rs) => rs.map((r) => (r.weekday === wd ? { ...r, [key]: val } : r)));

  return (
    <form
      className="panel"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setErr(null); setMsg(null);
        const r = await postJSON("/api/provider/timings", { timings: rows }, "PUT");
        setBusy(false);
        if (r.ok) setMsg("Saved.");
        else setErr(errText(r.data));
      }}
    >
      <div className="table-wrap">
        <table>
          <thead><tr><th>Day</th><th>Open</th><th>Close</th><th>Open?</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.weekday}>
                <td>{WD[r.weekday]}</td>
                <td><input style={{ width: 110 }} value={r.opening_time} onChange={(e) => set(r.weekday, "opening_time", e.target.value)} /></td>
                <td><input style={{ width: 110 }} value={r.closing_time} onChange={(e) => set(r.weekday, "closing_time", e.target.value)} /></td>
                <td><input type="checkbox" style={{ width: "auto" }} checked={r.is_open} onChange={(e) => set(r.weekday, "is_open", e.target.checked)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 12 }}>
        <button disabled={busy}>{busy ? "…" : "Save availability"}</button>
        {msg ? <span className="small" style={{ marginLeft: 10 }}>{msg}</span> : null}
        {err ? <div className="err">{err}</div> : null}
      </div>
    </form>
  );
}

export function ReviewForm({ orderId }) {
  const [rating, setRating] = useState("5");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        const r = await postJSON(`/api/bookings/${orderId}/review`, { rating: Number(rating), comment: comment || undefined });
        setBusy(false);
        if (r.ok) window.location.reload();
        else setErr(errText(r.data));
      }}
    >
      <div className="row">
        <select style={{ width: 120 }} value={rating} onChange={(e) => setRating(e.target.value)}>
          {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} ★</option>)}
        </select>
        <input placeholder="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
        <button disabled={busy}>Submit review</button>
      </div>
      {err ? <div className="err">{err}</div> : null}
    </form>
  );
}
