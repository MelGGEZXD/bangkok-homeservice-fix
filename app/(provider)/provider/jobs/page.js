export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getSession } from "#lib/http/session.js";
import * as bidding from "#lib/modules/bidding/service.js";
import { money, Badge } from "../../../_ui/format.js";
import { Form, ActionButton } from "../../../_ui/client.js";

export default function ProviderJobsPage() {
  const session = getSession();
  if (!session || session.role !== "provider") redirect("/provider/login");

  const openJobs = bidding.listJobs({ sub: session.sub, role: "provider" });
  const myBids = bidding.listMyBids(session.sub);
  const bidJobIds = new Set(myBids.map((b) => b.job_request_id));

  return (
    <div>
      <h1>Open custom jobs</h1>
      {openJobs.length === 0 ? <p className="muted">No open jobs right now.</p> : (
        <div className="stack">
          {openJobs.map((j) => (
            <div className="panel" key={j.id}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div><strong>{j.title}</strong><div className="muted small">Budget {money(j.min_price_cents)}–{money(j.max_price_cents)} · {j.window_start}</div></div>
              </div>
              {bidJobIds.has(j.id) ? (
                <div className="small muted" style={{ marginTop: 8 }}>You have already bid on this job.</div>
              ) : (
                <div style={{ marginTop: 10 }}>
                  <Form
                    endpoint={`/api/jobs/${j.id}/bids`}
                    redirectTo="/provider/jobs"
                    submitLabel="Place bid"
                    coerceNumber={["counter_price_cents", "duration_min"]}
                    fields={[
                      { name: "counter_price_cents", label: "Your price (cents)", type: "number", default: String(j.min_price_cents) },
                      { name: "duration_min", label: "Duration (min, ×30)", type: "number", default: "60" },
                      { name: "note", label: "Note (optional)", optional: true },
                    ]}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <h2>My bids</h2>
      {myBids.length === 0 ? <p className="muted">No bids yet.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Job</th><th>Price</th><th>Duration</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {myBids.map((b) => (
                <tr key={b.id}>
                  <td>{b.job_title}</td>
                  <td>{money(b.counter_price_cents)}</td>
                  <td>{b.duration_min} min</td>
                  <td><Badge status={b.status} /></td>
                  <td>{b.status === "pending" ? <ActionButton url={`/api/jobs/${b.job_request_id}/bids/${b.id}/withdraw`} label="Withdraw" className="secondary" /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
