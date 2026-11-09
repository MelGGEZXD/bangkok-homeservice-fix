export const dynamic = "force-dynamic";

import { Form } from "../../_ui/client.js";

export default function RegisterPage() {
  return (
    <div style={{ maxWidth: 420 }}>
      <h1>Create a customer account</h1>
      <Form
        endpoint="/api/auth/customer/register"
        redirectTo="/login"
        submitLabel="Sign up"
        fields={[
          { name: "name", label: "Name" },
          { name: "email", label: "Email", type: "email" },
          { name: "password", label: "Password (min 8)", type: "password" },
          { name: "phone", label: "Phone (optional)", optional: true },
        ]}
      />
      <p className="small muted" style={{ marginTop: 12 }}>Already have an account? <a href="/login">Log in</a>.</p>
    </div>
  );
}
