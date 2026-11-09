export const dynamic = "force-dynamic";

import { Form } from "../../_ui/client.js";

export default function LoginPage() {
  return (
    <div style={{ maxWidth: 420 }}>
      <h1>Customer log in</h1>
      <Form
        endpoint="/api/auth/customer/login"
        redirectTo="/"
        submitLabel="Log in"
        fields={[
          { name: "email", label: "Email", type: "email" },
          { name: "password", label: "Password", type: "password" },
        ]}
      />
      <p className="small muted" style={{ marginTop: 12 }}>
        No account? <a href="/register">Sign up</a>. Seeded: nong@example.com / eDemand-2026!
      </p>
    </div>
  );
}
