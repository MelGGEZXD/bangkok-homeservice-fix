import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot, getDb } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import { registerCustomer, registerProvider } from "../test-helpers/auth.js";

import * as customerRegister from "../app/api/auth/customer/register/route.js";
import * as customerLogin from "../app/api/auth/customer/login/route.js";
import * as me from "../app/api/me/route.js";
import * as providerProfile from "../app/api/provider/profile/route.js";

freshBoot();

test("identity", async (t) => {
  await t.test("customer register -> 201 + Location, then login -> token", async () => {
    const email = `nina-${Date.now()}@example.com`;
    const reg = await call(customerRegister.POST, { body: { email, password: "secret12", name: "Nina" } });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.email, email);
    assert.ok(reg.headers.get("location"));

    const login = await call(customerLogin.POST, { body: { email, password: "secret12" } });
    assert.equal(login.status, 200);
    assert.ok(login.body.token);
    assert.match(login.headers.get("set-cookie") || "", /edemand_token=/);
  });

  await t.test("duplicate customer email -> 409", async () => {
    const email = `dupe-${Date.now()}@example.com`;
    await call(customerRegister.POST, { body: { email, password: "secret12", name: "A" } });
    const again = await call(customerRegister.POST, { body: { email, password: "secret12", name: "B" } });
    assert.equal(again.status, 409);
  });

  await t.test("bad credentials -> 401", async () => {
    const c = await registerCustomer();
    const bad = await call(customerLogin.POST, { body: { email: c.email, password: "wrongwrong" } });
    assert.equal(bad.status, 401);
  });

  await t.test("register password < 8 chars -> 400", async () => {
    const res = await call(customerRegister.POST, { body: { email: "x@y.com", password: "short", name: "X" } });
    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.body.details));
  });

  await t.test("provider register also creates provider_profiles + provider_wallets", async () => {
    const p = await registerProvider();
    const profile = getDb().prepare("SELECT * FROM provider_profiles WHERE provider_id = ?").get(p.id);
    const wallet = getDb().prepare("SELECT * FROM provider_wallets WHERE provider_id = ?").get(p.id);
    assert.ok(profile, "expected a provider_profiles row");
    assert.equal(profile.is_approved, 0);
    assert.ok(wallet, "expected a provider_wallets row");
    assert.equal(wallet.balance_cents, 0);
    assert.equal(p.is_approved, false);
  });

  await t.test("/api/me is 401 without a token, 200 with one", async () => {
    const noAuth = await call(me.GET);
    assert.equal(noAuth.status, 401);

    const c = await registerCustomer({ name: "MeName" });
    const withAuth = await call(me.GET, { token: c.token });
    assert.equal(withAuth.status, 200);
    assert.equal(withAuth.body.role, "customer");
    assert.equal(withAuth.body.name, "MeName");
  });

  await t.test("a customer token on a provider-only route -> 403", async () => {
    const c = await registerCustomer();
    const res = await call(providerProfile.GET, { token: c.token });
    assert.equal(res.status, 403);
  });

  await t.test("a bad token -> 401", async () => {
    const res = await call(me.GET, { token: "garbage.token.here" });
    assert.equal(res.status, 401);
  });

  await t.test("malformed JSON body -> 400, not a crash", async () => {
    const c = await registerCustomer();
    const res = await call(customerLogin.POST, { method: "POST", body: '{"email": "oops"', token: c.token });
    assert.equal(res.status, 400);
  });
});
