// Provider Profile context owns provider_profiles + provider_timings. SQL only.
import { getDb } from "../../db/index.js";

export function findProfile(providerId) {
  return getDb().prepare("SELECT * FROM provider_profiles WHERE provider_id = ?").get(providerId);
}

// Approved providers with their aggregate rating and live service count — the public directory.
export function listApprovedProviders() {
  return getDb()
    .prepare(
      `SELECT p.id, p.name, pp.company_name, pp.about, pp.rating_avg, pp.rating_count,
              pp.service_radius_km, pp.is_accepting_custom_jobs,
              (SELECT COUNT(*) FROM services s WHERE s.provider_id = p.id AND s.status = 1) AS service_count
       FROM providers p
       JOIN provider_profiles pp ON pp.provider_id = p.id
       WHERE pp.is_approved = 1
       ORDER BY pp.rating_avg DESC, p.id ASC`
    )
    .all();
}

// Admin directory: every provider, approved or pending.
export function listAllProviders() {
  return getDb()
    .prepare(
      `SELECT p.id, p.name, p.email, pp.company_name, pp.is_approved, pp.commission_pct, pp.rating_avg, pp.rating_count
       FROM providers p JOIN provider_profiles pp ON pp.provider_id = p.id
       ORDER BY pp.is_approved ASC, p.id ASC`
    )
    .all();
}

export function findPublicProvider(providerId) {
  return getDb()
    .prepare(
      `SELECT p.id, p.name, pp.company_name, pp.about, pp.is_approved, pp.rating_avg, pp.rating_count,
              pp.service_radius_km, pp.is_accepting_custom_jobs
       FROM providers p
       JOIN provider_profiles pp ON pp.provider_id = p.id
       WHERE p.id = ?`
    )
    .get(providerId);
}

export function updateProfile(providerId, fields) {
  const sets = [];
  const args = [];
  for (const [col, val] of Object.entries(fields)) {
    sets.push(`${col} = ?`);
    args.push(val);
  }
  if (sets.length === 0) return 0;
  args.push(providerId);
  return getDb()
    .prepare(`UPDATE provider_profiles SET ${sets.join(", ")} WHERE provider_id = ?`)
    .run(...args).changes;
}

export function approve(providerId) {
  return getDb()
    .prepare("UPDATE provider_profiles SET is_approved = 1 WHERE provider_id = ?")
    .run(providerId).changes;
}

export function setCommission(providerId, commissionPct) {
  return getDb()
    .prepare("UPDATE provider_profiles SET commission_pct = ? WHERE provider_id = ?")
    .run(commissionPct, providerId).changes;
}

// Recompute a provider's rolling rating aggregate from the reviews table (relay-driven).
export function recomputeRatingAggregate(providerId) {
  const agg = getDb()
    .prepare("SELECT COUNT(*) AS n, COALESCE(AVG(rating), 0) AS avg FROM reviews WHERE provider_id = ?")
    .get(providerId);
  getDb()
    .prepare("UPDATE provider_profiles SET rating_avg = ?, rating_count = ? WHERE provider_id = ?")
    .run(agg.avg, agg.n, providerId);
}

// ---- timings ----
export function listTimings(providerId) {
  return getDb()
    .prepare("SELECT weekday, opening_time, closing_time, is_open FROM provider_timings WHERE provider_id = ? ORDER BY weekday")
    .all(providerId);
}

export function findTiming(providerId, weekday) {
  return getDb()
    .prepare("SELECT * FROM provider_timings WHERE provider_id = ? AND weekday = ?")
    .get(providerId, weekday);
}

export function upsertTiming(providerId, { weekday, opening_time, closing_time, is_open }) {
  getDb()
    .prepare(
      `INSERT INTO provider_timings (provider_id, weekday, opening_time, closing_time, is_open)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (provider_id, weekday)
       DO UPDATE SET opening_time = excluded.opening_time, closing_time = excluded.closing_time, is_open = excluded.is_open`
    )
    .run(providerId, weekday, opening_time, closing_time, is_open ? 1 : 0);
}
