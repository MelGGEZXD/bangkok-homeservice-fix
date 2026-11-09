export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import * as catalog from "#lib/modules/catalog/service.js";
import { money } from "../../../_ui/format.js";

export default function CategoryPage({ params }) {
  let data;
  try {
    data = catalog.servicesInCategory(params.slug);
  } catch {
    notFound();
  }
  return (
    <div>
      <p className="small"><a href="/">← Browse</a></p>
      <h1>{data.category.name}</h1>
      {data.services.length === 0 ? (
        <p className="muted">No services in this category yet.</p>
      ) : (
        <div className="grid">
          {data.services.map((s) => (
            <a className="card" key={s.id} href={`/services/${s.id}`}>
              <h3>{s.title}</h3>
              <div className="muted small">{s.provider_name}</div>
              <div className="row" style={{ marginTop: 8, justifyContent: "space-between" }}>
                <span className="price">{money(s.price_cents)}</span>
                <span className="muted small">{s.duration_min} min</span>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
