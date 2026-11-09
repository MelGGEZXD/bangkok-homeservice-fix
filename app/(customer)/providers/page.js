export const dynamic = "force-dynamic";

import * as providers from "#lib/modules/providers/service.js";

export default function ProvidersPage() {
  const list = providers.listProviders();
  return (
    <div>
      <h1>Providers</h1>
      {list.length === 0 ? (
        <p className="muted">No approved providers yet.</p>
      ) : (
        <div className="grid">
          {list.map((p) => (
            <a className="card" key={p.id} href={`/providers/${p.id}`}>
              <h3>{p.company_name || p.name}</h3>
              <div className="muted small">★ {p.rating_avg?.toFixed(1) ?? "0.0"} ({p.rating_count}) · {p.service_count} services</div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
