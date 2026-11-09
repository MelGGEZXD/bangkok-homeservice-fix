export const dynamic = "force-dynamic";

import { redirect, notFound } from "next/navigation";
import { getSession } from "#lib/http/session.js";
import * as booking from "#lib/modules/booking/service.js";
import { money, Badge } from "../../../_ui/format.js";
import { ActionButton, ReviewForm } from "../../../_ui/client.js";

export default function BookingDetailPage({ params }) {
  const session = getSession();
  if (!session) redirect("/login");

  let b;
  try {
    b = booking.getBooking(Number(params.id), { sub: session.sub, role: session.role });
  } catch (e) {
    if (e.statusCode === 404) notFound();
    redirect("/");
  }

  const canCancel = session.role === "customer" && ["awaiting", "confirmed"].includes(b.status);
  const canReview = session.role === "customer" && b.status === "completed";

  return (
    <div style={{ maxWidth: 640 }}>
      <p className="small"><a href="/bookings">← My bookings</a></p>
      <h1>Booking #{b.id} <Badge status={b.status} /></h1>
      <div className="panel stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="muted">Schedule</span>
          <span>{b.service_date} · {b.starting_time}–{b.ending_time}</span>
        </div>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="muted">Payment</span>
          <span>{b.payment_method} · {b.payment_status}</span>
        </div>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="muted">Total</span>
          <span className="price">{money(b.total_cents)} <span className="muted small">({money(b.subtotal_cents)} + {money(b.tax_cents)} tax)</span></span>
        </div>
      </div>

      {b.items && b.items.length ? (
        <>
          <h2>Items</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Service</th><th>Qty</th><th>Unit</th><th>Subtotal</th></tr></thead>
              <tbody>
                {b.items.map((it) => (
                  <tr key={it.id}>
                    <td>{it.service_title}</td><td>{it.quantity}</td>
                    <td>{money(it.unit_price_cents)}</td><td>{money(it.subtotal_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {session.role === "customer" && b.status !== "completed" && b.status !== "cancelled" ? (
        <div className="notice" style={{ marginTop: 16 }}>
          <div className="small muted">Read this OTP to your provider when the job is done:</div>
          <div className="otp">{b.otp}</div>
        </div>
      ) : null}

      <div className="row" style={{ marginTop: 16 }}>
        {canCancel ? (
          <ActionButton url={`/api/bookings/${b.id}/cancel`} label="Cancel booking" className="danger" confirm="Cancel this booking?" />
        ) : null}
      </div>

      {canReview ? (
        <>
          <h2>Write a review</h2>
          <ReviewForm orderId={b.id} />
        </>
      ) : null}
    </div>
  );
}
