export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import * as catalog from "#lib/modules/catalog/service.js";
import * as reviews from "#lib/modules/reviews/service.js";
import { getSession } from "#lib/http/session.js";
import { money } from "../../../_ui/format.js";

export default function ServicePage({ params }) {
  const id = Number(params.id);
  let service;
  try {
    service = catalog.getService(id);
  } catch {
    notFound();
  }
  const rev = reviews.listServiceReviews(id);
  const session = getSession();

  return (
    <div>
      <p className="small"><a href={`/providers/${service.provider_id}`}>← {service.provider_name}</a></p>
      <h1>{service.title}</h1>
      <div className="row" style={{ gap: 20 }}>
        <span className="price" style={{ fontSize: 22 }}>{money(service.price_cents)}</span>
        <span className="muted">{service.duration_min} min · {service.category_name}</span>
        <span className="muted">★ {rev.rating_avg?.toFixed(1) ?? "0.0"} ({rev.rating_count})</span>
      </div>
      {service.description ? <p>{service.description}</p> : null}

      {(!session || session.role === "customer") ? (
        <p><a className="btn" href={`/book/${service.id}`}>Book this service</a></p>
      ) : null}

      <h2>Reviews</h2>
      {rev.reviews.length === 0 ? (
        <p className="muted">No reviews yet.</p>
      ) : (
        <ul className="plain">
          {rev.reviews.map((r) => (
            <li key={r.id}>
              <strong>{"★".repeat(r.rating)}</strong>{r.comment ? ` — ${r.comment}` : ""}
              <span className="muted small"> · {r.created_at.slice(0, 10)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
