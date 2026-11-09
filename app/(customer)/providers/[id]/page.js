export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import * as providers from "#lib/modules/providers/service.js";
import { money, WEEKDAYS } from "../../../_ui/format.js";

export default function ProviderPage({ params }) {
  let p;
  try {
    p = providers.getPublicProvider(Number(params.id));
  } catch {
    notFound();
  }
  return (
    <div>
      <p className="small"><a href="/providers">← Providers</a></p>
      <h1>{p.company_name || p.name}</h1>
      <p className="muted">★ {p.rating_avg?.toFixed(1) ?? "0.0"} ({p.rating_count}) · {p.about}</p>

      <h2>Services</h2>
      <div className="grid">
        {p.services.map((s) => (
          <a className="card" key={s.id} href={`/services/${s.id}`}>
            <h3>{s.title}</h3>
            <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
              <span className="price">{money(s.price_cents)}</span>
              <span className="muted small">{s.duration_min} min</span>
            </div>
          </a>
        ))}
      </div>

      <h2>Weekly hours</h2>
      <div className="table-wrap">
        <table>
          <tbody>
            {p.timings.map((t) => (
              <tr key={t.weekday}>
                <td>{WEEKDAYS[t.weekday]}</td>
                <td>{t.is_open ? `${t.opening_time} – ${t.closing_time}` : "Closed"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
