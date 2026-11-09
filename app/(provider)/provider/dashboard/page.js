export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getSession } from "#lib/http/session.js";
import * as providers from "#lib/modules/providers/service.js";
import * as catalog from "#lib/modules/catalog/service.js";
import * as booking from "#lib/modules/booking/service.js";
import * as payments from "#lib/modules/payments/service.js";
import { money, Badge } from "../../../_ui/format.js";

export default function ProviderDashboard() {
  const session = getSession();
  if (!session || session.role !== "provider") redirect("/provider/login");

  const profile = providers.getOwnProfile(session.sub);
  const services = catalog.listOwnServices(session.sub);
  const wallet = payments.getWallet(session.sub);
  const { items } = booking.listBookings({ sub: session.sub, role: "provider" }, { page: 1, size: 100 });

  const byStatus = {};
  for (const o of items) byStatus[o.status] = (byStatus[o.status] || 0) + 1;

  return (
    <div>
      <h1>Dashboard</h1>
      {!profile.is_approved ? (
        <div className="notice warn">Your account is pending approval. Your services stay hidden until an admin approves you.</div>
      ) : null}

      <div className="grid" style={{ marginTop: 16 }}>
        <div className="card"><h3>Wallet balance</h3><div className="price" style={{ fontSize: 22 }}>{money(wallet.balance_cents)}</div><div className="muted small">payable to you (gateway earnings)</div></div>
        <div className="card"><h3>Commission owed</h3><div className="price" style={{ fontSize: 22 }}>{money(wallet.commission_owed_cents)}</div><div className="muted small">you owe the platform (COD)</div></div>
        <div className="card"><h3>Commission rate</h3><div className="price" style={{ fontSize: 22 }}>{profile.commission_pct}%</div></div>
        <div className="card"><h3>Rating</h3><div className="price" style={{ fontSize: 22 }}>★ {profile.rating_avg?.toFixed(1) ?? "0.0"}</div><div className="muted small">{profile.rating_count} reviews</div></div>
      </div>

      <h2>Bookings by status</h2>
      <div className="row">
        {Object.keys(byStatus).length === 0 ? <span className="muted">No bookings yet.</span> :
          Object.entries(byStatus).map(([s, n]) => <span key={s}><Badge status={s} /> {n}</span>)}
      </div>

      <h2>My services</h2>
      {services.length === 0 ? <p className="muted">No services — <a href="/provider/services">add one</a>.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Title</th><th>Price</th><th>Duration</th><th>Active</th></tr></thead>
            <tbody>
              {services.map((s) => (
                <tr key={s.id}><td>{s.title}</td><td>{money(s.price_cents)}</td><td>{s.duration_min} min</td><td>{s.status ? "yes" : "no"}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
