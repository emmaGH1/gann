import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Application } from "../src/server/application";
import { readConfig, type Config } from "../src/server/config";
import { ApiError } from "../src/server/errors";
import type { Session } from "../src/server/model";
import { MemoryStore, RedisStore } from "../src/server/store";
import type { PaymentRecord } from "../src/server/payment-model";

const env = {
  NODE_ENV: "test",
  GANN_PUBLIC_ORIGIN: "https://gann.test",
  GANN_BROKER_KEY: "TEST_ONLY_BROKER_KEY_12345678901234567890",
  GANN_PAY_TO: `0x${"12".repeat(20)}`,
};
const fixture = (): Session => ({
  id: randomUUID(), revision: 0, createdAt: 1000, expiresAt: 86_401_000,
  agentLabel: "Test fixture", events: [], attempts: {}, deliveries: [],
});

test("production cannot use an absent persistence service or a memory store", () => {
  assert.throws(() => readConfig({ ...env, NODE_ENV: "production" }), /persistence_required/);
  assert.throws(() => new MemoryStore("production"), /persistence_required/);
  const config: Config = { ...readConfig(env), mode: "production" };
  assert.throws(() => new Application(config, new MemoryStore("test")), /persistence_required/);
});

test("configuration requires real server-owned key, origin, recipient and complete persistence credentials", () => {
  assert.throws(() => readConfig({ ...env, GANN_BROKER_KEY: "short" }), /configuration_required/);
  assert.throws(() => readConfig({ ...env, GANN_PAY_TO: `0x${"00".repeat(20)}` }), /configuration_required/);
  assert.throws(() => readConfig({ ...env, GANN_PAY_TO: "not-address" }), /configuration_required/);
  assert.throws(() => readConfig({ ...env, UPSTASH_REDIS_REST_URL: "https://store.upstash.io" }), /configuration_required/);
  assert.throws(() => readConfig({ ...env, UPSTASH_REDIS_REST_TOKEN: "TEST_ONLY" }), /configuration_required/);
  for (const origin of ["http://gann.test", "https://gann.test/path", "https://gann.test/?a=1", "https://gann.test/#x", "https://user:pass@gann.test", "https://gann.test:444", "https://localhost", "https://127.0.0.1", "https://[::1]"]) {
    assert.throws(() => readConfig({ ...env, GANN_PUBLIC_ORIGIN: origin }), /configuration_invalid/, origin);
  }
  assert.throws(() => readConfig({ ...env, GANN_ENABLE_PAYMENTS: "1" }), /configuration_invalid/);
  assert.equal(readConfig(env).enablePayments, false);
});

test("production with configured Redis is created lazily with no startup network", () => {
  const config = readConfig({ ...env, NODE_ENV: "production", UPSTASH_REDIS_REST_URL: "https://store.upstash.io", UPSTASH_REDIS_REST_TOKEN: "TEST_ONLY_REDIS_TOKEN" });
  let calls = 0;
  const neverFetch = (async () => { calls++; throw new Error("unexpected network"); }) as typeof fetch;
  new Application(config, new RedisStore(config.redis!, neverFetch), neverFetch);
  assert.equal(calls, 0);
});

test("memory CAS is copy-safe, revision checked and expiry does not extend", async () => {
  let clock = 1000;
  const store = new MemoryStore("test", () => clock);
  const initial = fixture();
  assert.equal(await store.create(initial), true);
  assert.equal(await store.create(initial), false);
  initial.agentLabel = "Outside mutation";
  assert.equal((await store.get(initial.id))!.agentLabel, "Test fixture");
  const first = (await store.get(initial.id))!;
  const second = (await store.get(initial.id))!;
  first.revision++;
  first.agentLabel = "Updated";
  assert.equal(await store.compareAndSwap(first, 0), true);
  assert.equal(await store.compareAndSwap(second, 0), false);
  assert.equal((await store.get(first.id))!.expiresAt, initial.expiresAt);
  clock = initial.expiresAt;
  assert.equal(await store.compareAndSwap({ ...first, revision: 2 }, 1), false);
});

test("Redis REST adapter sends atomic Lua CAS, absolute expiry and bounded authenticated requests", async () => {
  // This TEST-ONLY fake REST transport validates adapter command and CAS shape.
  // It is not an actual Redis instance and does not prove hosted Redis connectivity.
  const records = new Map<string, string>();
  const commands: (string | number)[][] = [];
  const transport = (async (input, init) => {
    assert.equal(input, "https://store.upstash.io");
    assert.equal(init!.method, "POST");
    assert.equal(init!.redirect, "error");
    assert.equal(init!.cache, "no-store");
    assert.ok(init!.signal);
    assert.equal(new Headers(init!.headers).get("authorization"), "Bearer TEST_ONLY_TOKEN");
    const args = JSON.parse(String(init!.body)) as (string | number)[];
    commands.push(args);
    let result: unknown;
    if (args[0] === "GET") result = records.get(String(args[1])) ?? null;
    else {
      assert.equal(args[0], "EVAL");
      assert.equal(args[2], 1);
      const script = String(args[1]);
      assert.match(script, /redis.call\('TIME'\)/);
      assert.match(script, /'PX', ttl/);
      const key = String(args[3]);
      if (script.includes("'NX'")) {
        assert.equal(args[5], 86_401_000);
        result = records.has(key) ? 0 : 1;
        if (result) records.set(key, String(args[4]));
      } else {
        assert.match(script, /decoded.revision ~= tonumber\(ARGV\[1\]\)/);
        assert.match(script, /decoded.expiresAt/);
        const record = records.get(key);
        result = record && JSON.parse(record).revision === args[4] ? 1 : 0;
        if (result) records.set(key, String(args[5]));
      }
    }
    return Response.json({ result });
  }) as typeof fetch;
  const store = new RedisStore({ url: "https://store.upstash.io", token: "TEST_ONLY_TOKEN" }, transport);
  const initial = fixture();
  assert.equal(await store.get(initial.id), null);
  assert.equal(await store.create(initial), true);
  assert.equal(await store.create(initial), false);
  assert.deepEqual(await store.get(initial.id), initial);
  const updated = { ...initial, revision: 1, agentLabel: "Updated" };
  assert.equal(await store.compareAndSwap(updated, 0), true);
  assert.equal(await store.compareAndSwap(initial, 0), false);
  assert.deepEqual(await store.get(initial.id), updated);
  assert.equal(commands.length, 7);
  assert.equal(commands.every((command) => !JSON.stringify(command).includes("TEST_ONLY_TOKEN")), true);
});

const paymentFixture = (): PaymentRecord => ({
  id: "a".repeat(64), order: "b".repeat(64), digest: "c".repeat(64),
  resource: "https://gann.test/api/s/signal?session=test&attempt=test", session: randomUUID(), attempt: randomUUID(),
  version: 2, network: "eip155:8453", asset: `0x${"12".repeat(20)}`, payTo: `0x${"12".repeat(20)}`, amount: "10000",
  payer: `0x${"34".repeat(20)}`, nonce: `0x${"56".repeat(32)}`,
  validBefore: 61000, expiresAt: 2_678_401_000, revision: 0, owner: randomUUID(), leaseUntil: 11000,
  settlementEligible: false, state: "processing",
});

test("memory payment claim is atomic across global authorization and order namespaces; only one owner confirms", async () => {
  const store = new MemoryStore("test", () => 1000);
  const p = paymentFixture();
  const results = await Promise.all([store.claimPayment(p), store.claimPayment(p)]);
  assert.deepEqual(results, [true, false]);
  assert.equal(await store.claimPayment({ ...p, order: "d".repeat(64), session: randomUUID() }), false);
  assert.equal(await store.claimPayment({ ...p, id: "e".repeat(64) }), false);
  const replacement = { ...p, revision: 1, owner: randomUUID(), leaseUntil: 66000 };
  assert.equal(await store.reclaimPayment(replacement, 0, 10000), false);
  assert.equal(await store.reclaimPayment(replacement, 0, 11000), true);
  const eligible = { ...replacement, revision: 2, settlementEligible: true };
  assert.equal(await store.markSettlementEligible(eligible, 1), true);
  const confirmed = { ...eligible, revision: 3, state: "confirmed" as const, code: "PRIVATE_OFFLINE_FIXTURE" };
  assert.equal(await store.confirmPayment({ ...confirmed, owner: "not-the-owner" }, 2), false);
  assert.equal(await store.confirmPayment(confirmed, 3), false);
  assert.equal(await store.confirmPayment(confirmed, 2), true);
  assert.equal(await store.confirmPayment({ ...confirmed, code: "changed" }, 2), false);
  const copy = (await store.getPayment(p.id))!;
  copy.code = "outside mutation";
  assert.equal((await store.getPayment(p.id))!.code, "PRIVATE_OFFLINE_FIXTURE");
  assert.equal((await store.getOrderPayments([p.order]))[0]!.code, "PRIVATE_OFFLINE_FIXTURE");
});

test("Redis payment commands atomically claim TWO same-slot keys, preserve payment TTL, CAS owner/order/digest and batch-read ledger", async () => {
  // Command-shape only: no real Redis or Lua execution is claimed.
  const p = paymentFixture();
  const reclaimed = { ...p, revision: 1, owner: randomUUID(), leaseUntil: 66000 };
  const eligible = { ...reclaimed, revision: 2, settlementEligible: true };
  const confirmed = { ...eligible, revision: 3, state: "confirmed" as const, code: "PRIVATE_OFFLINE_FIXTURE" };
  const commands: (string | number)[][] = [];
  const transport = (async (_url, init) => {
    const args = JSON.parse(String(init!.body)) as (string | number)[];
    commands.push(args);
    let result: unknown = 1;
    if (args[0] === "GET") result = JSON.stringify(confirmed);
    if (args[0] === "MGET") {
      result = String(args[1]).includes(":order:") ? [p.id, null] : [JSON.stringify(confirmed)];
    }
    return Response.json({ result });
  }) as typeof fetch;
  const store = new RedisStore({ url: "https://store.upstash.io", token: "TEST_ONLY_TOKEN" }, transport);
  assert.equal(await store.claimPayment(p), true);
  const claim = commands[0];
  assert.equal(claim[0], "EVAL"); assert.equal(claim[2], 2);
  assert.equal(claim[3], `gann:v1:{payments}:authorization:${p.id}`);
  assert.equal(claim[4], `gann:v1:{payments}:order:${p.order}`);
  assert.equal(claim[7], p.id);
  assert.equal(claim[6], p.expiresAt);
  assert.ok(Number(claim[6]) > fixture().expiresAt);
  assert.match(String(claim[1]), /redis.call\('EXISTS', KEYS\[1\]\).*redis.call\('EXISTS', KEYS\[2\]\)/);
  assert.match(String(claim[1]), /redis.call\('SET', KEYS\[2\], ARGV\[3\], 'PX', ttl\)/);
  assert.equal(await store.reclaimPayment(reclaimed, 0, 11000), true);
  const reclaim = commands[1];
  assert.equal(reclaim[0], "EVAL"); assert.equal(reclaim[2], 2);
  assert.equal(reclaim[7], p.id); assert.equal(reclaim[8], 11000);
  assert.match(String(reclaim[1]), /decoded.leaseUntil > now/);
  assert.match(String(reclaim[1]), /decoded.digest ~= replacement.digest/);
  assert.match(String(reclaim[1]), /redis.call\('SET', KEYS\[1\], ARGV\[2\], 'PX', ttl\)/);
  assert.equal(await store.markSettlementEligible(eligible, 1), true);
  const mark = commands[2];
  assert.equal(mark[0], "EVAL"); assert.match(String(mark[1]), /decoded.settlementEligible ~= false/);
  assert.equal(await store.confirmPayment(confirmed, 2), true);
  const cas = commands[3];
  assert.equal(cas[2], 1); assert.equal(cas[4], 2);
  assert.match(String(cas[1]), /decoded.owner ~= replacement.owner/);
  assert.match(String(cas[1]), /decoded.order ~= replacement.order/);
  assert.match(String(cas[1]), /decoded.digest ~= replacement.digest/);
  assert.match(String(cas[1]), /decoded.state ~= 'processing'/);
  assert.match(String(cas[1]), /decoded.expiresAt/);
  assert.equal((await store.getPayment(p.id))!.code, confirmed.code);
  const records = await store.getOrderPayments([p.order, "f".repeat(64)]);
  assert.deepEqual(records, [confirmed, null]);
  assert.equal(commands[4][0], "GET");
  assert.equal(commands[5][0], "MGET"); assert.equal(commands[6][0], "MGET");
  assert.equal(JSON.stringify(commands).includes("signature"), false);
});

test("Redis payment corruption or orphaned indexes cannot silently permit a fresh payment", async () => {
  for (const result of [["bad-key"], [null, null], ["a".repeat(64)]]) {
    const transport = (async () => Response.json({ result })) as typeof fetch;
    const store = new RedisStore({ url: "https://store.upstash.io", token: "TEST_ONLY_TOKEN" }, transport);
    await assert.rejects(store.getOrderPayments(["b".repeat(64)]));
  }
});

test("Redis failure/corruption fails closed and does not expose tokens or upstream bodies", async () => {
  const transports = [
    (async () => { throw new Error("TEST_ONLY_TOKEN_AND_UPSTREAM_SECRET"); }) as typeof fetch,
    (async () => new Response("TEST_ONLY_SECRET", { status: 500 })) as typeof fetch,
    (async () => Response.json({ error: "TEST_ONLY_SECRET" })) as typeof fetch,
    (async () => Response.json({ result: "{corrupt" })) as typeof fetch,
    (async () => Response.json({ result: '{}' })) as typeof fetch,
  ];
  for (const transport of transports) {
    const store = new RedisStore({ url: "https://store.upstash.io", token: "TEST_ONLY_TOKEN" }, transport);
    await assert.rejects(store.get(randomUUID()), (error) => error instanceof ApiError && error.message === "service_unavailable" && error.status === 503);
  }
});
