from typing import Literal
from uuid import UUID

from fastapi import Depends, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel, NonNegativeInt, PositiveInt

from auth import require_worker, user_id


def create_ledger_tables(db):
    db.execute("""
        CREATE TABLE IF NOT EXISTS transactions (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            operation_ref TEXT NOT NULL UNIQUE,
            order_id BIGINT, customer_id BIGINT, provider_id BIGINT,
            kind TEXT NOT NULL CHECK (kind IN ('charge','payout_credit','commission_owed','refund')),
            amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
            method TEXT NOT NULL CHECK (method IN ('gateway','cod')),
            gateway_ref TEXT, status TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS transactions_customer ON transactions(customer_id, id DESC);
        CREATE INDEX IF NOT EXISTS transactions_provider ON transactions(provider_id, id DESC);
        CREATE TABLE IF NOT EXISTS provider_wallets (
            provider_id BIGINT PRIMARY KEY,
            balance_cents BIGINT NOT NULL DEFAULT 0,
            commission_owed_cents BIGINT NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS webhook_events (
            gateway_event_id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            gateway_ref TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS legacy_imports (migration_ref UUID PRIMARY KEY);
    """)


class Settlement(BaseModel):
    gateway_event_id: str
    type: str
    gateway_ref: str


class Credit(BaseModel):
    operation_ref: UUID
    order_id: PositiveInt
    customer_id: PositiveInt
    provider_id: PositiveInt
    method: Literal["gateway", "cod"]
    amount_cents: NonNegativeInt
    booking_ref: UUID | None = None


class LegacySnapshot(BaseModel):
    migration_ref: UUID
    intents: list[dict]
    transactions: list[dict]
    wallets: list[dict]
    events: list[dict]


def import_legacy(db, snapshot):
    added = db.execute("INSERT INTO legacy_imports VALUES (%s) ON CONFLICT DO NOTHING RETURNING migration_ref",
                       (snapshot.migration_ref,)).fetchone()
    if not added:
        return
    db.execute("""
        INSERT INTO payment_intents (booking_ref, order_id, customer_id, provider_id, amount_cents, gateway_ref, status)
        SELECT * FROM jsonb_to_recordset(%s) AS i(booking_ref uuid, order_id bigint, customer_id bigint,
            provider_id bigint, amount_cents bigint, gateway_ref text, status text)
        ON CONFLICT (booking_ref) DO UPDATE SET order_id = EXCLUDED.order_id, status = EXCLUDED.status
    """, (Jsonb(snapshot.intents),))
    db.execute("""
        INSERT INTO transactions (operation_ref, order_id, customer_id, provider_id, kind, amount_cents,
                                  method, gateway_ref, status, created_at)
        SELECT %s || ':' || t.id, t.order_id, t.customer_id, t.provider_id, t.kind, t.amount_cents,
               t.method, t.gateway_ref, t.status, t.created_at
        FROM jsonb_to_recordset(%s) AS t(id bigint, order_id bigint, customer_id bigint, provider_id bigint,
              kind text, amount_cents bigint, method text, gateway_ref text, status text, created_at timestamptz)
        ORDER BY t.id
    """, (str(snapshot.migration_ref), Jsonb(snapshot.transactions)))
    db.execute("""
        INSERT INTO provider_wallets (provider_id, balance_cents, commission_owed_cents)
        SELECT * FROM jsonb_to_recordset(%s) AS w(provider_id bigint, balance_cents bigint, commission_owed_cents bigint)
        ON CONFLICT (provider_id) DO UPDATE SET
            balance_cents = provider_wallets.balance_cents + EXCLUDED.balance_cents,
            commission_owed_cents = provider_wallets.commission_owed_cents + EXCLUDED.commission_owed_cents
    """, (Jsonb(snapshot.wallets),))
    db.execute("""
        INSERT INTO webhook_events (gateway_event_id, type, gateway_ref)
        SELECT * FROM jsonb_to_recordset(%s) AS w(gateway_event_id text, type text, gateway_ref text)
    """, (Jsonb(snapshot.events),))


def lock_intent(db, gateway_ref):
    intent = db.execute(
        "SELECT * FROM payment_intents WHERE gateway_ref = %s FOR UPDATE", (gateway_ref,)
    ).fetchone()
    if not intent:
        raise HTTPException(404, "payment intent not found")
    return intent


def add_transaction(db, *, ref, order, customer, provider, kind, amount, method, status, gateway=None):
    return db.execute("""
        INSERT INTO transactions (operation_ref, order_id, customer_id, provider_id, kind,
                                  amount_cents, method, status, gateway_ref)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (operation_ref) DO NOTHING RETURNING id
    """, (ref, order, customer, provider, kind, amount, method, status, gateway)).fetchone()


def add_gateway_transaction(db, intent, kind, status):
    add_transaction(db, ref=f'{kind}:{intent["booking_ref"]}', order=intent["order_id"],
                    customer=intent["customer_id"], provider=intent["provider_id"],
                    kind=kind, amount=intent["amount_cents"], method="gateway", status=status,
                    gateway=intent["gateway_ref"])


def status_result(intent, **result):
    return {"booking_ref": str(intent["booking_ref"]), "status": intent["status"], **result}


def settle(db, request):
    intent = lock_intent(db, request.gateway_ref)
    added = db.execute("""
        INSERT INTO webhook_events (gateway_event_id, type, gateway_ref) VALUES (%s, %s, %s)
        ON CONFLICT DO NOTHING RETURNING gateway_event_id
    """, (request.gateway_event_id, request.type, request.gateway_ref)).fetchone()
    if not added:
        original = db.execute("SELECT * FROM webhook_events WHERE gateway_event_id = %s",
                              (request.gateway_event_id,)).fetchone()
        if original["gateway_ref"] != request.gateway_ref or original["type"] != request.type:
            raise HTTPException(409, "event ID already belongs to another payment event")
        return status_result(intent, replayed=True)
    if request.type != "payment_intent.succeeded":
        return status_result(intent, replayed=False)
    if intent["status"] == "cancelled":
        raise HTTPException(409, "cancelled booking cannot be paid")
    if intent["status"] != "requires_payment":
        return status_result(intent, replayed=False, already_settled=True)
    db.execute("UPDATE payment_intents SET status = 'succeeded' WHERE id = %s", (intent["id"],))
    add_gateway_transaction(db, intent, "charge", "succeeded")
    return status_result({**intent, "status": "succeeded"}, replayed=False, settled=True)


def close(db, gateway_ref):
    intent = lock_intent(db, gateway_ref)
    if intent["status"] == "succeeded":
        add_gateway_transaction(db, intent, "refund", "refunded")
        intent["status"] = "refunded"
    elif intent["status"] == "requires_payment":
        intent["status"] = "cancelled"
    db.execute("UPDATE payment_intents SET status = %s WHERE id = %s", (intent["status"], intent["id"]))
    return status_result(intent, refunded=intent["status"] == "refunded")


def credit(db, request):
    gateway = request.method == "gateway"
    if gateway:
        intent = db.execute("SELECT * FROM payment_intents WHERE booking_ref = %s FOR UPDATE",
                            (request.booking_ref,)).fetchone()
        if (not intent or intent["status"] != "succeeded"
                or any(intent[k] != getattr(request, k) for k in ("order_id", "provider_id", "customer_id"))
                or request.amount_cents > intent["amount_cents"]):
            raise HTTPException(409, "payment is ineligible for payout")
    added = add_transaction(db, ref=str(request.operation_ref), order=request.order_id,
                            customer=request.customer_id, provider=request.provider_id,
                            kind="payout_credit" if gateway else "commission_owed",
                            amount=request.amount_cents, method=request.method, status="succeeded")
    if added:
        db.execute("""
            INSERT INTO provider_wallets (provider_id, balance_cents, commission_owed_cents)
            VALUES (%s, %s, %s)
            ON CONFLICT (provider_id) DO UPDATE SET
                balance_cents = provider_wallets.balance_cents + EXCLUDED.balance_cents,
                commission_owed_cents = provider_wallets.commission_owed_cents + EXCLUDED.commission_owed_cents
        """, (request.provider_id, request.amount_cents if gateway else 0,
              0 if gateway else request.amount_cents))
    return {"applied": True}


def transactions(db, *, provider=None, customer=None):
    columns = "id, order_id, kind, amount_cents, method, gateway_ref, status, created_at"
    if provider is not None:
        return db.execute(f"SELECT {columns} FROM transactions WHERE provider_id = %s ORDER BY id DESC",
                          (provider,)).fetchall()
    return db.execute(f"SELECT {columns} FROM transactions WHERE customer_id = %s ORDER BY id DESC",
                      (customer,)).fetchall()


def register_routes(app, connect):
    worker = [Depends(require_worker)]

    @app.post("/internal/legacy-import", dependencies=worker)
    def migrate_ledger(snapshot: LegacySnapshot):
        with connect() as db:
            import_legacy(db, snapshot)
        return {"migration_ref": snapshot.migration_ref}

    @app.post("/internal/settlements", dependencies=worker)
    def apply_settlement(request: Settlement):
        with connect() as db:
            return settle(db, request)

    @app.post("/internal/intents/{gateway_ref}/close", dependencies=worker)
    def close_intent(gateway_ref: str):
        with connect() as db:
            return close(db, gateway_ref)

    @app.post("/internal/wallet-credits", dependencies=worker)
    def apply_credit(request: Credit):
        with connect() as db:
            return credit(db, request)

    @app.get("/api/provider/wallet")
    def wallet(provider_id=Depends(user_id("provider"))):
        with connect() as db:
            row = db.execute("SELECT * FROM provider_wallets WHERE provider_id = %s", (provider_id,)).fetchone()
            return {
                "provider_id": provider_id,
                "balance_cents": row["balance_cents"] if row else 0,
                "commission_owed_cents": row["commission_owed_cents"] if row else 0,
                "transactions": transactions(db, provider=provider_id),
            }

    @app.get("/api/customer/transactions")
    def customer_transactions(customer_id=Depends(user_id("customer"))):
        with connect() as db:
            return transactions(db, customer=customer_id)
