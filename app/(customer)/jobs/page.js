export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getSession } from "#lib/http/session.js";
import * as bidding from "#lib/modules/bidding/service.js";
import { money, Badge } from "../../_ui/format.js";

export default function JobsPage() {
  const session = getSession();
  if (!session || session.role !== "customer") redirect("/login");

  const jobs = bidding.listJobs({ sub: session.sub, role: "customer" });

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>My custom jobs</h1>
        <a className="btn" href="/jobs/new">Post a job</a>
      </div>
      {jobs.length === 0 ? (
        <p className="muted">No jobs yet — post one to collect bids from providers.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Title</th><th>Budget</th><th>Window</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>{j.id}</td>
                  <td>{j.title}</td>
                  <td>{money(j.min_price_cents)}–{money(j.max_price_cents)}</td>
                  <td className="small">{j.window_start}</td>
                  <td><Badge status={j.status} /></td>
                  <td><a href={`/jobs/${j.id}`}>View</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
