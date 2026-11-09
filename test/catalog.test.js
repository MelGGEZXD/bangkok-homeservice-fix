import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot, getDb } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import { registerProvider, loginSeededProvider } from "../test-helpers/auth.js";

import * as categories from "../app/api/categories/route.js";
import * as categoryServices from "../app/api/categories/[slug]/services/route.js";
import * as services from "../app/api/services/route.js";
import * as serviceDetail from "../app/api/services/[id]/route.js";
import * as providerServices from "../app/api/provider/services/route.js";
import * as providerService from "../app/api/provider/services/[id]/route.js";

freshBoot();

test("catalog", async (t) => {
  const cleaning = getDb().prepare("SELECT id FROM categories WHERE slug='cleaning'").get().id;

  await t.test("GET /api/categories lists the 4 active categories", async () => {
    const res = await call(categories.GET);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 4);
  });

  await t.test("category -> services lists only approved providers' services", async () => {
    const cleaningRes = await call(categoryServices.GET, { params: { slug: "cleaning" } });
    assert.equal(cleaningRes.status, 200);
    assert.equal(cleaningRes.body.services.length, 2, "sparkle (approved) has 2 cleaning services");

    // Beauty has only Glow, who is NOT approved -> zero services surface.
    const beautyRes = await call(categoryServices.GET, { params: { slug: "beauty" } });
    assert.equal(beautyRes.status, 200);
    assert.equal(beautyRes.body.services.length, 0);

    const missing = await call(categoryServices.GET, { params: { slug: "nope" } });
    assert.equal(missing.status, 404);
  });

  await t.test("service detail 404 on a missing id", async () => {
    const res = await call(serviceDetail.GET, { params: { id: "999999" } });
    assert.equal(res.status, 404);
  });

  await t.test("provider creates a service; duration must be a multiple of 30 else 400", async () => {
    const p = await registerProvider();

    const bad = await call(providerServices.POST, {
      token: p.token,
      body: { category_id: cleaning, title: "Odd Duration", price_cents: 10000, duration_min: 45 },
    });
    assert.equal(bad.status, 400);

    const ok = await call(providerServices.POST, {
      token: p.token,
      body: { category_id: cleaning, title: "Window Wash", price_cents: 25000, duration_min: 60 },
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.duration_min, 60);
    assert.ok(ok.headers.get("location"));
  });

  await t.test("a provider cannot edit another provider's service -> 403", async () => {
    const other = await registerProvider();
    // service id 1 is seeded and owned by Sparkle.
    const res = await call(providerService.PATCH, {
      token: other.token,
      params: { id: "1" },
      body: { price_cents: 1 },
    });
    assert.equal(res.status, 403);
  });

  await t.test("a provider can edit their own service", async () => {
    const sparkle = await loginSeededProvider("sparkle@example.com");
    const res = await call(providerService.PATCH, {
      token: sparkle.token,
      params: { id: "1" },
      body: { price_cents: 130000 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.price_cents, 130000);
  });

  await t.test("GET /api/services paginates with X-Total-Count / X-Page", async () => {
    const res = await call(services.GET, { query: { category_id: cleaning, page: 1, size: 1 } });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.headers.get("x-total-count"), "2");
    assert.equal(res.headers.get("x-page"), "1");
  });
});
