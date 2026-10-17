import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { Application } from "../src/server/application";
import type { Config } from "../src/server/config";
import { CHAIN, USDC } from "../src/server/course";
import { payAIFacilitator, type Facilitator } from "../src/server/facilitator";
import type { PaymentRecord } from "../src/server/payment-model";
import { orderKey } from "../src/server/payments";
import { MemoryStore } from "../src/server/store";

// Entire suite is offline. Addresses, signatures and transaction hashes are ONLY
// fixtures; injected verification is NOT cryptographic or actual payment evidence.
const payer = `0x${"34".repeat(20)}`;
const tx = `0x${"ab".repeat(32)}`;
const clock = Date.parse("2026-10-17T12:00:00Z");
const config: Config = { mode: "test", origin: "https://gann.test", payTo: `0x${"12".repeat(20)}`,
  brokerKey: "OFFLINE_TEST_BROKER_KEY_12345678901234567890", enablePayments: true };
class FakeFacilitator implements Facilitator {
  verifies = 0;
  settles = 0;
  settlementKeys: string[] = [];
  verifyResult: VerifyResponse = { isValid: true, payer };
  settleResult: SettleResponse = { success: true, payer, transaction: tx, network: CHAIN };
  onVerify?: () => Promise<VerifyResponse>;
  onSettle?: () => Promise<SettleResponse>;
  async verify(_payload: PaymentPayload, requirements: PaymentRequirements) {
    this.verifies++;
    assert.equal(requirements.payTo, config.payTo);
    assert.equal(requirements.amount, "10000");
    assert.equal(requirements.network, CHAIN);
    assert.equal(requirements.asset, USDC);
    const authorization = (_payload.payload as { authorization: { validAfter: string; validBefore: string } }).authorization;
    const validAfter = Number(authorization.validAfter) * 1000;
    const validBefore = Number(authorization.validBefore) * 1000;
    if (validAfter > clock || validBefore <= clock) return { isValid: false };
    return this.onVerify ? this.onVerify() : this.verifyResult;
  }
  async settle(_payload: PaymentPayload, requirements: PaymentRequirements, idempotencyKey: string) {
    this.settles++;
    this.settlementKeys.push(idempotencyKey);
    assert.match(idempotencyKey, /^[a-f0-9]{64}$/);
    assert.equal(requirements.payTo, config.payTo);
    return this.onSettle ? this.onSettle() : this.settleResult;
  }
}
function setup(store = new MemoryStore("test", () => clock), enabled = true) {
  const facilitator = new FakeFacilitator();
  let time = clock;
  const app = new Application({ ...config, enablePayments: enabled }, store,
    (async () => { throw new Error("NO NETWORK PERMITTED"); }) as typeof fetch, () => time, facilitator);
  const request = (path: string, input?: unknown, headers: Record<string, string> = {}) => app.handle(new Request(`${config.origin}${path}`, {
    method: input === undefined ? "GET" : "POST",
    headers: { ...(input === undefined ? {} : { "content-type": "application/json", "x-gann-key": config.brokerKey }), ...headers },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  }));
  async function order(seller = "signal", session?: string) {
    const id = session ?? (await (await request("/api/session", { agent_label: "Offline payment fixture" })).json()).session_id;
    const attempt = randomUUID();
    assert.equal((await request(`/api/session/${id}/attempt`, { seller_id: seller, attempt_id: attempt })).status, 200);
    const path = `/api/s/${seller}?session=${id}&attempt=${attempt}`;
    const challenge = decodePaymentRequiredHeader((await request(path)).headers.get("payment-required")!);
    const payload: PaymentPayload = { x402Version: 2, resource: challenge.resource, accepted: challenge.accepts[0],
      payload: { signature: `0x${"cd".repeat(65)}`, authorization: { from: payer, to: config.payTo, value: "10000",
        validAfter: String(clock / 1000 - 1), validBefore: String(clock / 1000 + 60), nonce: `0x${randomUUID().replaceAll("-", "").repeat(2)}` } } };
    return { id, attempt, path, payload, resource: challenge.resource.url };
  }
  const pay = (o: Awaited<ReturnType<typeof order>>, payload = o.payload, extra: Record<string, string> = {}) => request(o.path, undefined,
    { "payment-signature": encodePaymentSignatureHeader(payload), ...extra });
  return { request, order, pay, store, facilitator, advance: (ms: number) => { time += ms; } };
}

test("confirmed settlement -> one private durable delivery -> matching-code finish; identical replay recovers receipt/code", async () => {
  const s = setup();
  const o = await s.order();
  const response = await s.pay(o);
  assert.equal(response.status, 200);
  const { code } = await response.json();
  assert.equal(typeof code, "string");
  const receipt = decodePaymentResponseHeader(response.headers.get("payment-response")!);
  assert.equal(receipt.success, true);
  assert.equal(receipt.network, CHAIN);
  assert.equal(receipt.transaction, tx);
  assert.equal(response.headers.has("x-payment-response"), false);
  const [record] = await s.store.getOrderPayments([orderKey(o.resource)]);
  assert.equal(record!.code, code);
  assert.equal(record!.state, "confirmed");
  assert.ok(record!.expiresAt >= record!.validBefore + 30 * 86400000);
  assert.equal(JSON.stringify(record).includes("signature"), false);
  assert.equal(JSON.stringify(record).includes("payload"), false);
  const retry = await s.pay(o);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).code, code);
  assert.equal(s.facilitator.verifies, 1);
  assert.equal(s.facilitator.settles, 1);
  assert.equal((await (await s.request(`/api/session/${o.id}/finish`, { code: "wrong" })).json()).completed, false);
  const finish = await (await s.request(`/api/session/${o.id}/finish`, { code })).json();
  assert.equal(finish.completed, true);
  assert.equal(finish.settled_amount, "10000");
  const viewer = await (await s.request(`/api/session/${o.id}`)).json();
  assert.equal(viewer.deliveries.length, 1);
  assert.equal(viewer.settled_amount, "10000");
  const publicText = JSON.stringify(viewer);
  assert.equal(publicText.includes(code), false);
  assert.equal(publicText.includes(record!.nonce), false);
  assert.equal(publicText.includes(record!.digest), false);
  // Completed sessions can still recover the original delivery, never pay anew.
  assert.equal((await s.pay(o)).status, 200);
  assert.equal((await s.request(o.path)).status, 202);
});

test("expired authorization/lease retries recover confirmed delivery or remain pending, never reacquire a settling lease", async () => {
  for (const confirmed of [true, false]) {
    const s = setup(); const o = await s.order();
    if (!confirmed) s.facilitator.onSettle = async () => { throw new Error("fixture process/transport loss"); };
    const first = await s.pay(o);
    const code = confirmed ? (await first.json()).code : undefined;
    s.advance(61_000); // Beyond original authorization AND lease, but session still open.
    const retry = await s.pay(o);
    assert.equal(retry.status, confirmed ? 200 : 202);
    if (confirmed) assert.equal((await retry.json()).code, code);
    assert.equal(s.facilitator.verifies, 1);
    assert.equal(s.facilitator.settles, confirmed ? 1 : 4);
  }
});

test("durable original-order recovery survives session expiry/eviction; unavailable sessions cannot start payments", async () => {
  class EvictableStore extends MemoryStore {
    evicted = false;
    override async get(id: string) { return this.evicted ? null : super.get(id); }
  }
  for (const confirmed of [true, false]) {
    const store = new EvictableStore("test", () => clock);
    const s = setup(store); const o = await s.order();
    if (!confirmed) s.facilitator.onSettle = async () => { throw new Error("fixture uncertain original"); };
    const first = await s.pay(o);
    const code = confirmed ? (await first.json()).code : undefined;
    s.advance(24 * 60 * 60 * 1000 + 1);
    for (const evicted of [false, true]) {
      store.evicted = evicted;
      const response = await s.pay(o);
      assert.equal(response.status, confirmed ? 200 : 202);
      if (confirmed) assert.equal((await response.json()).code, code);
      assert.equal((await s.request(o.path)).status, 202);
    }
    assert.equal(s.facilitator.verifies, 1);
    assert.equal(s.facilitator.settles, confirmed ? 1 : 4);
  }
  const store = new EvictableStore("test", () => clock);
  const s = setup(store); const o = await s.order(); store.evicted = true;
  assert.equal((await s.pay(o)).status, 410);
  assert.equal(s.facilitator.verifies, 0);
  assert.equal(s.facilitator.settles, 0);
});

test("settlement timeout is reconciled by PayAI's identical-body idempotency before any new authorization", async () => {
  const s = setup(); const o = await s.order();
  let calls = 0;
  s.facilitator.onSettle = async () => {
    calls++;
    if (calls === 1) throw new Error("offline fixture: response lost after unknown settlement result");
    return s.facilitator.settleResult;
  };
  const response = await s.pay(o);
  assert.equal(response.status, 200);
  const code = (await response.json()).code;
  assert.equal(typeof code, "string");
  assert.equal(s.facilitator.verifies, 1);
  assert.equal(s.facilitator.settles, 2);
  assert.equal(s.facilitator.settlementKeys[0], s.facilitator.settlementKeys[1]);
  const finish = await (await s.request(`/api/session/${o.id}/finish`, { code })).json();
  assert.equal(finish.completed, true);
  assert.equal(finish.grade, "B");
});

test("pending settlement blocks finalization until reconciliation completes", async () => {
  const s = setup(); const o = await s.order();
  s.facilitator.onSettle = async () => ({ success: false, errorReason: "settlement_pending", transaction: tx, network: CHAIN, payer });
  assert.equal((await s.pay(o)).status, 202);
  assert.equal(s.facilitator.settles, 2); // One documented same-body reconciliation poll.
  const blocked = await s.request(`/api/session/${o.id}/finish`, { code: "not-yet-delivered" });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, "payment_pending");
  assert.equal((await (await s.request(`/api/session/${o.id}`)).json()).finish, null);
  s.advance(5001);
  s.facilitator.onSettle = undefined;
  const recovered = await s.pay(o);
  assert.equal(recovered.status, 200);
  assert.equal(s.facilitator.verifies, 1); // Existing authorization is polled, never re-verified.
  assert.equal(s.facilitator.settles, 3);
  const { code } = await recovered.json();
  assert.equal(typeof code, "string");
  assert.equal((await (await s.request(`/api/session/${o.id}/finish`, { code })).json()).completed, true);
});

test("pending reconciliation evidence survives a later lost response", async () => {
  const s = setup(); const o = await s.order();
  let calls = 0;
  s.facilitator.onSettle = async () => {
    calls++;
    if (calls === 1) return { success: false, errorReason: "settlement_pending", transaction: tx, network: CHAIN, payer };
    throw new Error("fixture response lost after pending result");
  };
  assert.equal((await s.pay(o)).status, 202);
  const [record] = await s.store.getOrderPayments([orderKey(o.resource)]);
  assert.equal(record?.pendingTransaction, tx);
  assert.equal(record?.pendingReason, "settlement_pending");
});

test("payment admission is CAS-serialized with finish and permits only one Signal order per session", async () => {
  const s = setup(); const first = await s.order();
  let release!: (result: SettleResponse) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  s.facilitator.onSettle = () => { entered(); return new Promise((resolve) => { release = resolve; }); };
  const active = s.pay(first);
  await started; // Durable claim and session CAS gate precede settlement.
  const blockedFinish = await s.request(`/api/session/${first.id}/finish`, { code: "unknown" });
  assert.equal(blockedFinish.status, 409);
  assert.equal((await blockedFinish.json()).error, "payment_pending");
  release(s.facilitator.settleResult);
  const paid = await active;
  assert.equal(paid.status, 200);
  const { code } = await paid.json();
  const second = await s.order("signal", first.id);
  const secondPayment = await s.pay(second);
  assert.equal(secondPayment.status, 409);
  assert.equal((await secondPayment.json()).error, "session_payment_order_locked");
  assert.equal(s.facilitator.verifies, 1);
  assert.equal(s.facilitator.settles, 1);
  const finish = await (await s.request(`/api/session/${first.id}/finish`, { code })).json();
  assert.equal(finish.completed, true);
  assert.equal(finish.settled_amount, "10000");
});

test("overlapping distinct Signal orders cannot create an eligible loser or settle after session expiry", async () => {
  const s = setup(); const first = await s.order(); const second = await s.order("signal", first.id);
  const releases: ((result: VerifyResponse) => void)[] = [];
  let entered!: () => void;
  const bothVerifying = new Promise<void>((resolve) => { entered = resolve; });
  s.facilitator.onVerify = () => new Promise((resolve) => {
    releases.push(resolve);
    if (releases.length === 2) entered();
  });
  const pendingResponses = [s.pay(first), s.pay(second)];
  await bothVerifying; // Both pass preflight before either claims/admission CAS.
  s.facilitator.onVerify = undefined;
  for (const release of releases) release({ isValid: true, payer });
  const [firstResponse, secondResponse] = await Promise.all(pendingResponses);
  assert.deepEqual([firstResponse.status, secondResponse.status].sort(), [200, 409]);
  assert.equal(s.facilitator.verifies, 2);
  assert.equal(s.facilitator.settles, 1);
  const orders = [first, second];
  const records = await s.store.getOrderPayments(orders.map((o) => orderKey(o.resource)));
  const loserIndex = records.findIndex((record) => record?.state !== "confirmed");
  assert.notEqual(loserIndex, -1);
  assert.equal(records[loserIndex]?.settlementEligible, false);
  const delivered = firstResponse.status === 200 ? firstResponse : secondResponse;
  const loser = firstResponse.status === 409 ? first : second;
  const { code } = await delivered.json();
  const finish = await s.request(`/api/session/${first.id}/finish`, { code });
  assert.equal(finish.status, 200);
  assert.equal((await finish.json()).completed, true);
  s.advance(24 * 60 * 60 * 1000 + 1);
  assert.equal((await s.pay(loser)).status, 202); // Missing-session recovery cannot upgrade an unadmitted claim.
  assert.equal(s.facilitator.settles, 1);
});

test("30-second client clock skew and case-normalized equivalent addresses are accepted", async () => {
  const s = setup(); const o = await s.order();
  const skewed = structuredClone(o.payload);
  (skewed.payload.authorization as Record<string, string>).validBefore = String(clock / 1000 + 62);
  skewed.accepted.asset = skewed.accepted.asset.toLowerCase();
  skewed.accepted.payTo = skewed.accepted.payTo.toLowerCase();
  const response = await s.pay(o, skewed);
  assert.equal(response.status, 200);
  assert.equal(s.facilitator.settles, 1);
});

test("verify rejection or payer mismatch never claims or settles", async () => {
  for (const result of [{ isValid: false }, { isValid: true, payer: config.payTo }]) {
    const s = setup(); const o = await s.order();
    s.facilitator.verifyResult = result;
    assert.equal((await s.pay(o)).status, 402);
    assert.equal(s.facilitator.settles, 0);
    assert.deepEqual(await s.store.getOrderPayments([orderKey(o.resource)]), [null]);
  }
});

test("settlement failure, pending, malformed confirmation, or lost response stays pending without duplicate transfer", async () => {
  const results: { result: SettleResponse | Error; calls: number }[] = [
    { result: { success: false, errorReason: "settlement_failed", network: CHAIN, transaction: "" }, calls: 1 },
    { result: { success: false, errorReason: "settlement_pending", network: CHAIN, transaction: tx }, calls: 2 },
    { result: { success: true, network: "eip155:1", transaction: tx, payer }, calls: 1 },
    { result: { success: true, network: CHAIN, transaction: "not-a-transaction", payer }, calls: 1 },
    { result: { success: true, network: CHAIN, transaction: `0x${"00".repeat(32)}`, payer }, calls: 1 },
    { result: { success: true, network: CHAIN, transaction: tx, payer: config.payTo }, calls: 1 },
    { result: { success: true, network: CHAIN, transaction: tx, payer, amount: "80000" }, calls: 1 },
    { result: new Error("fixture timeout may have settled"), calls: 2 },
  ];
  for (const { result, calls } of results) {
    const s = setup(); const o = await s.order();
    s.facilitator.onSettle = async () => { if (result instanceof Error) throw result; return result; };
    for (let i = 0; i < 2; i++) {
      const response = await s.pay(o);
      assert.equal(response.status, 202);
      assert.equal(response.headers.has("payment-response"), false);
      const data = await response.json();
      assert.equal(data.error, "payment_pending");
      assert.match(data.recovery, /same signed payment/);
      assert.equal("code" in data, false);
    }
    assert.equal(s.facilitator.settles, calls);
    const unsigned = await s.request(o.path);
    assert.equal(unsigned.status, 202);
    assert.equal(unsigned.headers.has("payment-required"), false);
    const replacement = structuredClone(o.payload);
    (replacement.payload.authorization as Record<string, string>).nonce = `0x${"99".repeat(32)}`;
    assert.equal((await s.pay(o, replacement)).status, 409);
    const viewer = await (await s.request(`/api/session/${o.id}`)).json();
    assert.deepEqual(viewer.deliveries, []);
    assert.equal(viewer.settled_amount, "0");
    const blockedFinish = await s.request(`/api/session/${o.id}/finish`, { code: "fake" });
    assert.equal(blockedFinish.status, 409);
    assert.equal((await blockedFinish.json()).error, "payment_pending");
  }
});

test("concurrent duplicate requests share one claim and never settle twice, including across app instances", async () => {
  const s = setup(); const o = await s.order();
  let release!: (result: SettleResponse) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  s.facilitator.onSettle = () => { entered(); return new Promise((resolve) => { release = resolve; }); };
  const first = s.pay(o);
  await started;
  const other = setup(s.store);
  const duplicates = await Promise.all([s.pay(o), other.pay(o), other.pay(o)]);
  assert.ok(duplicates.every((response) => response.status === 202));
  assert.equal(s.facilitator.settles, 1);
  assert.equal(other.facilitator.settles, 0);
  release(s.facilitator.settleResult);
  const original = await (await first).json();
  assert.equal((await (await other.pay(o)).json()).code, original.code);
});

test("authorization namespace rejects cross-order and cross-session reuse, including changed unsigned resource", async () => {
  const s = setup(); const first = await s.order();
  assert.equal((await s.pay(first)).status, 200);
  for (const next of [await s.order("signal", first.id), await s.order()]) {
    const replay = structuredClone(first.payload);
    replay.resource = next.payload.resource;
    const response = await s.pay(next, replay);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "authorization_bound_to_other_order");
  }
  assert.equal(s.facilitator.settles, 1);
});

test("same authorization/order with changed signed digest cannot recover a private code", async () => {
  const s = setup(); const o = await s.order();
  assert.equal((await s.pay(o)).status, 200);
  const changed = structuredClone(o.payload);
  changed.payload.signature = `0x${"ef".repeat(65)}`;
  assert.equal((await s.pay(o, changed)).status, 409);
  assert.equal(s.facilitator.settles, 1);
});

test("changed recipient, amount, asset, chain, resource, version and payer data are rejected", async () => {
  const mutations: ((p: PaymentPayload) => void)[] = [
    (p) => { p.accepted.payTo = payer; }, (p) => { p.accepted.amount = "80000"; },
    (p) => { p.accepted.asset = payer; }, (p) => { p.accepted.network = "eip155:1"; },
    (p) => { p.resource!.url += "&extra=1"; }, (p) => { p.resource = undefined; },
    (p) => { p.x402Version = 1; }, (p) => { p.accepted.maxTimeoutSeconds = 120; },
    (p) => { p.accepted.extra.name = "Other Coin"; },
    (p) => { (p.payload.authorization as Record<string, string>).to = payer; },
    (p) => { (p.payload.authorization as Record<string, string>).value = "80000"; },
    (p) => { (p.payload.authorization as Record<string, string>).from = config.payTo; },
    (p) => { (p.payload.authorization as Record<string, string>).validBefore = String(clock / 1000 - 1); },
    (p) => { (p.payload.authorization as Record<string, string>).validBefore = String(clock / 1000 + 120); },
    (p) => { (p.payload.authorization as Record<string, string>).validAfter = String(clock / 1000 + 1); },
    (p) => { p.payload = { permit2Authorization: {} }; },
  ];
  for (const mutate of mutations) {
    const s = setup(); const o = await s.order(); mutate(o.payload);
    const response = await s.pay(o);
    assert.ok([400, 402].includes(response.status), `mutation received ${response.status} for mutation ${mutations.indexOf(mutate)}`);
    assert.equal(s.facilitator.settles, 0);
  }
});

test("ambiguous v1/v2, duplicate, oversized and unsupported legacy headers fail without facilitator access", async () => {
  const s = setup(); const o = await s.order();
  assert.equal((await s.pay(o, o.payload, { "x-payment": "fixture" })).status, 400);
  assert.equal((await s.request(o.path, undefined, { "x-payment": "fixture" })).status, 400);
  assert.equal((await s.request(o.path, undefined, { "payment-signature": "a".repeat(16385) })).status, 431);
  const header = encodePaymentSignatureHeader(o.payload);
  assert.equal((await s.request(o.path, undefined, { "payment-signature": `${header}, ${header}` })).status, 400);
  assert.equal(s.facilitator.verifies, 0);
  assert.equal(s.facilitator.settles, 0);
});

class FaultStore extends MemoryStore {
  fault: "none" | "claim-before" | "claim-after" | "confirm-before" | "confirm-after" | "confirm-false" | "gate-confirm" = "none";
  override async claimPayment(record: PaymentRecord) {
    if (this.fault === "claim-before") throw new Error("fixture storage unavailable");
    const result = await super.claimPayment(record);
    if (this.fault === "claim-after") throw new Error("fixture lost acknowledgement");
    return result;
  }
  override async confirmPayment(record: PaymentRecord, expected: number) {
    if (this.fault === "confirm-before") throw new Error("fixture storage unavailable");
    if (this.fault === "confirm-false") return false;
    const result = await super.confirmPayment(record, expected);
    if (this.fault === "confirm-after") throw new Error("fixture lost acknowledgement");
    return result;
  }
  override async compareAndSwap(session: Parameters<MemoryStore["compareAndSwap"]>[0], expected: number) {
    if (this.fault === "gate-confirm" && session.paymentAdmission?.state === "confirmed") {
      throw new Error("fixture admission write unavailable");
    }
    return super.compareAndSwap(session, expected);
  }
}
test("claim and confirmation failures recover only through the same authorization and idempotency key", async () => {
  for (const fault of ["claim-before", "claim-after", "confirm-before", "confirm-after", "confirm-false"] as const) {
    const store = new FaultStore("test", () => clock);
    const s = setup(store); const o = await s.order(); store.fault = fault;
    const response = await s.pay(o);
    assert.equal(response.status, 202, fault);
    assert.equal("code" in await response.json(), false);
    assert.equal(response.headers.has("payment-response"), false);
    assert.equal(s.facilitator.settles, fault.startsWith("claim") ? 0 : 1);
    store.fault = "none";
    if (fault === "claim-before") {
      s.advance(61_000);
      assert.equal((await s.pay(o)).status, 400); // Expired unclaimed auth cannot settle.
      const replacement = structuredClone(o.payload);
      (replacement.payload.authorization as Record<string, string>).nonce = `0x${"99".repeat(32)}`;
      (replacement.payload.authorization as Record<string, string>).validBefore = String(clock / 1000 + 121);
      const fresh = await s.pay(o, replacement);
      assert.equal(fresh.status, 200); // No stale pre-claim admission blocks a safe replacement.
      assert.equal(s.facilitator.settles, 1);
      continue;
    }
    if (fault !== "confirm-after") s.advance(61_000);
    const retry = await s.pay(o);
    assert.equal(retry.status, 200, fault);
    const expectedSettles = fault === "claim-after" || fault === "confirm-after" ? 1 : 2;
    assert.equal(s.facilitator.settles, expectedSettles, fault);
    if (expectedSettles === 2) assert.equal(s.facilitator.settlementKeys[0], s.facilitator.settlementKeys[1]);
    const { code } = await retry.json();
    const finish = await s.request(`/api/session/${o.id}/finish`, { code });
    assert.equal(finish.status, 200);
    assert.equal((await finish.json()).completed, true);
  }
});

test("finish repairs a matching admission from the durable confirmed ledger after admission-write failures", async () => {
  const store = new FaultStore("test", () => clock); const s = setup(store); const o = await s.order();
  store.fault = "gate-confirm";
  assert.equal((await s.pay(o)).status, 202); // Settlement and durable ledger confirmation succeeded.
  const [record] = await store.getOrderPayments([orderKey(o.resource)]);
  assert.equal(record?.state, "confirmed");
  const replay = await s.pay(o); // Recovery still returns the code while the session CAS is down.
  assert.equal(replay.status, 200);
  const { code } = await replay.json();
  store.fault = "none";
  const finish = await s.request(`/api/session/${o.id}/finish`, { code });
  assert.equal(finish.status, 200);
  assert.equal((await finish.json()).completed, true);
  assert.equal(s.facilitator.settles, 1);
});

test("default-disabled routes and all signed traps never verify or settle", async () => {
  for (const enabled of [false, true]) {
    const s = setup(undefined, enabled);
    for (const seller of ["atlas", "spark", "ledger", ...(enabled ? [] : ["signal"])]) {
      const o = await s.order(seller);
      assert.equal((await s.pay(o)).status, seller === "signal" ? 503 : 403);
    }
    assert.equal(s.facilitator.verifies, 0);
    assert.equal(s.facilitator.settles, 0);
  }
});

test("manual PayAI transport has a fixed host, bounded request/body, correct v2 envelope, and no retry", async () => {
  const calls: string[] = [];
  const transport = (async (url, init) => {
    calls.push(String(url));
    assert.equal(init!.redirect, "error"); assert.equal(init!.cache, "no-store"); assert.ok(init!.signal);
    const body = JSON.parse(String(init!.body));
    assert.equal(body.x402Version, 2);
    assert.equal(body.paymentRequirements.payTo, config.payTo);
    return Response.json({ success: false, network: CHAIN, transaction: "", errorReason: "settlement_pending" });
  }) as typeof fetch;
  const s = setup(); const o = await s.order();
  const adapter = payAIFacilitator(transport);
  await adapter.settle(o.payload, o.payload.accepted, "a".repeat(64));
  assert.deepEqual(calls, ["https://facilitator.payai.network/settle"]);
  const structured = await payAIFacilitator((async (url, init) => {
    assert.equal(String(url), "https://facilitator.payai.network/settle");
    assert.equal(new Headers(init?.headers).get("Idempotency-Key"), "b".repeat(64));
    return Response.json({ success: false, errorReason: "settlement_pending", transaction: tx, network: CHAIN, payer }, { status: 409 });
  }) as typeof fetch).settle(o.payload, o.payload.accepted, "b".repeat(64));
  assert.equal(structured.errorReason, "settlement_pending");
  assert.equal(structured.transaction, tx);
  const large = payAIFacilitator((async () => new Response("x".repeat(17000))) as typeof fetch);
  await assert.rejects(large.settle(o.payload, o.payload.accepted, "c".repeat(64)));
  const bodies: string[] = [];
  const deterministic = payAIFacilitator((async (_url, init) => {
    bodies.push(String(init?.body));
    return Response.json({ success: true, network: CHAIN, transaction: tx, payer });
  }) as typeof fetch);
  const addressMixed = `0x${"Aa".repeat(20)}`;
  const assetMixed = `0x${"Bb".repeat(20)}`;
  const requirementsA = { ...o.payload.accepted, payTo: addressMixed, asset: assetMixed };
  const requirementsB = { ...requirementsA, payTo: addressMixed.toLowerCase(), asset: assetMixed.toLowerCase() };
  const payloadA = structuredClone(o.payload); payloadA.accepted = requirementsA;
  payloadA.extensions = { demo: { z: "last", a: "first" } };
  const payloadB = structuredClone(o.payload); payloadB.accepted = requirementsB;
  payloadB.extensions = { demo: { a: "first", z: "last" } };
  await deterministic.settle(payloadA, requirementsA, "d".repeat(64));
  await deterministic.settle(payloadB, requirementsB, "d".repeat(64));
  assert.equal(bodies[0], bodies[1], "same idempotency key must use byte-identical normalized JSON");
});
