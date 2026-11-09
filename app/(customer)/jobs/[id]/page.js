export const dynamic = "force-dynamic";

import { redirect, notFound } from "next/navigation";
import { getSession } from "#lib/http/session.js";
import * as bidding from "#lib/modules/bidding/service.js";
import { money, Badge } from "../../../_ui/format.js";
import { ActionButton } from "../../../_ui/client.js";

export default function JobDetailPage({ params }) {
  const session = getSession();
  if (!session) redirect("/login");

  let data;
  try {
    data = bidding.getJob(Number(params.id), { sub: session.sub, role: session.role });
  } catch (e) {
    if (e.statusCode === 404) notFound();
    redirect("/");
  }
  const { job, bids } = data;
  const isOwner = session.role === "customer" && job.customer_id === session.sub;

  return (
    <div>
      <p className="small"><a href="/jobs">← My jobs</a></p>
      <h1>{job.title} <Badge status={job.status} /></h1>
      <p className="muted">Budget {money(job.min_price_cents)}–{money(job.max_price_cents)} · Window {job.window_start} → {job.window_end}</p>
      {job.description ? <p>{job.description}</p> : null}

      {isOwner && job.status === "open" ? (
        <ActionButton url={`/api/jobs/${job.id}/cancel`} label="Cancel job" className="danger" confirm="Cancel this job?" redirectTo="/jobs" />
      ) : null}

      <h2>Bids ({data.bid_count})</h2>
      {bids.length === 0 ? (
        <p className="muted">No bids yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Provider</th><th>Price</th><th>Duration</th><th>Note</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {bids.map((bd) => (
                <tr key={bd.id}>
                  <td>#{bd.provider_id}</td>
                  <td>{money(bd.counter_price_cents)}</td>
                  <td>{bd.duration_min} min</td>
                  <td className="small">{bd.note || "—"}</td>
                  <td><Badge status={bd.status} /></td>
                  <td>
                    {isOwner && job.status === "open" && bd.status === "pending" ? (
                      <ActionButton url={`/api/jobs/${job.id}/bids/${bd.id}/accept`} label="Accept" redirectTo="/bookings" />
                    ) : null}
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
