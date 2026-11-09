// Catalog context owns categories + services (services are provider-owned). SQL only.
import { getDb } from "../../db/index.js";

export function toPublicService(row) {
  return {
    id: row.id,
    provider_id: row.provider_id,
    category_id: row.category_id,
    title: row.title,
    slug: row.slug,
    description: row.description,
    price_cents: row.price_cents,
    duration_min: row.duration_min,
    tax_percent: row.tax_percent,
    status: row.status,
    rating_avg: row.rating_avg,
    rating_count: row.rating_count,
    provider_name: row.provider_name ?? undefined,
    category_name: row.category_name ?? undefined,
  };
}

// ---- categories ----
export function listActiveCategories() {
  return getDb().prepare("SELECT id, name, slug, status FROM categories WHERE status = 1 ORDER BY id").all();
}
export function findCategoryBySlug(slug) {
  return getDb().prepare("SELECT * FROM categories WHERE slug = ?").get(slug);
}
export function findCategoryById(id) {
  return getDb().prepare("SELECT * FROM categories WHERE id = ?").get(id);
}

// ---- services ----
export function findServiceById(id) {
  return getDb()
    .prepare(
      `SELECT s.*, p.name AS provider_name, c.name AS category_name
       FROM services s JOIN providers p ON p.id = s.provider_id
       JOIN categories c ON c.id = s.category_id
       WHERE s.id = ?`
    )
    .get(id);
}

export function findServiceRaw(id) {
  return getDb().prepare("SELECT * FROM services WHERE id = ?").get(id);
}

export function listByProvider(providerId) {
  return getDb()
    .prepare(
      `SELECT s.*, c.name AS category_name FROM services s
       JOIN categories c ON c.id = s.category_id
       WHERE s.provider_id = ? ORDER BY s.id`
    )
    .all(providerId);
}

// Active services in an active category, only for approved providers — the customer-facing listing.
export function listByCategoryApproved(categoryId) {
  return getDb()
    .prepare(
      `SELECT s.*, p.name AS provider_name, c.name AS category_name FROM services s
       JOIN providers p ON p.id = s.provider_id
       JOIN provider_profiles pp ON pp.provider_id = s.provider_id
       JOIN categories c ON c.id = s.category_id
       WHERE s.category_id = ? AND s.status = 1 AND pp.is_approved = 1
       ORDER BY s.rating_avg DESC, s.id ASC`
    )
    .all(categoryId);
}

// General search over active services from approved providers, with optional filters + pagination.
export function searchServices({ categoryId, providerId, q, limit, offset }) {
  const where = ["s.status = 1", "pp.is_approved = 1"];
  const args = [];
  if (categoryId) { where.push("s.category_id = ?"); args.push(categoryId); }
  if (providerId) { where.push("s.provider_id = ?"); args.push(providerId); }
  if (q) { where.push("s.title LIKE ?"); args.push(`%${q}%`); }
  const clause = where.join(" AND ");
  const rows = getDb()
    .prepare(
      `SELECT s.*, p.name AS provider_name, c.name AS category_name FROM services s
       JOIN providers p ON p.id = s.provider_id
       JOIN provider_profiles pp ON pp.provider_id = s.provider_id
       JOIN categories c ON c.id = s.category_id
       WHERE ${clause}
       ORDER BY s.rating_avg DESC, s.id ASC
       LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset);
  const total = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM services s
       JOIN provider_profiles pp ON pp.provider_id = s.provider_id
       WHERE ${clause}`
    )
    .get(...args).n;
  return { rows, total };
}

export function topRatedServices(limit) {
  return getDb()
    .prepare(
      `SELECT s.*, p.name AS provider_name, c.name AS category_name FROM services s
       JOIN providers p ON p.id = s.provider_id
       JOIN provider_profiles pp ON pp.provider_id = s.provider_id
       JOIN categories c ON c.id = s.category_id
       WHERE s.status = 1 AND pp.is_approved = 1
       ORDER BY s.rating_avg DESC, s.rating_count DESC, s.id ASC
       LIMIT ?`
    )
    .all(limit);
}

export function insertService({ providerId, categoryId, title, slug, description, priceCents, durationMin, taxPercent }) {
  return getDb()
    .prepare(
      `INSERT INTO services (provider_id, category_id, title, slug, description, price_cents, duration_min, tax_percent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(providerId, categoryId, title, slug, description ?? "", priceCents, durationMin, taxPercent).lastInsertRowid;
}

export function updateService(serviceId, fields) {
  const sets = [];
  const args = [];
  for (const [col, val] of Object.entries(fields)) {
    sets.push(`${col} = ?`);
    args.push(val);
  }
  if (sets.length === 0) return 0;
  args.push(serviceId);
  return getDb().prepare(`UPDATE services SET ${sets.join(", ")} WHERE id = ?`).run(...args).changes;
}

// Relay-driven aggregate recompute for a service, from its reviews.
export function recomputeRatingAggregate(serviceId) {
  const agg = getDb()
    .prepare("SELECT COUNT(*) AS n, COALESCE(AVG(rating), 0) AS avg FROM reviews WHERE service_id = ?")
    .get(serviceId);
  getDb()
    .prepare("UPDATE services SET rating_avg = ?, rating_count = ? WHERE id = ?")
    .run(agg.avg, agg.n, serviceId);
}
