export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getSession } from "#lib/http/session.js";
import * as providers from "#lib/modules/providers/service.js";
import { TimingsForm } from "../../../_ui/client.js";

export default function AvailabilityPage() {
  const session = getSession();
  if (!session || session.role !== "provider") redirect("/provider/login");
  const timings = providers.getTimings(session.sub);

  return (
    <div style={{ maxWidth: 560 }}>
      <h1>Weekly availability</h1>
      <p className="muted small">Bookings can only land inside your open hours, on a 30-minute grid.</p>
      <TimingsForm timings={timings} />
    </div>
  );
}
