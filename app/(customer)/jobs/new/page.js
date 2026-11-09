export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getSession } from "#lib/http/session.js";
import * as catalog from "#lib/modules/catalog/service.js";
import { Form } from "../../../_ui/client.js";

export default function NewJobPage() {
  const session = getSession();
  if (!session || session.role !== "customer") redirect("/login");
  const categories = catalog.listCategories();

  return (
    <div style={{ maxWidth: 480 }}>
      <p className="small"><a href="/jobs">← My jobs</a></p>
      <h1>Post a custom job</h1>
      <p className="muted small">Providers bid a counter-price; you accept one and it becomes a booking.</p>
      <Form
        endpoint="/api/jobs"
        redirectTo="/jobs"
        submitLabel="Post job"
        coerceNumber={["category_id", "min_price_cents", "max_price_cents"]}
        fields={[
          { name: "category_id", label: "Category", type: "select", options: categories.map((c) => ({ value: c.id, label: c.name })) },
          { name: "title", label: "Title" },
          { name: "description", label: "Description", type: "textarea", optional: true },
          { name: "min_price_cents", label: "Min budget (cents)", type: "number", default: "30000" },
          { name: "max_price_cents", label: "Max budget (cents)", type: "number", default: "70000" },
          { name: "window_start", label: "Window start (YYYY-MM-DD HH:MM)" },
          { name: "window_end", label: "Window end (YYYY-MM-DD HH:MM)" },
        ]}
      />
    </div>
  );
}
