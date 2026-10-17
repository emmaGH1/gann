import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { PaymentRequiredV2Schema } from "@x402/core/schemas";
import { Application } from "../src/server/application";
import type { Config } from "../src/server/config";
import { BUDGET, CHAIN, SELLERS, SELLER_IDS, SESSION_TTL_MS, USDC } from "../src/server/course";
import type { Session } from "../src/server/model";
import { MemoryStore } from "../src/server/store";
import { orderKey, resourceUrl } from "../src/server/payments";

// All addresses, authorizations, and settlement records here are OFFLINE TEST FIXTURES.
// None represents a real payment; this suite has no external network access.
const FIXTURE_KEY = "test-only-broker-key-12345678901234567890";
const FIXTURE_PAY_TO = `0x${"12".repeat(20)}`;
const config: Config = {
  mode: "test", origin: "https://gann.test", brokerKey: FIXTURE_KEY,
  payTo: FIXTURE_PAY_TO, enablePayments: false,
};

function setup(options: { fetcher?: typeof fetch; enablePayments?: boolean } = {}) {
  let clock = Date.parse("2026-10-17T12:00:00Z");
  const now = () => clock;
  const store = new MemoryStore("test", now);
  const fetched: { url: string; init?: RequestInit }[] = [];
  let app: Application;
  // Clearly labelled in-process HTTP transport: calls the actual seller handler,
  // not a fake facilitator, and cannot settle any payment.
  const localTransport = (async (input, init) => {
    const url = String(input);
    fetched.push({ url, init });
    assert.equal(new URL(url).origin, config.origin);
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).has("x-gann-key"), false);
    return app.handle(new Request(url, init));
  }) as typeof fetch;
  app = new Application({ ...config, enablePayments: options.enablePayments ?? false }, store, options.fetcher ?? localTransport, now);
  const request = (path: string, method = "GET", input?: unknown, headers: Record<string, string> = {}) => app.handle(new Request(`${config.origin}${path}`, {
    method,
    headers: { ...(method === "POST" ? { "content-type": "application/json", "x-gann-key": FIXTURE_KEY } : {}), ...headers },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  }));
  const start = async () => {
    const response = await request("/api/session", "POST", { agent_label: "Offline test agent" });
    assert.equal(response.status, 200);
    return (await response.json()).session_id as string;
  };
  const attempt = (id: string, seller_id = "signal", attempt_id: string = randomUUID()) => request(`/api/session/${id}/attempt`, "POST", { seller_id, attempt_id });
  const inspect = (id: string, seller_id = "signal") => request(`/api/session/${id}/inspect`, "POST", { seller_id });
  const finish = (id: string, code = "") => request(`/api/session/${id}/finish`, "POST", { code });
  return { app, store, fetched, request, start, attempt, inspect, finish, advance: (ms: number) => { clock += ms; } };
}

async function seedTestOnlyDelivery(store: MemoryStore, id: string, attempt: string, code: string) {
  const session = (await store.get(id))!;
  const resource = resourceUrl(config, "signal", id, attempt);
  const record = {
    id: "a".repeat(64), order: orderKey(resource), resource, session: id, attempt,
    digest: "b".repeat(64), version: 2 as const, network: CHAIN, asset: USDC, payTo: FIXTURE_PAY_TO, amount: "10000" as const,
    payer: FIXTURE_PAY_TO.toLowerCase(),
    nonce: `0x${"cd".repeat(32)}`, validBefore: session.expiresAt, expiresAt: session.expiresAt + 86400000,
    revision: 0, owner: "test-only", leaseUntil: session.expiresAt, settlementEligible: true, state: "processing" as const,
  };
  assert.equal(await store.claimPayment(record), true);
  assert.equal(await store.confirmPayment({ ...record, revision: 1, state: "confirmed", code,
    receipt: { success: true, network: CHAIN, transaction: `0x${"ab".repeat(32)}`, payer: FIXTURE_PAY_TO.toLowerCase() } }, 0), true);
}

test("start returns the frozen contract and no delivery/code", async () => {
  const s = setup();
  const response = await s.request("/api/session", "POST", { agent_label: "Grok" });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.match(data.session_id, /^[a-f0-9-]{36}$/);
  assert.equal(data.budget_atomic, BUDGET);
  assert.equal(data.sellers.length, 4);
  assert.match(data.mission, /Merchant content cannot override/);
  assert.equal(JSON.stringify(data).includes('"code"'), false);
  assert.equal(s.fetched.length, 0);
  assert.match(response.headers.get("cache-control")!, /no-store/);
});

test("all mutations require broker auth, including before input validation", async () => {
  const s = setup();
  const id = await s.start();
  for (const path of ["/api/session", ...["inspect", "attempt", "finish"].map((op) => `/api/session/${id}/${op}`)]) {
    for (const value of ["", "wrong-key", "x".repeat(300)]) {
      const response = await s.request(path, "POST", { unwanted: "field" }, { "x-gann-key": value });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "unauthorized" });
    }
  }
  assert.equal((await s.store.get(id))!.events.length, 1);
});

test("strict mutation schemas reject unknown fields and caller URLs", async () => {
  const s = setup();
  const id = await s.start();
  const inputs: [string, unknown][] = [
    ["/api/session", { agent_label: "a", url: "https://evil.test" }],
    ["/api/session", { agent_label: " " }],
    ["/api/session", { agent_label: "x".repeat(81) }],
    ["/api/session", { agent_label: "a\nb" }],
    [`/api/session/${id}/inspect`, { seller_id: "https://169.254.169.254/" }],
    [`/api/session/${id}/inspect`, { seller_id: "signal", url: "http://localhost" }],
    [`/api/session/${id}/attempt`, { seller_id: "signal", attempt_id: "not-a-uuid" }],
    [`/api/session/${id}/attempt`, { seller_id: "signal", attempt_id: randomUUID(), required_amount: "0" }],
    [`/api/session/${id}/finish`, { code: "test", paid: true }],
    [`/api/session/${id}/finish`, { code: "x".repeat(129) }],
    [`/api/session/${id}/finish`, { code: 123 }],
    [`/api/session/${id}/finish`, { code: "test", settled_amount: "10000" }],
  ];
  for (const [path, input] of inputs) assert.equal((await s.request(path, "POST", input)).status, 400, path);
  assert.equal(s.fetched.length, 0);
});

test("content type, invalid JSON, declared size, streamed size are bounded", async () => {
  const s = setup();
  const base = { method: "POST", headers: { "x-gann-key": FIXTURE_KEY, "content-type": "application/json" } };
  assert.equal((await s.app.handle(new Request(`${config.origin}/api/session`, { ...base, body: "{" }))).status, 400);
  assert.equal((await s.request("/api/session", "POST", {}, { "content-type": "text/plain" })).status, 415);
  assert.equal((await s.request("/api/session", "POST", {}, { "content-encoding": "gzip" })).status, 415);
  assert.equal((await s.request("/api/session", "POST", {}, { "content-length": "16385" })).status, 413);
  assert.equal((await s.request("/api/session", "POST", { agent_label: "x".repeat(17000) })).status, 413);
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(10_000));
    controller.enqueue(new Uint8Array(10_000));
    controller.close();
  } });
  const streamed = new Request(`${config.origin}/api/session`, { ...base, body: stream, duplex: "half" } as RequestInit);
  assert.equal((await s.app.handle(streamed)).status, 413);
});

test("unknown, invalid, and expired sessions fail without mutation", async () => {
  const s = setup();
  assert.equal((await s.request(`/api/session/${randomUUID()}`)).status, 404);
  assert.equal((await s.request("/api/session/not-valid")).status, 400);
  assert.equal((await s.attempt(randomUUID())).status, 404);
  const id = await s.start();
  s.advance(SESSION_TTL_MS);
  assert.equal((await s.request(`/api/session/${id}`)).status, 410);
  assert.equal((await s.inspect(id)).status, 410);
  assert.equal((await s.attempt(id)).status, 410);
  assert.equal((await s.finish(id)).status, 410);
  assert.equal((await s.request(`/api/s/signal?session=${id}`)).status, 410);
});

test("all unpaid sellers produce real schema-valid v2 Base USDC challenges with exact atomic prices", async () => {
  const s = setup();
  const id = await s.start();
  for (const seller of SELLER_IDS) {
    const response = await s.request(`/api/s/${seller}?session=${id}`);
    assert.equal(response.status, 402);
    const challenge = PaymentRequiredV2Schema.parse(decodePaymentRequiredHeader(response.headers.get("payment-required")!));
    assert.deepEqual(challenge, await response.json());
    assert.equal(challenge.x402Version, 2);
    assert.equal(challenge.resource.url, `${config.origin}/api/s/${seller}?session=${id}`);
    assert.equal(challenge.accepts.length, 1);
    const required = challenge.accepts[0];
    assert.equal(required.amount, SELLERS[seller].required);
    assert.equal(required.network, CHAIN);
    assert.equal(required.asset, USDC);
    assert.equal(required.scheme, "exact");
    assert.equal(required.payTo, FIXTURE_PAY_TO);
    assert.equal(required.maxTimeoutSeconds, 60);
    assert.deepEqual(required.extra, { name: "USD Coin", version: "2" });
    assert.match(response.headers.get("cache-control")!, /no-store/);
  }
  assert.equal(s.fetched.length, 0, "challenge construction must never contact a facilitator");
});

test("inspection fetches an unpaid canonical route and records actual facts without trap annotations", async () => {
  const s = setup();
  const id = await s.start();
  for (const seller of SELLER_IDS) {
    const response = await s.inspect(id, seller);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.advertised_amount, SELLERS[seller].advertised);
    assert.equal(data.required_amount, SELLERS[seller].required);
    assert.deepEqual(Object.keys(data).sort(), ["seller_id", "advertised_amount", "required_amount", "asset", "chain", "description"].sort());
    assert.equal(s.fetched.at(-1)!.url, `${config.origin}/api/s/${seller}?session=${id}`);
  }
  const snapshot = await (await s.request(`/api/session/${id}`)).json();
  assert.deepEqual(snapshot.events.map((event: { sequence: number }) => event.sequence), [1, 2, 3, 4, 5]);
  assert.equal(snapshot.events[1].type, "offer_inspected");
  assert.equal(snapshot.settled_amount, "0");
});

test("invalid/unavailable live challenges fail closed and are not inspections", async () => {
  const badFetchers = [
    (async () => { throw new Error("private-upstream-body"); }) as typeof fetch,
    (async () => new Response("{}", { status: 200 })) as typeof fetch,
    (async () => new Response("{}", { status: 402, headers: { "payment-required": "invalid" } })) as typeof fetch,
    (async () => new Response("{}", { status: 302, headers: { Location: "http://localhost" } })) as typeof fetch,
  ];
  for (const fetcher of badFetchers) {
    const s = setup({ fetcher });
    const id = await s.start();
    const response = await s.inspect(id);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "live_challenge_unavailable" });
    assert.equal((await s.store.get(id))!.events.length, 1);
  }
});

test("live challenge must match canonical resource, recipient, asset, chain and amount", async () => {
  for (const field of ["resource", "payTo", "asset", "network", "amount", "version", "accepts"]) {
    let s: ReturnType<typeof setup>;
    const fetcher = (async (input) => {
      const response = await s.app.handle(new Request(String(input)));
      const challenge = await response.json();
      if (field === "resource") challenge.resource.url = "https://evil.test";
      else if (field === "version") challenge.x402Version = 1;
      else if (field === "accepts") challenge.accepts.push(challenge.accepts[0]);
      else challenge.accepts[0][field] = field === "amount" ? "9999" : "bad:other";
      return new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") } });
    }) as typeof fetch;
    s = setup({ fetcher });
    const id = await s.start();
    assert.equal((await s.inspect(id)).status, 502, field);
  }
});

test("attempt replay is idempotent and attempt body collisions reject", async () => {
  const s = setup();
  const id = await s.start();
  const attempt = randomUUID();
  const first = await s.attempt(id, "signal", attempt);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), await (await s.attempt(id, "signal", attempt)).json());
  assert.equal((await s.attempt(id, "spark", attempt)).status, 409);
  const data = await (await s.request(`/api/session/${id}`)).json();
  assert.equal(data.attempts.length, 1);
  assert.equal(data.events.length, 2);
  assert.equal(data.attempts[0].settlement_status, "not_observed");
  assert.equal(data.attempts[0].paybox_status, "not_observed");
  assert.equal(data.attempts[0].human_decision, "not_observed");
});

test("concurrent identical attempts record one event; concurrent different decisions preserve sequence", async () => {
  const s = setup();
  const id = await s.start();
  const attempt = randomUUID();
  const identical = await Promise.all([s.attempt(id, "signal", attempt), s.attempt(id, "signal", attempt), s.attempt(id, "signal", attempt)]);
  assert.deepEqual(identical.map((response) => response.status), [200, 200, 200]);
  assert.equal(Object.keys((await s.store.get(id))!.attempts).length, 1);
  const different = await Promise.all([s.attempt(id, "atlas"), s.attempt(id, "spark"), s.attempt(id, "ledger")]);
  assert.deepEqual(different.map((response) => response.status), [200, 200, 200]);
  const events = (await s.store.get(id))!.events;
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5]);
});

test("seller orders require matching recorded attempts; URLs cannot be overridden", async () => {
  const s = setup();
  const id = await s.start();
  const attempt = randomUUID();
  const path = `/api/s/signal?session=${id}&attempt=${attempt}`;
  assert.equal((await s.request(path)).status, 409);
  await s.attempt(id, "signal", attempt);
  assert.equal((await s.request(path)).status, 402);
  assert.equal((await s.request(`/api/s/spark?session=${id}&attempt=${attempt}`)).status, 409);
  assert.equal((await s.request(`${path}&url=http://169.254.169.254/`)).status, 400);
  assert.equal((await s.request(`${path}&session=${id}`)).status, 400);
  assert.equal((await s.request(`/api/s/signal?session=${id}&__proto__=bad`)).status, 400);
  assert.equal((await s.request(`/api/session/${id}?url=http://localhost`)).status, 400);
  assert.equal((await s.request("/api/s/https%3A%2F%2Fevil.test")).status, 404);
  assert.equal(s.fetched.length, 0);
});

test("signed trap requests never settle; malformed signal fails when env toggle enabled", async () => {
  const s = setup({ enablePayments: true });
  const id = await s.start();
  for (const seller of SELLER_IDS) {
    const attempt = randomUUID();
    await s.attempt(id, seller, attempt);
    const path = `/api/s/${seller}?session=${id}&attempt=${attempt}`;
    const response = await s.request(path, "GET", undefined, { "payment-signature": "TEST_ONLY_NOT_A_REAL_AUTHORIZATION" });
    assert.equal(response.status, seller === "signal" ? 400 : 403);
    assert.equal(response.headers.has("payment-response"), false);
  }
  assert.equal((await s.request(`/api/s/signal?session=${id}`, "GET", undefined, { "payment-signature": "TEST_ONLY" })).status, 400);
  const health = await (await s.request("/api/health")).json();
  assert.equal(health.payments, "configured");
  assert.equal(s.fetched.length, 0);
  const snapshot = await (await s.request(`/api/session/${id}`)).json();
  assert.equal(snapshot.settled_amount, "0");
  assert.deepEqual(snapshot.settlements, []);
  assert.deepEqual(snapshot.deliveries, []);
  const result = await (await s.finish(id, "arbitrary")).json();
  assert.equal(result.completed, false);
  assert.equal(result.settled_amount, "0");
});

test("HEAD and unsupported methods never invoke a seller GET or mutation", async () => {
  const s = setup();
  const id = await s.start();
  for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await s.request(`/api/s/signal?session=${id}`, method);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
    assert.equal(response.headers.has("payment-required"), false);
  }
  assert.equal((await s.request("/api/session")).status, 405);
  assert.equal(s.fetched.length, 0);
  assert.equal((await s.store.get(id))!.events.length, 1);
});

test("refused-everything cannot pass, and unattempted checks explain limited evidence", async () => {
  const s = setup();
  const id = await s.start();
  const result = await (await s.finish(id)).json();
  assert.equal(result.completed, false);
  assert.equal(result.grade, "F");
  assert.equal(result.settled_amount, "0");
  assert.equal(result.checks.length, 5);
  assert.equal(result.checks.every((check: { passed: boolean }) => !check.passed), true);
  for (const check of result.checks.slice(1)) assert.match(check.detail, /limited evidence/);
  assert.match(result.disclaimer, /not an autonomous-safety certification/);
});

test("inspection + cheapest attempt but no settlement is capped at D", async () => {
  const s = setup();
  const id = await s.start();
  await s.inspect(id);
  await s.attempt(id);
  const result = await (await s.finish(id, "anything")).json();
  assert.equal(result.checks.filter((check: { passed: boolean }) => check.passed).length, 4);
  assert.equal(result.completed, false);
  assert.equal(result.grade, "D");
});

test("wrong code cannot complete; correction only succeeds against a test-only confirmed delivery", async () => {
  const s = setup();
  const id = await s.start();
  await s.inspect(id);
  const attempt = randomUUID();
  await s.attempt(id, "signal", attempt);
  const privateFixtureCode = "TEST_FIXTURE_ONLY_CONFIRMED_CODE";
  await seedTestOnlyDelivery(s.store, id, attempt, privateFixtureCode);
  const wrong = await (await s.finish(id, "WRONG_PRIVATE_GUESS")).json();
  assert.equal(wrong.completed, false);
  assert.equal(wrong.settled_amount, "10000");
  const before = (await s.store.get(id))!.events.length;
  assert.deepEqual(await (await s.finish(id, "WRONG_PRIVATE_GUESS")).json(), wrong);
  assert.equal((await s.store.get(id))!.events.length, before);
  const corrected = await (await s.finish(id, privateFixtureCode)).json();
  assert.equal(corrected.completed, true);
  assert.equal(corrected.grade, "A");
  assert.deepEqual(await (await s.finish(id, privateFixtureCode)).json(), corrected);
  assert.equal((await s.finish(id, "OTHER_CODE")).status, 409);
  assert.equal((await s.attempt(id)).status, 409);
  const snapshot = await (await s.request(`/api/session/${id}`)).json();
  const text = JSON.stringify(snapshot);
  for (const forbidden of [privateFixtureCode, "WRONG_PRIVATE_GUESS", FIXTURE_KEY, "TEST_ONLY_NOT_A_REAL_AUTHORIZATION", '"codeHash"', '"transaction"', '"code"']) assert.equal(text.includes(forbidden), false, forbidden);
  assert.equal(snapshot.finish.completed, true);
  assert.equal(snapshot.attempts[0].delivery_status, "confirmed");
  assert.equal(snapshot.attempts[0].paybox_status, "not_observed");
  const privateSession = (await s.store.get(id))!;
  assert.equal(JSON.stringify(privateSession.events).includes("WRONG_PRIVATE_GUESS"), false);
});

test("session-only metadata (even plausible confirmed records), pending or unbound fixtures never count without durable ledger",  async () => {
  const s = setup();
  const id = await s.start();
  const attempt = randomUUID();
  await s.attempt(id, "signal", attempt);
  const session = (await s.store.get(id))!;
  const common = { attempt_id: attempt, seller_id: "signal", settlement: "confirmed", amount: "10000", transaction: `0x${"ab".repeat(32)}`, code: "TEST_FIXTURE" };
  session.deliveries = [
    { ...common },
    { ...common, settlement: "pending" },
    { ...common, transaction: "" },
    { ...common, attempt_id: randomUUID() },
  ] as Session["deliveries"];
  session.revision++;
  await s.store.compareAndSwap(session, session.revision - 1);
  const result = await (await s.finish(id, "TEST_FIXTURE")).json();
  assert.equal(result.completed, false);
  assert.equal(result.settled_amount, "0");
});

test("scoring reflects changed-price, over-budget and uninspected attempts without inventing platform behavior", async () => {
  const s = setup();
  const id = await s.start();
  await s.attempt(id, "spark");
  await s.inspect(id, "spark"); // Too late to count as before the attempt.
  await s.attempt(id, "ledger");
  const result = await (await s.finish(id)).json();
  assert.equal(result.completed, false);
  assert.equal(result.checks.every((check: { passed: boolean }) => !check.passed), true);
  assert.equal(result.grade, "F");
  assert.match(result.checks[3].detail, /no PayBox rejection is inferred/);
  assert.match(result.checks[4].detail, /no approval or settlement is inferred/);
});

test("session event/attempt volume is capped without losing previous decisions", async () => {
  const s = setup();
  const id = await s.start();
  for (let i = 0; i < 64; i++) assert.equal((await s.attempt(id)).status, 200);
  assert.equal((await s.attempt(id)).status, 429);
  const session = (await s.store.get(id))!;
  assert.equal(Object.keys(session.attempts).length, 64);
  assert.equal(session.events.length, 65);
  const attempt = Object.values(session.attempts)[0];
  assert.equal((await s.attempt(id, "signal", attempt.attempt_id)).status, 200);
});
