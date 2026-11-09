export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getSession } from "#lib/http/session.js";
import * as booking from "#lib/modules/booking/service.js";
import { money, Badge } from "../../../_ui/format.js";

export default function AdminBookingsPage() {
  const session = getSession();
  if (!session || session.role !== "admin") redirect("/admin/login");
  const { items, total } = booking.listAllBookings({ page: 1, size: 200 });

  return (
    <div>
      <h1>All bookings <span className="muted small">({total})</span></h1>
      {items.length === 0 ? <p className="muted">No bookings yet.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Customer</th><th>Provider</th><th>Date</th><th>Total</th><th>Pay</th><th>Status</th></tr></thead>
            <tbody>
              {items.map((o) => (
                <tr key={o.id}>
                  <td>{o.id}</td><td>#{o.customer_id}</td><td>#{o.provider_id}</td>
                  <td>{o.service_date} {o.starting_time}</td>
                  <td>{money(o.total_cents)}</td>
                  <td className="small">{o.payment_method}/{o.payment_status}</td>
                  <td><Badge status={o.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
