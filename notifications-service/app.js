// Express app for the extracted Notifications bounded context.
//
// Public read side (through the gateway):
//   GET  /api/notifications            -> the caller's inbox (JWT required)
//   POST /api/notifications/:id/read   -> mark own notification read (JWT required)
//
// Internal write side (monolith relay only, shared key):
//   POST /internal/notifications       -> idempotent create from an outbox event
const express = require("express");
const crypto = require("node:crypto");
const { z } = require("zod");
const { requireUser } = require("./auth");
const config = require("./config");

const notificationCommand = z.object({
  source_event_id: z.string().uuid(),
  recipient_role: z.enum(["customer", "provider", "admin"]),
  recipient_id: z.number().int().positive(),
  type: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  order_id: z.number().int().positive().nullable().optional(),
});

function toPublic(row) {
  return {
    id: Number(row.id),
    type: row.type,
    title: row.title,
    body: row.body,
    order_id: row.order_id === null ? null : Number(row.order_id),
    read_at: row.read_at ? row.read_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
  };
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function requireInternalKey(req, res, next) {
  const supplied = req.headers["x-internal-key"];
  if (!supplied || !safeEqual(supplied, config.internalApiKey)) {
    return res.status(401).json({ error: "invalid internal key" });
  }
  return next();
}

function createApp(pool) {
  const app = express();
  app.disable("x-powered-by");

  // Correlation id at this boundary: reuse the gateway's id (or the outbox event UUID on internal
  // deliveries), otherwise mint one. Echoed so a caller can follow the request across the seam.
  app.use((req, res, next) => {
    req.requestId = req.headers["x-request-id"] || crypto.randomUUID();
    res.setHeader("x-request-id", req.requestId);
    next();
  });

  app.use(express.json({ limit: "64kb" }));

  app.get("/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok", service: "notifications", database: "up" });
    } catch (err) {
      res.status(503).json({ status: "unavailable", service: "notifications", error: err.message });
    }
  });

  app.get("/api/notifications", requireUser, async (req, res) => {
    const { rows } = await pool.query(
      `SELECT * FROM notifications
        WHERE recipient_role = $1 AND recipient_id = $2
        ORDER BY id DESC`,
      [req.user.role, req.user.sub]
    );
    res.json(rows.map(toPublic));
  });

  app.post("/api/notifications/:id/read", requireUser, async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "notification id must be a positive integer" });
    }

    const found = await pool.query("SELECT * FROM notifications WHERE id = $1", [id]);
    if (found.rows.length === 0) return res.status(404).json({ error: `notification ${id} not found` });

    const row = found.rows[0];
    if (row.recipient_role !== req.user.role || Number(row.recipient_id) !== req.user.sub) {
      return res.status(403).json({ error: "not your notification" });
    }

    if (!row.read_at) {
      await pool.query(
        "UPDATE notifications SET read_at = now() WHERE id = $1 AND read_at IS NULL",
        [id]
      );
    }
    const updated = await pool.query("SELECT * FROM notifications WHERE id = $1", [id]);
    return res.json(toPublic(updated.rows[0]));
  });

  app.post("/internal/notifications", requireInternalKey, async (req, res) => {
    const parsed = notificationCommand.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid notification command", details: parsed.error.flatten() });
    }
    const n = parsed.data;

    const { rows } = await pool.query(
      `INSERT INTO notifications
         (source_event_id, recipient_role, recipient_id, type, title, body, order_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source_event_id, recipient_role, recipient_id, type) DO NOTHING
       RETURNING *`,
      [n.source_event_id, n.recipient_role, n.recipient_id, n.type, n.title, n.body, n.order_id ?? null]
    );

    if (rows.length === 0) {
      return res.status(200).json({ duplicate: true });
    }
    return res.status(201).json({ duplicate: false, notification: toPublic(rows[0]) });
  });

  app.use((req, res) => {
    res.status(404).json({ error: `no route for ${req.method} ${req.path}` });
  });

  // Express 5 forwards rejected async handlers here.
  app.use((err, _req, res, _next) => {
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status >= 500) {
      console.error(JSON.stringify({ level: "error", service: "notifications", err: err.stack || err.message }));
    }
    res.status(status).json({ error: status >= 500 ? "internal server error" : err.message });
  });

  return app;
}

module.exports = { createApp };
