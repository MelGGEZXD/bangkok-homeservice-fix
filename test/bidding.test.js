import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot, getDb } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import { registerCustomer, loginSeededProvider, futureWeekday } from "../test-helpers/auth.js";

import * as jobs from "../app/api/jobs/route.js";
import * as jobDetail from "../app/api/jobs/[id]/route.js";
import * as jobBids from "../app/api/jobs/[id]/bids/route.js";
import * as acceptBid from "../app/api/jobs/[id]/bids/[bidId]/accept/route.js";
import * as withdrawBid from "../app/api/jobs/[id]/bids/[bidId]/withdraw/route.js";

freshBoot();

const APPLIANCE = () => getDb().prepare("SELECT id FROM categories WHERE slug='appliance'").get().id;

async function postJob(customer, time) {
  const date = futureWeekday(5);
  const res = await call(jobs.POST, {
    token: customer.token,
    body: {
      category_id: APPLIANCE(), title: "Fix appliance", min_price_cents: 30000, max_price_cents: 90000,
      window_start: `${date} ${time}`, window_end: `${date} 17:00`,
    },
  });
  return res;
}

test("bidding", async (t) => {
  let customer, fixit, sparkle;

  await t.test("setup", async () => {
    customer = await registerCustomer();
    fixit = await loginSeededProvider("fixit@example.com");
    sparkle = await loginSeededProvider("sparkle@example.com");
  });

  await t.test("customer posts a job (201, open); provider bids (201); duplicate bid -> 409", async () => {
    const job = await postJob(customer, "10:00");
    assert.equal(job.status, 201);
    assert.equal(job.body.status, "open");
    const jobId = String(job.body.id);

    const bid = await call(jobBids.POST, { token: fixit.token, params: { id: jobId }, body: { counter_price_cents: 55000, duration_min: 60 } });
    assert.equal(bid.status, 201);
    assert.equal(bid.body.status, "pending");

    const dupe = await call(jobBids.POST, { token: fixit.token, params: { id: jobId }, body: { counter_price_cents: 60000, duration_min: 60 } });
    assert.equal(dupe.status, 409, "one live bid per provider per job (UNIQUE)");
  });

  await t.test("BID-ACCEPT RACE: two concurrent accepts of two bids -> one 200, one 409; job booked; losers rejected", async () => {
    const job = await postJob(customer, "10:00");
    const jobId = String(job.body.id);

    const bidF = await call(jobBids.POST, { token: fixit.token, params: { id: jobId }, body: { counter_price_cents: 50000, duration_min: 60 } });
    const bidS = await call(jobBids.POST, { token: sparkle.token, params: { id: jobId }, body: { counter_price_cents: 52000, duration_min: 60 } });

    const [rf, rs] = await Promise.all([
      call(acceptBid.POST, { token: customer.token, params: { id: jobId, bidId: String(bidF.body.id) }, method: "POST" }),
      call(acceptBid.POST, { token: customer.token, params: { id: jobId, bidId: String(bidS.body.id) }, method: "POST" }),
    ]);
    const statuses = [rf.status, rs.status].sort();
    assert.deepEqual(statuses, [200, 409], `expected one 200 and one 409, got ${statuses}`);

    const winner = rf.status === 200 ? rf : rs;
    assert.ok(winner.body.order.id, "winning accept created a booking");
    assert.ok(winner.body.otp, "booking has an OTP");

    const jobRow = getDb().prepare("SELECT status FROM job_requests WHERE id = ?").get(Number(jobId));
    assert.equal(jobRow.status, "booked");
    const pending = getDb().prepare("SELECT COUNT(*) AS n FROM bids WHERE job_request_id = ? AND status = 'pending'").get(Number(jobId)).n;
    assert.equal(pending, 0, "no pending bids remain");
    const rejected = getDb().prepare("SELECT COUNT(*) AS n FROM bids WHERE job_request_id = ? AND status = 'rejected'").get(Number(jobId)).n;
    assert.equal(rejected, 1, "the losing bid was rejected");

    // The accepted booking really holds its slots + emitted a bid.accepted event.
    const holds = getDb().prepare("SELECT COUNT(*) AS n FROM slot_holds WHERE order_id = ?").get(winner.body.order.id).n;
    assert.equal(holds, 2, "60 min / 30 = 2 slot_holds");
    const ev = getDb().prepare("SELECT * FROM events WHERE type = 'bid.accepted' AND payload_json LIKE ?").get(`%"order_id":${winner.body.order.id}%`);
    assert.ok(ev, "bid.accepted outbox event exists");
  });

  await t.test("accept-vs-withdraw of the same bid -> exactly one succeeds", async () => {
    const job = await postJob(customer, "13:00");
    const jobId = String(job.body.id);
    const bid = await call(jobBids.POST, { token: fixit.token, params: { id: jobId }, body: { counter_price_cents: 50000, duration_min: 60 } });
    const bidId = String(bid.body.id);

    const [accept, withdraw] = await Promise.all([
      call(acceptBid.POST, { token: customer.token, params: { id: jobId, bidId }, method: "POST" }),
      call(withdrawBid.POST, { token: fixit.token, params: { id: jobId, bidId }, method: "POST" }),
    ]);
    const oks = [accept.status === 200, withdraw.status === 200].filter(Boolean).length;
    assert.equal(oks, 1, `exactly one of accept/withdraw succeeds (accept=${accept.status}, withdraw=${withdraw.status})`);
  });

  await t.test("provider sees a job's own bid + count; a bid on a non-open job -> 409", async () => {
    const job = await postJob(customer, "15:00");
    const jobId = String(job.body.id);
    await call(jobBids.POST, { token: fixit.token, params: { id: jobId }, body: { counter_price_cents: 50000, duration_min: 60 } });

    const asFixit = await call(jobDetail.GET, { token: fixit.token, params: { id: jobId } });
    assert.equal(asFixit.status, 200);
    assert.equal(asFixit.body.bids.length, 1, "provider sees only its own bid");
    assert.equal(asFixit.body.bid_count, 1);

    const asCustomer = await call(jobDetail.GET, { token: customer.token, params: { id: jobId } });
    assert.equal(asCustomer.body.bids.length, 1, "owner sees all bids");
  });

  // Area B regression: GET /api/jobs/{id} used to return any job to any authenticated caller.
  await t.test("BOLA FIX: a stranger cannot read another customer's open job", async () => {
    const owner = await registerCustomer();
    const stranger = await registerCustomer();
    const job = await postJob(owner, "09:30");
    const jobId = String(job.body.id);

    const denied = await call(jobDetail.GET, { token: stranger.token, params: { id: jobId } });
    assert.equal(denied.status, 403, "unrelated customer must not read the job");

    const allowed = await call(jobDetail.GET, { token: owner.token, params: { id: jobId } });
    assert.equal(allowed.status, 200, "owner still sees the job");
    assert.equal(allowed.body.job.id, Number(jobId));

    // Open jobs stay visible to providers: that is the marketplace listing, not a leak.
    const providerView = await call(jobDetail.GET, { token: fixit.token, params: { id: jobId } });
    assert.equal(providerView.status, 200, "a provider may browse an open job");
  });

  await t.test("BOLA FIX: a booked job is visible only to its owner and its bidders", async () => {
    const job = await postJob(customer, "16:00");
    const jobId = String(job.body.id);
    const bid = await call(jobBids.POST, {
      token: fixit.token,
      params: { id: jobId },
      body: { counter_price_cents: 51000, duration_min: 60 },
    });
    const accepted = await call(acceptBid.POST, {
      token: customer.token,
      params: { id: jobId, bidId: String(bid.body.id) },
      method: "POST",
    });
    assert.equal(accepted.status, 200);

    const ownerView = await call(jobDetail.GET, { token: customer.token, params: { id: jobId } });
    assert.equal(ownerView.status, 200);

    const bidderView = await call(jobDetail.GET, { token: fixit.token, params: { id: jobId } });
    assert.equal(bidderView.status, 200, "a provider that bid may see the outcome");

    const nonBidder = await call(jobDetail.GET, { token: sparkle.token, params: { id: jobId } });
    assert.equal(nonBidder.status, 403, "a provider that never bid cannot read a booked job");

    const stranger = await registerCustomer();
    const strangerView = await call(jobDetail.GET, { token: stranger.token, params: { id: jobId } });
    assert.equal(strangerView.status, 403, "an unrelated customer cannot read a booked job");
  });
});
