export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getSession } from "#lib/http/session.js";
import * as booking from "#lib/modules/booking/service.js";
import { money, Badge } from "../../../_ui/format.js";
import { ActionButton, CompleteForm } from "../../../_ui/client.js";

export default function ProviderBookingsPage() {
  const session = getSession();
  if (!session || session.role !== "provider") redirect("/provider/login");

  const { items } = booking.listBookings({ sub: session.sub, role: "provider" }, { page: 1, size: 100 });

  return (
    <div>
      <h1>Incoming bookings</h1>
      {items.length === 0 ? <p className="muted">No bookings yet.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Date</th><th>Time</th><th>Total</th><th>Pay</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>
              {items.map((o) => (
                <tr key={o.id}>
                  <td>{o.id}</td>
                  <td>{o.service_date}</td>
                  <td>{o.starting_time}–{o.ending_time}</td>
                  <td>{money(o.total_cents)}</td>
                  <td className="small">{o.payment_method}/{o.payment_status}</td>
                  <td><Badge status={o.status} /></td>
                  <td>
                    {o.status === "awaiting" ? <ActionButton url={`/api/bookings/${o.id}/confirm`} label="Confirm" /> : null}
                    {o.status === "confirmed" || o.status === "rescheduled" ? <ActionButton url={`/api/bookings/${o.id}/start`} label="Start" /> : null}
                    {o.status === "started" ? <CompleteForm orderId={o.id} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
