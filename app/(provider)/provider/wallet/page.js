export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getSession } from "#lib/http/session.js";
import * as payments from "#lib/modules/payments/service.js";
import { money } from "../../../_ui/format.js";

export default function WalletPage() {
  const session = getSession();
  if (!session || session.role !== "provider") redirect("/provider/login");
  const wallet = payments.getWallet(session.sub);

  return (
    <div>
      <h1>Wallet</h1>
      <div className="grid">
        <div className="card"><h3>Balance</h3><div className="price" style={{ fontSize: 24 }}>{money(wallet.balance_cents)}</div><div className="muted small">gateway earnings payable to you</div></div>
        <div className="card"><h3>Commission owed</h3><div className="price" style={{ fontSize: 24 }}>{money(wallet.commission_owed_cents)}</div><div className="muted small">COD commission you owe the platform</div></div>
      </div>

      <h2>Transactions</h2>
      {wallet.transactions.length === 0 ? <p className="muted">No transactions yet.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Booking</th><th>Kind</th><th>Amount</th><th>Method</th><th>When</th></tr></thead>
            <tbody>
              {wallet.transactions.map((tx) => (
                <tr key={tx.id}>
                  <td>{tx.id}</td><td>{tx.order_id ?? "—"}</td><td>{tx.kind}</td>
                  <td>{money(tx.amount_cents)}</td><td>{tx.method}</td><td className="small">{tx.created_at.slice(0, 16).replace("T", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
