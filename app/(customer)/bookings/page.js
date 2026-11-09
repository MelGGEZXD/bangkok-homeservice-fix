export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getSession } from "#lib/http/session.js";
import * as booking from "#lib/modules/booking/service.js";
import { money, Badge } from "../../_ui/format.js";
import { Form } from "../../_ui/client.js";

export default function BookingsPage() {
  const session = getSession();
  if (!session || session.role !== "customer") redirect("/login");

  const { items } = booking.listBookings({ sub: session.sub, role: "customer" }, { page: 1, size: 100 });
  const addresses = booking.listAddresses(session.sub);

  return (
    <div>
      <h1>My bookings</h1>
      {items.length === 0 ? (
        <p className="muted">No bookings yet — <a href="/">browse services</a>.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Date</th><th>Time</th><th>Total</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {items.map((o) => (
                <tr key={o.id}>
                  <td>{o.id}</td>
                  <td>{o.service_date}</td>
                  <td>{o.starting_time}–{o.ending_time}</td>
                  <td>{money(o.total_cents)}</td>
                  <td><Badge status={o.status} /></td>
                  <td><a href={`/bookings/${o.id}`}>View</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Saved addresses</h2>
      <ul className="plain">
        {addresses.map((a) => (
          <li key={a.id}>{a.label} — {a.line1}, {a.city}{a.is_default ? " (default)" : ""}</li>
        ))}
      </ul>
      <h3>Add an address</h3>
      <Form
        endpoint="/api/customer/addresses"
        redirectTo="/bookings"
        submitLabel="Add address"
        fields={[
          { name: "label", label: "Label (e.g. Home)" },
          { name: "line1", label: "Address line" },
          { name: "city", label: "City" },
        ]}
      />
    </div>
  );
}
