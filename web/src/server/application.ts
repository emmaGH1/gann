import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config";
import { BUDGET, MISSION, SELLERS, SELLER_IDS, SESSION_TTL_MS, sellerList, type SellerId } from "./course";
import { ApiError } from "./errors";
import { authenticate, body, json, parse, uuid } from "./http";
import { appendEvent, type Session } from "./model";
import { inspectLive, PAID_PATH_READY, resourceUrl, unpaidChallenge } from "./payments";
import { codeHash, confirmedDeliveries, score } from "./scoring";
import type { SessionStore } from "./store";

const sellerSchema = z.enum(SELLER_IDS);
const startSchema = z.strictObject({ agent_label: z.string().trim().min(1).max(80).refine((label) => !/[\u0000-\u001f\u007f]/.test(label)) });
const inspectSchema = z.strictObject({ seller_id: sellerSchema });
const attemptSchema = z.strictObject({ seller_id: sellerSchema, attempt_id: uuid });
const finishSchema = z.strictObject({ code: z.string().max(128) });
const querySchema = z.strictObject({ session: uuid, attempt: uuid.optional() });

export class Application {
  constructor(
    private readonly config: Config,
    private readonly store: SessionStore,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    if (config.mode === "production" && store.kind !== "redis") throw new ApiError(503, "persistence_required");
  }

  private async session(id: string) {
    const session = await this.store.get(id);
    if (!session) throw new ApiError(404, "session_not_found");
    if (session.expiresAt <= this.now()) throw new ApiError(410, "session_expired");
    return session;
  }

  private async update<T>(id: string, mutation: (session: Session) => { value: T; changed: boolean }): Promise<T> {
    for (let retry = 0; retry < 3; retry++) {
      const session = await this.session(id);
      const expected = session.revision;
      const { value, changed } = mutation(session);
      if (!changed) return value;
      if (session.events.length > 256 || Object.keys(session.attempts).length > 64) throw new ApiError(429, "session_event_limit");
      session.revision++;
      if (await this.store.compareAndSwap(session, expected)) return value;
    }
    throw new ApiError(409, "concurrent_update_retry_same_request");
  }

  private assertOpen(session: Session) {
    if (session.finish?.result.completed) throw new ApiError(409, "session_completed");
  }

  private snapshot(session: Session) {
    const deliveries = confirmedDeliveries(session);
    return {
      contractVersion: 1,
      session_id: session.id,
      agent_label: session.agentLabel,
      created_at: new Date(session.createdAt).toISOString(),
      expires_at: new Date(session.expiresAt).toISOString(),
      mission: MISSION,
      budget_atomic: BUDGET,
      storage: this.store.kind,
      payments: "disabled",
      sellers: sellerList().map((seller) => ({ ...seller, required_amount: SELLERS[seller.seller_id].required })),
      // Allowlist event fields. Never spread private stored data into viewer output.
      events: session.events.map((event) => ({
        sequence: event.sequence, at: event.at, type: event.type,
        ...(event.seller_id ? { seller_id: event.seller_id } : {}),
        ...(event.attempt_id ? { attempt_id: event.attempt_id } : {}),
        ...(event.advertised_amount ? { advertised_amount: event.advertised_amount } : {}),
        ...(event.required_amount ? { required_amount: event.required_amount } : {}),
        ...(event.completed !== undefined ? { completed: event.completed } : {}),
      })),
      attempts: Object.values(session.attempts).map((attempt) => ({
        attempt_id: attempt.attempt_id, seller_id: attempt.seller_id,
        advertised_amount: attempt.advertised_amount,
        proposal_status: "not_observed", paybox_status: "not_observed", human_decision: "not_observed",
        settlement_status: deliveries.some((delivery) => delivery.attempt_id === attempt.attempt_id) ? "confirmed" : "not_observed",
        delivery_status: deliveries.some((delivery) => delivery.attempt_id === attempt.attempt_id) ? "confirmed" : "not_observed",
      })),
      settlements: deliveries.map((delivery) => ({ attempt_id: delivery.attempt_id, amount: delivery.amount, status: "confirmed" })),
      deliveries: deliveries.map((delivery) => ({ attempt_id: delivery.attempt_id, status: "confirmed" })),
      settled_amount: deliveries.reduce((sum, delivery) => sum + BigInt(delivery.amount), 0n).toString(),
      finish: session.finish?.result ?? null,
      evidence_notice: "Attempts alone do not establish proposal receipt, PayBox rejection, human approval, settlement, or delivery.",
    };
  }

  private async seller(request: Request, seller: SellerId, url: URL) {
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (key in query) throw new ApiError(400, "invalid_input");
      query[key] = value;
    }
    const { session: id, attempt } = parse(querySchema, query);
    const session = await this.session(id);
    if (attempt && session.attempts[attempt]?.seller_id !== seller) throw new ApiError(409, "attempt_not_recorded_for_seller");
    const signature = request.headers.get("payment-signature") ?? request.headers.get("x-payment");
    if (signature !== null) {
      if (signature.length > 16 * 1024) throw new ApiError(431, "payment_header_too_large");
      if (!attempt) throw new ApiError(400, "recorded_attempt_required");
      if (seller !== "signal") throw new ApiError(403, "seller_payment_disabled");
      // Do not parse, persist, echo, verify, or transmit a signed authorization.
      throw new ApiError(503, "paid_fulfillment_not_implemented");
    }
    return unpaidChallenge(this.config, seller, resourceUrl(this.config, seller, id, attempt));
  }

  private async dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const sellerRoute = /^\/api\/s\/(atlas|spark|signal|ledger)$/.exec(path);
    const sessionRoute = /^\/api\/session\/([^/]+)(?:\/(inspect|attempt|finish))?$/.exec(path);
    const isStart = path === "/api/session";
    const isHealth = path === "/api/health";
    if (!sellerRoute && !sessionRoute && !isStart && !isHealth) throw new ApiError(404, "not_found");
    const requiredMethod = isStart || sessionRoute?.[2] ? "POST" : "GET";
    if (request.method !== requiredMethod) return json({ error: "method_not_allowed" }, 405, { Allow: requiredMethod });
    if (requiredMethod === "POST") authenticate(request, this.config.brokerKey);
    if (!sellerRoute && url.search) throw new ApiError(400, "invalid_input");
    if (isHealth) {
      // Probe storage, not a facilitator; "configured" never implies a successful payment.
      await this.store.get("00000000-0000-4000-8000-000000000000");
      return json({ status: "ok", contractVersion: 1, storage: this.store.kind,
        payments: this.config.enablePayments && PAID_PATH_READY ? "configured" : "disabled" });
    }
    if (sellerRoute) return this.seller(request, sellerRoute[1] as SellerId, url);
    if (isStart) {
      const input = await body(request, startSchema);
      const now = this.now();
      const session: Session = {
        id: randomUUID(), revision: 0, agentLabel: input.agent_label,
        createdAt: now, expiresAt: now + SESSION_TTL_MS, events: [], attempts: {}, deliveries: [],
      };
      appendEvent(session, now, { type: "session_started" });
      if (!await this.store.create(session)) throw new ApiError(503, "session_create_failed");
      return json({ session_id: session.id, mission: MISSION, budget_atomic: BUDGET, sellers: sellerList() });
    }
    const id = parse(uuid, sessionRoute![1]);
    const operation = sessionRoute![2];
    if (!operation) return json(this.snapshot(await this.session(id)));
    if (operation === "inspect") {
      const { seller_id } = await body(request, inspectSchema);
      this.assertOpen(await this.session(id));
      const live = await inspectLive(this.config, seller_id, id, this.fetcher);
      await this.update(id, (session) => {
        this.assertOpen(session);
        appendEvent(session, this.now(), { type: "offer_inspected", seller_id,
          advertised_amount: live.advertised_amount, required_amount: live.required_amount });
        return { value: undefined, changed: true };
      });
      return json(live);
    }
    if (operation === "attempt") {
      const { seller_id, attempt_id } = await body(request, attemptSchema);
      const value = await this.update(id, (session) => {
        const previous = session.attempts[attempt_id];
        if (previous && previous.seller_id !== seller_id) throw new ApiError(409, "attempt_body_mismatch");
        const value = { attempt_id, seller_id, advertised_amount: SELLERS[seller_id].advertised };
        if (previous) return { value, changed: false };
        this.assertOpen(session);
        const sequence = appendEvent(session, this.now(), { type: "attempt_recorded", ...value });
        session.attempts[attempt_id] = { ...value, sequence };
        return { value, changed: true };
      });
      return json(value);
    }
    const { code } = await body(request, finishSchema);
    const result = await this.update(id, (session) => {
      const hash = codeHash(code);
      if (session.finish?.codeHash === hash) return { value: session.finish.result, changed: false };
      this.assertOpen(session);
      const value = score(session, code);
      session.finish = { codeHash: hash, result: value };
      appendEvent(session, this.now(), { type: "finish_checked", completed: value.completed });
      return { value, changed: true };
    });
    return json(result);
  }

  async handle(request: Request): Promise<Response> {
    try { return await this.dispatch(request); }
    catch (error) {
      return error instanceof ApiError ? json({ error: error.code }, error.status) : json({ error: "service_unavailable" }, 503);
    }
  }
}
