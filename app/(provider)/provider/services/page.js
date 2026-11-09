export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getSession } from "#lib/http/session.js";
import * as catalog from "#lib/modules/catalog/service.js";
import { money } from "../../../_ui/format.js";
import { Form } from "../../../_ui/client.js";

export default function ProviderServicesPage() {
  const session = getSession();
  if (!session || session.role !== "provider") redirect("/provider/login");

  const services = catalog.listOwnServices(session.sub);
  const categories = catalog.listCategories();

  return (
    <div>
      <h1>My services</h1>
      {services.length === 0 ? <p className="muted">No services yet.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Title</th><th>Category</th><th>Price</th><th>Duration</th><th>Active</th></tr></thead>
            <tbody>
              {services.map((s) => (
                <tr key={s.id}>
                  <td>{s.title}</td><td>{s.category_name}</td><td>{money(s.price_cents)}</td>
                  <td>{s.duration_min} min</td><td>{s.status ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Add a service</h2>
      <p className="small muted">Duration must be a multiple of 30 minutes.</p>
      <Form
        endpoint="/api/provider/services"
        redirectTo="/provider/services"
        submitLabel="Add service"
        coerceNumber={["category_id", "price_cents", "duration_min"]}
        fields={[
          { name: "category_id", label: "Category", type: "select", options: categories.map((c) => ({ value: c.id, label: c.name })) },
          { name: "title", label: "Title" },
          { name: "description", label: "Description", type: "textarea", optional: true },
          { name: "price_cents", label: "Price (cents)", type: "number", default: "50000" },
          { name: "duration_min", label: "Duration (min, ×30)", type: "number", default: "60" },
        ]}
      />
    </div>
  );
}
