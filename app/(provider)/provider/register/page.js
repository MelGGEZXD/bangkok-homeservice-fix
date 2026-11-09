export const dynamic = "force-dynamic";

import { Form } from "../../../_ui/client.js";

export default function ProviderRegisterPage() {
  return (
    <div style={{ maxWidth: 420 }}>
      <h1>Register as a provider</h1>
      <p className="small muted">New providers start pending until an admin approves them.</p>
      <Form
        endpoint="/api/auth/provider/register"
        redirectTo="/provider/login"
        submitLabel="Register"
        fields={[
          { name: "name", label: "Your name" },
          { name: "company_name", label: "Company name", optional: true },
          { name: "email", label: "Email", type: "email" },
          { name: "password", label: "Password (min 8)", type: "password" },
          { name: "phone", label: "Phone (optional)", optional: true },
        ]}
      />
    </div>
  );
}
