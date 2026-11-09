export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getSession } from "#lib/http/session.js";
import * as providers from "#lib/modules/providers/service.js";
import { ActionButton, Form } from "../../../_ui/client.js";

export default function AdminProvidersPage() {
  const session = getSession();
  if (!session || session.role !== "admin") redirect("/admin/login");
  const list = providers.listAllForAdmin();

  return (
    <div>
      <h1>Providers</h1>
      <div className="table-wrap">
        <table>
          <thead><tr><th>#</th><th>Name</th><th>Email</th><th>Approved</th><th>Commission</th><th>Actions</th></tr></thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id}>
                <td>{p.id}</td>
                <td>{p.company_name || p.name}</td>
                <td className="small">{p.email}</td>
                <td>{p.is_approved ? "yes" : <span className="badge awaiting">pending</span>}</td>
                <td>{p.commission_pct}%</td>
                <td>
                  <div className="row">
                    {!p.is_approved ? <ActionButton url={`/api/admin/providers/${p.id}/approve`} label="Approve" /> : null}
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <Form
                      endpoint={`/api/admin/providers/${p.id}/commission`}
                      method="PATCH"
                      submitLabel="Set %"
                      redirectTo="/admin/providers"
                      coerceNumber={["commission_pct"]}
                      fields={[{ name: "commission_pct", label: "Commission %", type: "number", default: String(p.commission_pct) }]}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
