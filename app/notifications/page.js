export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "#lib/http/session.js";
import * as notifications from "#lib/modules/notifications/client.js";
import { ActionButton } from "../_ui/client.js";

// Same page address (/notifications), different owner: the rows come from the extracted
// notifications service over HTTP. The browser's httpOnly JWT is forwarded so the service can
// authenticate the user and apply its own ownership check.
export default async function NotificationsPage() {
  const session = getSession();
  if (!session) redirect("/login");

  const token = cookies().get("edemand_token")?.value;
  let list = [];
  let unavailable = false;
  try {
    list = await notifications.listForUser(token);
  } catch {
    unavailable = true;
  }

  return (
    <div>
      <h1>Notifications</h1>
      {unavailable ? (
        <p className="muted">Notifications are temporarily unavailable. Please try again shortly.</p>
      ) : list.length === 0 ? (
        <p className="muted">Nothing here yet.</p>
      ) : (
        <ul className="plain">
          {list.map((n) => (
            <li key={n.id} style={{ opacity: n.read_at ? 0.55 : 1 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <strong>{n.title}</strong> <span className="muted small">· {n.type}</span>
                  <div className="small">{n.body}</div>
                </div>
                {!n.read_at ? <ActionButton url={`/api/notifications/${n.id}/read`} label="Mark read" className="secondary" /> : <span className="muted small">read</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
