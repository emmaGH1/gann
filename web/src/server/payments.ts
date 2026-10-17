import { x402ResourceServer } from "@x402/core/server";
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { PaymentRequiredV2Schema, PaymentPayloadV2Schema } from "@x402/core/schemas";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Session, ConfirmedDelivery } from "./model";
import type { PaymentRecord } from "./payment-model";
import type { SessionStore } from "./store";
import type { Facilitator } from "./facilitator";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { Config } from "./config";
import { CHAIN, SELLERS, USDC, type SellerId } from "./course";
import { ApiError } from "./errors";
import { boundedText, json } from "./http";

const scheme = new ExactEvmScheme();
// Empty facilitator list is intentional. Challenge construction is local and
// makes no /supported, /verify, /settle, RPC, or discovery calls. A valid wire
// challenge does NOT claim current facilitator capacity or paid-path readiness.
const resourceServer = new x402ResourceServer([]).register(CHAIN, scheme);

export function resourceUrl(config: Config, seller: SellerId, session: string, attempt?: string) {
  const url = new URL(`/api/s/${seller}`, config.origin);
  url.searchParams.set("session", session);
  if (attempt) url.searchParams.set("attempt", attempt);
  return url.toString();
}

export async function exactRequirements(config: Config, seller: SellerId): Promise<PaymentRequirements> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(config.payTo) || /^0x0{40}$/i.test(config.payTo)) {
    throw new ApiError(503, "configuration_required");
  }
  const price = await scheme.parsePrice({
    amount: SELLERS[seller].required,
    asset: USDC,
    extra: { name: "USD Coin", version: "2" },
  }, CHAIN);
  return {
    scheme: "exact", network: CHAIN, amount: price.amount, asset: price.asset,
    payTo: config.payTo, maxTimeoutSeconds: 60, extra: price.extra ?? {},
  };
}

export async function unpaidChallenge(config: Config, seller: SellerId, resource: string) {
  const required = await resourceServer.createPaymentRequiredResponse([await exactRequirements(config, seller)], { url: resource, description: SELLERS[seller].description, mimeType: "application/json" },
  config.enablePayments && seller === "signal"
    ? "Payment required. Only authorize the recorded Signal order once. Pending outcomes require recovery, not a new payment."
    : "Payment disabled for this route. Do not authorize a payment.");
  PaymentRequiredV2Schema.parse(required);
  return json(required, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) });
}

export async function inspectLive(config: Config, seller: SellerId, session: string, fetcher: typeof fetch) {
  const url = resourceUrl(config, seller, session);
  try {
    const response = await fetcher(url, {
      method: "GET", redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(1500), headers: { Accept: "application/json" },
    });
    const header = response.headers.get("payment-required");
    if (response.status !== 402 || !header || header.length > 16 * 1024) {
      void response.body?.cancel().catch(() => {});
      throw new Error("invalid challenge");
    }
    await boundedText(response.body, 16 * 1024, 1500);
    const challenge = PaymentRequiredV2Schema.parse(decodePaymentRequiredHeader(header));
    const [requirement] = challenge.accepts;
    if (challenge.resource.url !== url || challenge.accepts.length !== 1 ||
        requirement.scheme !== "exact" || requirement.network !== CHAIN ||
        requirement.asset.toLowerCase() !== USDC.toLowerCase() ||
        requirement.payTo.toLowerCase() !== config.payTo.toLowerCase() ||
        requirement.amount !== SELLERS[seller].required ||
        requirement.extra?.name !== "USD Coin" || requirement.extra?.version !== "2") {
      throw new Error("unexpected challenge");
    }
    return {
      seller_id: seller, advertised_amount: SELLERS[seller].advertised,
      required_amount: requirement.amount, asset: requirement.asset, chain: CHAIN,
      description: challenge.resource.description ?? SELLERS[seller].description,
    };
  } catch {
    // Never store errors containing upstream bodies, keys, or payment headers.
    throw new ApiError(502, "live_challenge_unavailable");
  }
}

// Only v2 exact native-USDC EIP-3009 is accepted, not Permit2 or legacy v1.
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uint = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const exactPayload = z.strictObject({
  signature: z.string().regex(/^0x(?:[0-9a-fA-F]{2}){64,65}$/),
  authorization: z.strictObject({ from: address, to: address, value: uint,
    validAfter: uint, validBefore: uint, nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
});
const hash = (input: string) => createHash("sha256").update(input).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const orderKey = (resource: string) => hash(resource);
const SETTLEMENT_LEASE_MS = 55_000;
const SETTLEMENT_BACKOFF_MS = 5_000;
const CLOCK_SKEW_MS = 30_000;
const pending = () => json({ error: "payment_pending", status: "pending",
  recovery: "The same signed payment may be retried for this order to reconcile its original outcome. Never authorize a replacement payment while this one is pending." }, 202, { "Retry-After": "5" });

function matches(record: PaymentRecord, candidate: PaymentRecord) {
  if (record.order !== candidate.order || record.resource !== candidate.resource || record.session !== candidate.session || record.attempt !== candidate.attempt) {
    throw new ApiError(409, "authorization_bound_to_other_order");
  }
  if (record.id !== candidate.id || record.digest !== candidate.digest) throw new ApiError(409, "order_payment_conflict");
}
export function durableDelivery(record: PaymentRecord | null, session: Pick<Session, "id">, attempt: string, resource: string): ConfirmedDelivery | null {
  if (!record || !record.settlementEligible || record.state !== "confirmed" || record.session !== session.id || record.attempt !== attempt ||
      record.resource !== resource || record.order !== orderKey(resource) || record.version !== 2 || record.amount !== "10000" || record.network !== CHAIN ||
      record.asset.toLowerCase() !== USDC.toLowerCase() || !record.code || !confirmedReceipt(record.receipt, record.payer)) return null;
  return { attempt_id: attempt, seller_id: "signal", settlement: "confirmed", amount: "10000",
    transaction: record.receipt!.transaction, code: record.code };
}
function confirmedReceipt(receipt: SettleResponse | undefined, payer: string): boolean {
  return !!receipt && receipt.success === true && receipt.network === CHAIN &&
    /^0x[0-9a-fA-F]{64}$/.test(receipt.transaction) && !/^0x0{64}$/i.test(receipt.transaction) &&
    typeof receipt.payer === "string" && receipt.payer.toLowerCase() === payer &&
    (receipt.amount === undefined || receipt.amount === "10000") && !receipt.errorReason;
}
function recover(record: PaymentRecord, session: Pick<Session, "id">, resource: string): Response {
  const delivery = durableDelivery(record, session, record.attempt, resource);
  if (!delivery) return pending();
  // Only sanitized protocol fields: do not echo facilitator extras/errors.
  return json({ code: delivery.code }, 200, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(record.receipt!) });
}

function retryable(result: SettleResponse | undefined) {
  return !result || ["settlement_pending", "duplicate_settlement", "service_unavailable", "internal_server_error", "idempotency_key_in_flight"].includes(result.errorReason ?? "");
}

async function setAdmission(store: SessionStore, sessionId: string, record: PaymentRecord,
  state: "processing" | "pending" | "confirmed", now: number, force = false): Promise<boolean> {
  for (let retry = 0; retry < 3; retry++) {
    const current = await store.get(sessionId);
    if (!current) throw new ApiError(503, "payment_session_unavailable");
    const previous = current.paymentAdmission;
    if (current.finish?.result.completed && state !== "confirmed") throw new ApiError(409, "session_completed");
    if (current.expiresAt <= now) throw new ApiError(410, "session_expired");
    if (previous) {
      if (previous.order !== record.order || previous.authorization !== record.id || previous.digest !== record.digest) {
        throw new ApiError(409, "session_payment_order_locked");
      }
      if (previous.state === "confirmed") return state === "confirmed";
      if (!force && previous.leaseUntil > now) return false;
    }
    current.paymentAdmission = { order: record.order, authorization: record.id, digest: record.digest,
      owner: record.owner, state, leaseUntil: record.leaseUntil };
    const expected = current.revision++;
    if (await store.compareAndSwap(current, expected)) return true;
  }
  return false;
}

async function admissionBeforeVerification(store: SessionStore, sessionId: string, record: PaymentRecord, now: number): Promise<boolean> {
  const current = await store.get(sessionId);
  if (!current) throw new ApiError(503, "payment_session_unavailable");
  if (current.expiresAt <= now) throw new ApiError(410, "session_expired");
  if (current.finish?.result.completed) throw new ApiError(409, "session_completed");
  const gate = current.paymentAdmission;
  if (!gate) return true;
  if (gate.order !== record.order || gate.authorization !== record.id || gate.digest !== record.digest) {
    throw new ApiError(409, "session_payment_order_locked");
  }
  // A matching gate without a durable claim is an uncertain partial write;
  // never re-verify/re-claim it automatically. Existing claims take the
  // recovery path above and are protected by the global authorization index.
  return false;
}

export async function paidSignal(config: Config, store: SessionStore, facilitator: Facilitator,
  session: Pick<Session, "id" | "expiresAt" | "finish">, attempt: string, header: string, now: () => number,
  allowNewPayment = true): Promise<Response> {
  const resource = resourceUrl(config, "signal", session.id, attempt);
  const requirements = await exactRequirements(config, "signal");
  let payload: PaymentPayload;
  let auth: z.infer<typeof exactPayload>["authorization"];
  let digest: string;
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(header)) throw new Error();
    const raw = decodePaymentSignatureHeader(header);
    if (Object.keys(raw).some((key) => !["x402Version", "resource", "accepted", "payload", "extensions"].includes(key))) throw new Error();
    const parsed = PaymentPayloadV2Schema.parse(raw);
    const exact = exactPayload.parse(parsed.payload);
    const accepted = { ...raw.accepted, asset: raw.accepted.asset.toLowerCase(), payTo: raw.accepted.payTo.toLowerCase() };
    const expected = { ...requirements, asset: requirements.asset.toLowerCase(), payTo: requirements.payTo.toLowerCase() };
    if (parsed.resource?.url !== resource || canonical(accepted) !== canonical(expected) ||
        exact.authorization.to.toLowerCase() !== config.payTo.toLowerCase() || exact.authorization.value !== "10000" ||
        /^0x0{40}$/i.test(exact.authorization.from)) throw new Error();
    // Bind the entire received payload (including benign extensions) for replay
    // identity; preserve it for PayAI verification/settlement, but never persist it.
    digest = hash(canonical(raw));
    payload = { ...parsed, extensions: parsed.extensions ?? undefined, resource: { url: resource }, accepted: requirements, payload: exact };
    auth = exact.authorization;
  } catch { throw new ApiError(400, "invalid_payment_payload"); }
  const validBefore = Number(auth.validBefore) * 1000;
  const validAfter = Number(auth.validAfter) * 1000;
  if (!Number.isSafeInteger(validBefore) || !Number.isSafeInteger(validAfter)) throw new ApiError(400, "invalid_payment_lifetime");
  const payer = auth.from.toLowerCase();
  let record: PaymentRecord = {
    id: hash(`${CHAIN}:${USDC.toLowerCase()}:${payer}:${auth.nonce.toLowerCase()}`),
    order: orderKey(resource), resource, session: session.id, attempt, digest,
    version: 2, network: CHAIN, asset: USDC.toLowerCase(), payTo: config.payTo.toLowerCase(), amount: "10000",
    payer, nonce: auth.nonce.toLowerCase(), validBefore,
    // Retention outlives the session so identical requests can recover payment.
    expiresAt: Math.max(validBefore, session.expiresAt) + 30 * 24 * 60 * 60 * 1000,
    revision: 0, owner: randomUUID(), leaseUntil: now() + SETTLEMENT_LEASE_MS,
    settlementEligible: false, state: "processing",
  };
  const existing = async () => {
    const byAuth = await store.getPayment(record.id);
    const [byOrder] = await store.getOrderPayments([record.order]);
    if (byAuth) matches(byAuth, record);
    if (byOrder) matches(byOrder, record);
    if (Boolean(byAuth) !== Boolean(byOrder)) throw new Error("inconsistent_payment_index");
    return byAuth;
  };
  try {
    const previous = await existing();
    if (previous) {
      // A confirmed delivery is always recovered before validating expiry or
      // asking the facilitator again. An unresolved request is only retried with
      // the identical, digest-bound authorization after its owner lease expires.
      if (previous.state === "confirmed") {
        if (allowNewPayment) {
          try { await setAdmission(store, session.id, previous, "confirmed", now(), true); } catch { /* Durable ledger remains authoritative; finish can reconcile it. */ }
        }
        return recover(previous, session, resource);
      }
      if (!previous.settlementEligible && !allowNewPayment) return pending();
      if (previous.leaseUntil > now()) return pending();
      record = { ...previous, revision: previous.revision + 1, owner: randomUUID(),
        leaseUntil: now() + SETTLEMENT_LEASE_MS, state: "processing" };
      if (!await store.reclaimPayment(record, previous.revision, now())) {
        const latest = await existing();
        if (latest?.state === "confirmed") {
          if (allowNewPayment) {
            try { await setAdmission(store, session.id, latest, "confirmed", now(), true); } catch { /* Finish rechecks the ledger. */ }
          }
          return recover(latest, session, resource);
        }
        return pending();
      }
      if (allowNewPayment && !await setAdmission(store, session.id, record, "processing", now())) return pending();
      if (!record.settlementEligible) {
        const eligible = { ...record, revision: record.revision + 1, settlementEligible: true };
        if (!await store.markSettlementEligible(eligible, record.revision)) return pending();
        record = eligible;
      }
    } else {
      if (!allowNewPayment) throw new ApiError(410, "order_session_unavailable_no_new_payment");
      const currentTime = now();
      if (validBefore <= currentTime || validAfter > currentTime + CLOCK_SKEW_MS ||
          validBefore - currentTime > 60_000 + CLOCK_SKEW_MS || validAfter >= validBefore) {
        throw new ApiError(400, "invalid_payment_lifetime");
      }
      if (!await admissionBeforeVerification(store, session.id, record, currentTime)) return pending();
      try {
        const verified = await facilitator.verify(payload, requirements);
        if (verified.isValid !== true || typeof verified.payer !== "string" || verified.payer.toLowerCase() !== payer) {
          throw new ApiError(402, "payment_verification_failed");
        }
      } catch { throw new ApiError(402, "payment_verification_failed"); }
      if (!await store.claimPayment(record)) {
        let latest: PaymentRecord | null;
        try { latest = await existing(); }
        catch (error) { throw error; }
        if (latest?.state === "confirmed") {
          await setAdmission(store, session.id, latest, "confirmed", now(), true);
          return recover(latest, session, resource);
        }
        return pending();
      }
      // The durable claim fences replacement authorizations; the session CAS
      // now serializes this owner with finish before settlement eligibility and /settle.
      if (!await setAdmission(store, session.id, record, "processing", currentTime)) return pending();
      const eligible = { ...record, revision: record.revision + 1, settlementEligible: true };
      if (!await store.markSettlementEligible(eligible, record.revision)) return pending();
      record = eligible;
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return pending();
  }

  if (!record.settlementEligible) return pending();
  let result: SettleResponse | undefined;
  let pendingTransaction = record.pendingTransaction;
  let pendingReason = record.pendingReason;
  for (let call = 0; call < 2; call++) {
    try { result = await facilitator.settle(payload, requirements, record.id); }
    catch { result = undefined; }
    if (result?.transaction && /^0x[0-9a-fA-F]{64}$/.test(result.transaction)) pendingTransaction = result.transaction;
    if (result?.errorReason && /^[a-z0-9_]{1,80}$/.test(result.errorReason)) pendingReason = result.errorReason;
    if (result && confirmedReceipt(result, payer)) break;
    if (call === 0 && retryable(result)) continue; // PayAI documents same-body/idempotency polling.
    break;
  }
  if (result && confirmedReceipt(result, payer)) {
    record.receipt = { success: true, transaction: result.transaction, network: CHAIN, payer, amount: "10000" };
    record.code = randomBytes(24).toString("base64url");
    delete record.pendingTransaction;
    delete record.pendingReason;
    record.state = "confirmed";
    record.revision++;
    try {
      if (!await store.confirmPayment(record, record.revision - 1)) return pending();
      const durable = await store.getPayment(record.id);
      if (!durable) return pending();
      matches(durable, record);
      if (allowNewPayment && !await setAdmission(store, session.id, durable, "confirmed", now(), true)) return pending();
      return recover(durable, session, resource);
    } catch { return pending(); }
  }

  // Preserve only safe reconciliation evidence, not the facilitator body or
  // signed payload. The same authorization/order can be reclaimed after backoff.
  record.state = "pending";
  record.revision++;
  record.leaseUntil = now() + SETTLEMENT_BACKOFF_MS;
  if (pendingTransaction) record.pendingTransaction = pendingTransaction;
  else delete record.pendingTransaction;
  record.pendingReason = pendingReason ?? "settlement_unresolved";
  try {
    const marked = await store.markPaymentPending(record, record.revision - 1);
    if (marked && allowNewPayment) await setAdmission(store, session.id, record, "pending", now(), true);
  } catch { /* Keep the original processing claim/admission; fail closed. */ }
  return pending();
}

export const PAID_PATH_READY = true;
