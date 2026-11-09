// Bidding context owns job_requests + bids. SQL only — including the conditional UPDATEs that make
// accept/withdraw a lost-update race with exactly one winner (no read-then-write gap anywhere).
import { getDb } from "../../db/index.js";
import { ConflictError } from "../../errors.js";

// ---- job_requests ----
export function insertJob(j) {
  return getDb()
    .prepare(
      `INSERT INTO job_requests (customer_id, category_id, title, description, min_price_cents, max_price_cents, window_start, window_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(j.customerId, j.categoryId, j.title, j.description ?? "", j.minPriceCents, j.maxPriceCents, j.windowStart, j.windowEnd)
    .lastInsertRowid;
}
export function findJobById(id) {
  return getDb().prepare("SELECT * FROM job_requests WHERE id = ?").get(id);
}
export function listOpenJobs(categoryIds) {
  if (categoryIds && categoryIds.length) {
    const placeholders = categoryIds.map(() => "?").join(",");
    return getDb()
      .prepare(`SELECT * FROM job_requests WHERE status = 'open' AND category_id IN (${placeholders}) ORDER BY id DESC`)
      .all(...categoryIds);
  }
  return getDb().prepare("SELECT * FROM job_requests WHERE status = 'open' ORDER BY id DESC").all();
}
export function listJobsForCustomer(customerId) {
  return getDb().prepare("SELECT * FROM job_requests WHERE customer_id = ? ORDER BY id DESC").all(customerId);
}
export function cancelJobAtomic(jobId, customerId) {
  return getDb()
    .prepare("UPDATE job_requests SET status = 'cancelled' WHERE id = ? AND customer_id = ? AND status = 'open'")
    .run(jobId, customerId).changes;
}
// One winner: only an 'open' job flips to 'booked'. Two concurrent accepts both target this row;
// the loser's UPDATE matches zero rows.
export function bookJobAtomic(jobId) {
  return getDb()
    .prepare("UPDATE job_requests SET status = 'booked' WHERE id = ? AND status = 'open'")
    .run(jobId).changes;
}

// ---- bids ----
export function insertBid(b) {
  try {
    return getDb()
      .prepare(
        `INSERT INTO bids (job_request_id, provider_id, counter_price_cents, note, duration_min)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(b.jobRequestId, b.providerId, b.counterPriceCents, b.note ?? null, b.durationMin).lastInsertRowid;
  } catch (err) {
    if (err && err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new ConflictError("you have already bid on this job");
    }
    throw err;
  }
}
export function findBidById(id) {
  return getDb().prepare("SELECT * FROM bids WHERE id = ?").get(id);
}
export function findBidByJobAndProvider(jobId, providerId) {
  return getDb().prepare("SELECT * FROM bids WHERE job_request_id = ? AND provider_id = ?").get(jobId, providerId);
}
export function listBidsForJob(jobId) {
  return getDb().prepare("SELECT * FROM bids WHERE job_request_id = ? ORDER BY id").all(jobId);
}
export function listBidsForProvider(providerId) {
  return getDb()
    .prepare(
      `SELECT b.*, j.title AS job_title, j.status AS job_status
       FROM bids b JOIN job_requests j ON j.id = b.job_request_id
       WHERE b.provider_id = ? ORDER BY b.id DESC`
    )
    .all(providerId);
}
export function countBidsForJob(jobId) {
  return getDb().prepare("SELECT COUNT(*) AS n FROM bids WHERE job_request_id = ?").get(jobId).n;
}
export function pendingLoserProviderIds(jobId, winnerBidId) {
  return getDb()
    .prepare("SELECT provider_id FROM bids WHERE job_request_id = ? AND id != ? AND status = 'pending'")
    .all(jobId, winnerBidId)
    .map((r) => r.provider_id);
}
// One winner: only a 'pending' bid on this job flips to 'accepted'.
export function acceptBidAtomic(bidId, jobId) {
  return getDb()
    .prepare("UPDATE bids SET status = 'accepted' WHERE id = ? AND job_request_id = ? AND status = 'pending'")
    .run(bidId, jobId).changes;
}
export function rejectOtherBids(jobId, winnerBidId) {
  return getDb()
    .prepare("UPDATE bids SET status = 'rejected' WHERE job_request_id = ? AND id != ? AND status = 'pending'")
    .run(jobId, winnerBidId).changes;
}
// The withdraw mirror of accept: only the provider's own 'pending' bid flips to 'withdrawn'.
export function withdrawBidAtomic(bidId, providerId) {
  return getDb()
    .prepare("UPDATE bids SET status = 'withdrawn' WHERE id = ? AND provider_id = ? AND status = 'pending'")
    .run(bidId, providerId).changes;
}
