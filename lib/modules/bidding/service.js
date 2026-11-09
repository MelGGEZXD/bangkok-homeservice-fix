// Bidding business logic: custom job requests + provider bids, and the bid-accept transaction that
// resolves to exactly one winner and spins up a booking. Accept + withdraw both compete to flip a
// single 'pending' row; the loser's conditional UPDATE matches zero rows — no read-then-write gap.
import { randomUUID } from "node:crypto";
import { getDb } from "../../db/index.js";
import { config } from "../../config.js";
import { insertEvent } from "../../db/events.js";
import * as repository from "./repository.js";
import * as bookingRepository from "../booking/repository.js";
import * as providersRepository from "../providers/repository.js";
import * as catalogRepository from "../catalog/repository.js";
import { slotRange, timeToMinutes, minutesToTime } from "../booking/slots.js";
import { NotFoundError, ForbiddenError, ConflictError, BadRequestError } from "../../errors.js";

function round(n) {
  return Math.round(n);
}

function publicJob(row) {
  return {
    id: row.id,
    customer_id: row.customer_id,
    category_id: row.category_id,
    title: row.title,
    description: row.description,
    min_price_cents: row.min_price_cents,
    max_price_cents: row.max_price_cents,
    window_start: row.window_start,
    window_end: row.window_end,
    status: row.status,
    created_at: row.created_at,
  };
}
function publicBid(row) {
  return {
    id: row.id,
    job_request_id: row.job_request_id,
    provider_id: row.provider_id,
    counter_price_cents: row.counter_price_cents,
    note: row.note,
    duration_min: row.duration_min,
    status: row.status,
    created_at: row.created_at,
  };
}

export function postJob(customerId, input) {
  if (input.max_price_cents < input.min_price_cents) {
    throw new BadRequestError("validation failed", [
      { path: "max_price_cents", message: "max_price_cents must be >= min_price_cents" },
    ]);
  }
  const category = catalogRepository.findCategoryById(input.category_id);
  if (!category) throw new BadRequestError("validation failed", [{ path: "category_id", message: "unknown category" }]);

  const id = repository.insertJob({
    customerId,
    categoryId: input.category_id,
    title: input.title,
    description: input.description,
    minPriceCents: input.min_price_cents,
    maxPriceCents: input.max_price_cents,
    windowStart: input.window_start,
    windowEnd: input.window_end,
  });
  return publicJob(repository.findJobById(id));
}

export function listJobs(auth, { categoryIds } = {}) {
  if (auth.role === "provider") {
    return repository.listOpenJobs(categoryIds).map(publicJob);
  }
  return repository.listJobsForCustomer(auth.sub).map(publicJob);
}

export function getJob(id, auth) {
  const job = repository.findJobById(id);
  if (!job) throw new NotFoundError(`job ${id} not found`);

  // Object-level authorization. Before Area B this endpoint returned any job to any authenticated
  // caller. Policy: the owner always; an admin always; a provider while the job is open (it is a
  // marketplace listing) or if they actually bid on it; nobody else.
  const isOwner = auth.role === "customer" && job.customer_id === auth.sub;
  const ownBid =
    auth.role === "provider" ? repository.findBidByJobAndProvider(id, auth.sub) : null;
  const mayRead =
    auth.role === "admin" ||
    isOwner ||
    (auth.role === "provider" && (job.status === "open" || Boolean(ownBid)));
  if (!mayRead) throw new ForbiddenError("you are not a participant on this job");

  const bidCount = repository.countBidsForJob(id);

  let bids;
  if (isOwner) {
    bids = repository.listBidsForJob(id).map(publicBid);
  } else if (ownBid) {
    bids = [publicBid(ownBid)];
  } else {
    bids = [];
  }
  return { job: publicJob(job), bids, bid_count: bidCount };
}

export function listMyBids(providerId) {
  return repository.listBidsForProvider(providerId).map((b) => ({
    ...publicBid(b),
    job_title: b.job_title,
    job_status: b.job_status,
  }));
}

export function cancelJob(id, customerId) {
  const job = repository.findJobById(id);
  if (!job) throw new NotFoundError(`job ${id} not found`);
  if (job.customer_id !== customerId) throw new ForbiddenError("you do not own this job");
  const changes = repository.cancelJobAtomic(id, customerId);
  if (changes === 0) throw new ConflictError(`cannot cancel a ${job.status} job`);
  return publicJob(repository.findJobById(id));
}

export function placeBid(jobId, providerId, input) {
  const job = repository.findJobById(jobId);
  if (!job) throw new NotFoundError(`job ${jobId} not found`);
  if (job.status !== "open") throw new ConflictError("job is not open for bids");

  const profile = providersRepository.findProfile(providerId);
  if (!profile || !profile.is_approved) throw new ForbiddenError("only approved providers may bid");
  if (!profile.is_accepting_custom_jobs) throw new ForbiddenError("you are not accepting custom jobs");

  const id = repository.insertBid({
    jobRequestId: jobId,
    providerId,
    counterPriceCents: input.counter_price_cents,
    note: input.note,
    durationMin: input.duration_min,
  });
  return publicBid(repository.findBidById(id));
}

export function withdrawBid(jobId, bidId, providerId) {
  const bid = repository.findBidById(bidId);
  if (!bid || bid.job_request_id !== jobId) throw new NotFoundError(`bid ${bidId} not found`);
  if (bid.provider_id !== providerId) throw new ForbiddenError("you do not own this bid");
  const changes = repository.withdrawBidAtomic(bidId, providerId);
  if (changes === 0) throw new ConflictError("bid can no longer be withdrawn");
  return publicBid(repository.findBidById(bidId));
}

// ---------- the bid-accept transaction ----------
export function acceptBid(jobId, bidId, customerId) {
  const job = repository.findJobById(jobId);
  if (!job) throw new NotFoundError(`job ${jobId} not found`);
  if (job.customer_id !== customerId) throw new ForbiddenError("you do not own this job");
  const bidPeek = repository.findBidById(bidId);
  if (!bidPeek || bidPeek.job_request_id !== jobId) throw new NotFoundError(`bid ${bidId} not found`);

  const run = getDb().transaction(() => {
    // 1. claim the job (open -> booked).
    if (repository.bookJobAtomic(jobId) === 0) throw new ConflictError("job is no longer open");
    // 2. claim the bid (pending -> accepted). Lost to a withdraw or another accept => 0 rows.
    if (repository.acceptBidAtomic(bidId, jobId) === 0) throw new ConflictError("bid is no longer available");
    // 3. reject the losers (and capture them for notifications first).
    const loserProviderIds = repository.pendingLoserProviderIds(jobId, bidId);
    repository.rejectOtherBids(jobId, bidId);

    const bid = repository.findBidById(bidId);
    const profile = providersRepository.findProfile(bid.provider_id);

    // 4. build a booking from the winning bid. Custom jobs have no catalog service, so the order
    //    carries totals directly and has no order_items (order_items.service_id is NOT NULL).
    const subtotal = bid.counter_price_cents;
    const tax = round((subtotal * config.taxPercent) / 100);
    const total = subtotal + tax;
    const serviceDate = job.window_start.slice(0, 10);
    const startingTime = job.window_start.slice(11, 16);
    const endingTime = minutesToTime(timeToMinutes(startingTime) + bid.duration_min);
    const otp = 100000 + Math.floor(Math.random() * 900000);

    const orderId = bookingRepository.insertOrder({
      customerId,
      providerId: bid.provider_id,
      addressId: null,
      serviceDate,
      startingTime,
      endingTime,
      durationMin: bid.duration_min,
      subtotalCents: subtotal,
      taxCents: tax,
      totalCents: total,
      commissionPct: profile.commission_pct,
      paymentMethod: "cod",
      otp,
      jobRequestId: jobId,
    });

    // slot_holds — same UNIQUE double-book guard as a normal booking.
    for (const slot of slotRange(startingTime, bid.duration_min)) {
      bookingRepository.insertSlotHold(bid.provider_id, serviceDate, slot, orderId);
    }

    insertEvent("booking.status_changed", "order", orderId, {
      order_id: orderId, from: null, to: "awaiting",
      customer_id: customerId, provider_id: bid.provider_id, actor_role: "customer",
    });
    insertEvent("bid.accepted", "bid", bidId, {
      job_request_id: jobId, order_id: orderId, winner_provider_id: bid.provider_id,
      loser_provider_ids: loserProviderIds,
    });

    return {
      order: { ...bookingRepository.findOrderById(orderId) },
      otp,
    };
  });

  const result = run.immediate();
  // Project the order the same way the booking service does.
  return { order: toPublicOrderRow(result.order), otp: result.otp };
}

function toPublicOrderRow(row) {
  return {
    id: row.id,
    customer_id: row.customer_id,
    provider_id: row.provider_id,
    service_date: row.service_date,
    starting_time: row.starting_time,
    ending_time: row.ending_time,
    duration_min: row.duration_min,
    subtotal_cents: row.subtotal_cents,
    tax_cents: row.tax_cents,
    total_cents: row.total_cents,
    commission_pct: row.commission_pct,
    payment_method: row.payment_method,
    payment_status: row.payment_status,
    status: row.status,
    job_request_id: row.job_request_id,
    created_at: row.created_at,
  };
}
