from contextlib import asynccontextmanager
from os import environ
from time import sleep
from uuid import UUID, uuid4

import psycopg
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from psycopg.rows import dict_row
from pydantic import BaseModel, PositiveInt
from auth import require_worker
from ledger import create_ledger_tables, register_routes


def connect():
    return psycopg.connect(
        host=environ["PAYMENTS_DB_HOST"],
        dbname=environ["PAYMENTS_DB_NAME"],
        user=environ["PAYMENTS_DB_USER"],
        password=environ["PAYMENTS_DB_PASSWORD"],
        connect_timeout=3,
        row_factory=dict_row,
    )


@asynccontextmanager
async def lifespan(_app: FastAPI):
    with connect() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS payment_intents (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                booking_ref UUID NOT NULL UNIQUE,
                customer_id BIGINT NOT NULL,
                provider_id BIGINT NOT NULL,
                amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
                gateway_ref TEXT NOT NULL UNIQUE
            )
        """)
        db.execute("ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS order_id BIGINT")
        db.execute("ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'requires_payment'")
        create_ledger_tables(db)
    yield


app = FastAPI(lifespan=lifespan)


@app.exception_handler(HTTPException)
async def http_error(_request: Request, error: HTTPException):
    return JSONResponse(status_code=error.status_code, content={"error": error.detail})


register_routes(app, connect)


class IntentRequest(BaseModel):
    booking_ref: UUID
    order_id: PositiveInt
    customer_id: PositiveInt
    provider_id: PositiveInt
    amount_cents: int


@app.get("/health")
def health():
    with connect() as db:
        db.execute("SELECT 1")
    return {"status": "ok"}


@app.post("/internal/payment-intents", dependencies=[Depends(require_worker)])
def create_intent(request: IntentRequest):
    with connect() as db:
        existing = db.execute(
            "SELECT * FROM payment_intents WHERE booking_ref = %s", (request.booking_ref,)
        ).fetchone()
        if existing is None and (
            request.amount_cents < 0 or environ.get("PAYMENTS_DEMO_REJECT_INTENTS") == "true"
        ):
            return JSONResponse(status_code=422, content={"code": "payment_setup_rejected"})

        created = None
        if existing is None:
            created = db.execute(
                """
                INSERT INTO payment_intents
                    (booking_ref, order_id, customer_id, provider_id, amount_cents, gateway_ref)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (booking_ref) DO NOTHING
                RETURNING *
                """,
                (request.booking_ref, request.order_id, request.customer_id, request.provider_id,
                 request.amount_cents, f"SIM-PI-{uuid4()}"),
            ).fetchone()
        row = existing or created or db.execute(
            "SELECT * FROM payment_intents WHERE booking_ref = %s", (request.booking_ref,)
        ).fetchone()
        if any(row[key] != getattr(request, key) for key in (
            "customer_id", "provider_id", "amount_cents"
        )) or row["order_id"] not in (None, request.order_id):
            raise HTTPException(409, "booking reference already has different payment details")
        if row["order_id"] is None:
            db.execute("UPDATE payment_intents SET order_id = %s WHERE booking_ref = %s AND order_id IS NULL",
                       (request.order_id, request.booking_ref))

    # In the isolated demo, delay only the first response, after PostgreSQL has committed.
    if created and environ.get("PAYMENTS_DEMO_DELAY_FIRST_REPLY") == "true":
        sleep(8)
    return JSONResponse(
        status_code=201 if created else 200,
        content={
            "id": row["id"],
            "booking_ref": str(row["booking_ref"]),
            "gateway_ref": row["gateway_ref"],
            "amount_cents": row["amount_cents"],
            "status": "requires_payment",
        },
    )
