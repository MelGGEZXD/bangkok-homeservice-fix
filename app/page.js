export const dynamic = "force-dynamic";

import * as catalog from "#lib/modules/catalog/service.js";
import { money } from "./_ui/format.js";

export default function Home() {
  const categories = catalog.listCategories();
  const featured = catalog.topRated(6);

  return (
    <div>
      <h1>Book a trusted home service</h1>
      <p className="muted">Cleaning, repair, beauty and appliance pros — booked to a 30-minute slot.</p>

      <h2>Categories</h2>
      <div className="grid">
        {categories.map((c) => (
          <a className="card" key={c.id} href={`/categories/${c.slug}`}>
            <h3>{c.name}</h3>
            <span className="muted small">Browse {c.name.toLowerCase()} services →</span>
          </a>
        ))}
      </div>

      <h2>Top-rated services</h2>
      {featured.length === 0 ? (
        <p className="muted">No services yet.</p>
      ) : (
        <div className="grid">
          {featured.map((s) => (
            <a className="card" key={s.id} href={`/services/${s.id}`}>
              <h3>{s.title}</h3>
              <div className="muted small">{s.provider_name} · {s.category_name}</div>
              <div className="row" style={{ marginTop: 8, justifyContent: "space-between" }}>
                <span className="price">{money(s.price_cents)}</span>
                <span className="muted small">{s.duration_min} min · ★ {s.rating_avg?.toFixed(1) ?? "0.0"}</span>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
