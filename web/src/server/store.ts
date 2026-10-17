import type { Config } from "./config";
import type { Session } from "./model";
import { ApiError, unavailable } from "./errors";
import { boundedText } from "./http";
import { validRecord, type PaymentRecord, type PaymentStore } from "./payment-model";

export interface SessionStore extends PaymentStore {
  readonly kind: "memory-development" | "redis";
  get(id: string): Promise<Session | null>;
  create(session: Session): Promise<boolean>;
  compareAndSwap(session: Session, expectedRevision: number): Promise<boolean>;
}

export class MemoryStore implements SessionStore {
  readonly kind = "memory-development" as const;
  private readonly sessions = new Map<string, Session>();
  private readonly payments = new Map<string, PaymentRecord>();
  private readonly orders = new Map<string, string>();
  async getPayment(id: string) {
    const value = this.payments.get(id);
    return value ? structuredClone(value) : null;
  }
  async getOrderPayments(orders: string[]) {
    return Promise.all(orders.map((order) => this.getPayment(this.orders.get(order) ?? "")));
  }
  async claimPayment(record: PaymentRecord) {
    // No await between checks and writes: atomic in this test/development process.
    // Never evict outstanding payments to make room for new ones.
    if (this.payments.has(record.id) || this.orders.has(record.order)) return false;
    if (this.payments.size >= 1000) throw new ApiError(429, "development_capacity_reached");
    this.payments.set(record.id, structuredClone(record));
    this.orders.set(record.order, record.id);
    return true;
  }
  async reclaimPayment(record: PaymentRecord, expectedRevision: number, now: number) {
    const current = this.payments.get(record.id);
    if (!current || this.orders.get(record.order) !== record.id || current.revision !== expectedRevision ||
        current.order !== record.order || current.digest !== record.digest || current.id !== record.id ||
        current.settlementEligible !== record.settlementEligible || record.revision !== current.revision + 1 ||
        record.state !== "processing" || record.owner === current.owner ||
        !["processing", "pending"].includes(current.state) || current.leaseUntil > now) return false;
    this.payments.set(record.id, structuredClone(record));
    return true;
  }
  async markSettlementEligible(record: PaymentRecord, expectedRevision: number) {
    const current = this.payments.get(record.id);
    if (!current || current.revision !== expectedRevision || current.owner !== record.owner || current.id !== record.id ||
        current.state !== "processing" || record.state !== "processing" || current.order !== record.order ||
        current.digest !== record.digest || current.settlementEligible || !record.settlementEligible ||
        record.revision !== current.revision + 1) return false;
    this.payments.set(record.id, structuredClone(record));
    return true;
  }
  async markPaymentPending(record: PaymentRecord, expectedRevision: number) {
    const current = this.payments.get(record.id);
    if (!current || current.revision !== expectedRevision || current.owner !== record.owner || current.id !== record.id ||
        current.state !== "processing" || record.state !== "pending" || current.order !== record.order ||
        current.digest !== record.digest || !current.settlementEligible || !record.settlementEligible ||
        record.revision !== current.revision + 1) return false;
    this.payments.set(record.id, structuredClone(record));
    return true;
  }
  async confirmPayment(record: PaymentRecord, expectedRevision: number) {
    const current = this.payments.get(record.id);
    if (!current || current.revision !== expectedRevision || current.owner !== record.owner || current.id !== record.id ||
        current.state !== "processing" || record.state !== "confirmed" || current.order !== record.order ||
        current.digest !== record.digest || !current.settlementEligible || !record.settlementEligible ||
        record.revision !== current.revision + 1) return false;
    this.payments.set(record.id, structuredClone(record));
    return true;
  }
  constructor(mode: Config["mode"], private readonly now: () => number = Date.now) {
    if (mode === "production") throw new ApiError(503, "persistence_required");
  }
  async get(id: string) {
    const session = this.sessions.get(id);
    // Retain expired records briefly to distinguish 410 from 404 in local development.
    return session ? structuredClone(session) : null;
  }
  async create(session: Session) {
    for (const [id, value] of this.sessions) {
      if (value.expiresAt + 60_000 < this.now()) this.sessions.delete(id);
    }
    if (this.sessions.has(session.id)) return false;
    if (this.sessions.size >= 1000) throw new ApiError(429, "development_capacity_reached");
    this.sessions.set(session.id, structuredClone(session));
    return true;
  }
  async compareAndSwap(session: Session, expectedRevision: number) {
    const current = this.sessions.get(session.id);
    if (!current || current.revision !== expectedRevision || current.expiresAt <= this.now()) return false;
    this.sessions.set(session.id, structuredClone(session));
    return true;
  }
}

// One server-side Lua CAS maintains atomic event sequence, attempt idempotency,
// and expiry across serverless processes. No distributed process-local locks.
const CREATE = `
local ttl = tonumber(ARGV[2]) - tonumber(redis.call('TIME')[1]) * 1000
if ttl <= 0 then return 0 end
return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ttl) and 1 or 0
`;
const CAS = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local decoded = cjson.decode(current)
if decoded.revision ~= tonumber(ARGV[1]) then return 0 end
local ttl = tonumber(decoded.expiresAt) - tonumber(redis.call('TIME')[1]) * 1000
if ttl <= 0 then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl)
return 1
`;

// The order index and authorization record are committed in a single Lua command.
// Both use the SAME absolute payment expiry, never the shorter session TTL.
const CLAIM_PAYMENT = `
local ttl = tonumber(ARGV[2]) - tonumber(redis.call('TIME')[1]) * 1000
if ttl <= 0 then return 0 end
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ttl)
redis.call('SET', KEYS[2], ARGV[3], 'PX', ttl)
return 1
`;
const RECLAIM_PAYMENT = `
local current = redis.call('GET', KEYS[1])
if not current or redis.call('GET', KEYS[2]) ~= ARGV[3] then return 0 end
local decoded = cjson.decode(current)
local replacement = cjson.decode(ARGV[2])
local now = tonumber(ARGV[4])
if decoded.revision ~= tonumber(ARGV[1]) or decoded.order ~= replacement.order or
   decoded.digest ~= replacement.digest or decoded.leaseUntil > now or
   (decoded.state ~= 'processing' and decoded.state ~= 'pending') then return 0 end
if replacement.revision ~= decoded.revision + 1 or replacement.state ~= 'processing' or
   replacement.id ~= decoded.id or replacement.owner == decoded.owner or
   replacement.settlementEligible ~= decoded.settlementEligible then return 0 end
local ttl = tonumber(decoded.expiresAt) - tonumber(redis.call('TIME')[1]) * 1000
if ttl <= 0 then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl)
return 1
`;
const MARK_SETTLEMENT_ELIGIBLE = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local decoded = cjson.decode(current)
local replacement = cjson.decode(ARGV[2])
if decoded.revision ~= tonumber(ARGV[1]) or decoded.state ~= 'processing' or
   decoded.owner ~= replacement.owner or decoded.order ~= replacement.order or
   decoded.digest ~= replacement.digest or decoded.settlementEligible ~= false or
   replacement.settlementEligible ~= true or replacement.state ~= 'processing' or
   replacement.revision ~= decoded.revision + 1 then return 0 end
local ttl = tonumber(decoded.expiresAt) - tonumber(redis.call('TIME')[1]) * 1000
if ttl <= 0 then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl)
return 1
`;
const MARK_PAYMENT_PENDING = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local decoded = cjson.decode(current)
local replacement = cjson.decode(ARGV[2])
if decoded.revision ~= tonumber(ARGV[1]) or decoded.state ~= 'processing' or
   decoded.owner ~= replacement.owner or decoded.order ~= replacement.order or
   decoded.digest ~= replacement.digest or decoded.settlementEligible ~= true or
   replacement.settlementEligible ~= true or replacement.state ~= 'pending' or
   replacement.revision ~= decoded.revision + 1 then return 0 end
local ttl = tonumber(decoded.expiresAt) - tonumber(redis.call('TIME')[1]) * 1000
if ttl <= 0 then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl)
return 1
`;
const CONFIRM_PAYMENT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local decoded = cjson.decode(current)
local replacement = cjson.decode(ARGV[2])
if decoded.revision ~= tonumber(ARGV[1]) or decoded.state ~= 'processing' or
   decoded.owner ~= replacement.owner or decoded.order ~= replacement.order or
   decoded.digest ~= replacement.digest or decoded.settlementEligible ~= true or
   replacement.settlementEligible ~= true or replacement.revision ~= decoded.revision + 1 then return 0 end
local ttl = tonumber(decoded.expiresAt) - tonumber(redis.call('TIME')[1]) * 1000
if ttl <= 0 then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl)
return 1
`;

export class RedisStore implements SessionStore {
  readonly kind = "redis" as const;
  constructor(private readonly config: NonNullable<Config["redis"]>, private readonly fetcher: typeof fetch = fetch) {}
  private key(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new ApiError(400, "invalid_input");
    return `gann:v1:session:${id}`;
  }
  private async command(args: (string | number)[]): Promise<unknown> {
    let stage = "request";
    try {
      const response = await this.fetcher.call(globalThis, this.config.url, {
        method: "POST",
        // Workers supports manual/follow only; non-2xx below fails closed.
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(1800),
        headers: { Authorization: `Bearer ${this.config.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      if (!response.ok) {
        console.warn("gann_storage_failure", { stage: "http", status: response.status });
        unavailable();
      }
      stage = "body";
      const text = await boundedText(response.body, 256 * 1024, 1800);
      stage = "json";
      const result = JSON.parse(text) as { result?: unknown; error?: unknown };
      stage = "envelope";
      if (result.error || !("result" in result)) unavailable();
      return result.result;
    } catch (error) {
      // Only fixed categories: never log URL, token, command, response or error message.
      const kind = error instanceof Error && ["TypeError", "AbortError", "TimeoutError", "SyntaxError"].includes(error.name)
        ? error.name : "unavailable";
      console.warn("gann_storage_failure", { stage, kind });
      unavailable();
    }
  }
  private paymentKey(namespace: "authorization" | "order", id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new ApiError(400, "invalid_payment_key");
    // Shared hash tag keeps the atomic two-key claim in one Redis cluster slot.
    return `gann:v1:{payments}:${namespace}:${id}`;
  }
  private payment(value: unknown): PaymentRecord | null {
    if (value === null) return null;
    try {
      const record: unknown = JSON.parse(String(value));
      if (!validRecord(record)) unavailable();
      return record;
    } catch { unavailable(); }
  }
  async getPayment(id: string) {
    const record = this.payment(await this.command(["GET", this.paymentKey("authorization", id)]));
    if (record && record.id !== id) unavailable();
    return record;
  }
  async getOrderPayments(orders: string[]) {
    if (!orders.length) return [];
    if (orders.length > 64) unavailable();
    const ids = await this.command(["MGET", ...orders.map((order) => this.paymentKey("order", order))]);
    if (!Array.isArray(ids) || ids.length !== orders.length) unavailable();
    const present = ids.filter((id) => id !== null);
    if (!present.length) return orders.map(() => null);
    const records = await this.command(["MGET", ...present.map((id) => this.paymentKey("authorization", String(id)))]);
    if (!Array.isArray(records) || records.length !== present.length) unavailable();
    let index = 0;
    return ids.map((id, i) => {
      if (id === null) return null;
      const record = this.payment(records[index++]);
      // An index without its ledger record is corruption, NOT permission to pay again.
      if (!record || record.id !== id || record.order !== orders[i]) unavailable();
      return record;
    });
  }
  async claimPayment(record: PaymentRecord) {
    return (await this.command(["EVAL", CLAIM_PAYMENT, 2,
      this.paymentKey("authorization", record.id), this.paymentKey("order", record.order),
      JSON.stringify(record), record.expiresAt, record.id])) === 1;
  }
  async reclaimPayment(record: PaymentRecord, expectedRevision: number, now: number) {
    return (await this.command(["EVAL", RECLAIM_PAYMENT, 2,
      this.paymentKey("authorization", record.id), this.paymentKey("order", record.order),
      expectedRevision, JSON.stringify(record), record.id, now])) === 1;
  }
  async markSettlementEligible(record: PaymentRecord, expectedRevision: number) {
    return (await this.command(["EVAL", MARK_SETTLEMENT_ELIGIBLE, 1, this.paymentKey("authorization", record.id),
      expectedRevision, JSON.stringify(record)])) === 1;
  }
  async markPaymentPending(record: PaymentRecord, expectedRevision: number) {
    return (await this.command(["EVAL", MARK_PAYMENT_PENDING, 1, this.paymentKey("authorization", record.id),
      expectedRevision, JSON.stringify(record)])) === 1;
  }
  async confirmPayment(record: PaymentRecord, expectedRevision: number) {
    return (await this.command(["EVAL", CONFIRM_PAYMENT, 1, this.paymentKey("authorization", record.id),
      expectedRevision, JSON.stringify(record)])) === 1;
  }
  async get(id: string): Promise<Session | null> {
    const value = await this.command(["GET", this.key(id)]);
    if (value === null) return null;
    if (typeof value !== "string") unavailable();
    try {
      const session = JSON.parse(value) as Session;
      const gate = session.paymentAdmission;
      if (session.id !== id || !Number.isSafeInteger(session.revision) || !Number.isSafeInteger(session.expiresAt) ||
          !Array.isArray(session.events) || !session.attempts || !Array.isArray(session.deliveries) ||
          (gate !== undefined && (!/^[a-f0-9]{64}$/.test(gate.order) || !/^[a-f0-9]{64}$/.test(gate.authorization) ||
            !/^[a-f0-9]{64}$/.test(gate.digest) || !/^[a-f0-9-]{36}$/.test(gate.owner) || !Number.isSafeInteger(gate.leaseUntil) ||
            !["processing", "pending", "confirmed"].includes(gate.state)))) unavailable();
      return session;
    } catch { unavailable(); }
  }
  async create(session: Session) {
    return (await this.command(["EVAL", CREATE, 1, this.key(session.id), JSON.stringify(session), session.expiresAt])) === 1;
  }
  async compareAndSwap(session: Session, expectedRevision: number) {
    return (await this.command(["EVAL", CAS, 1, this.key(session.id), expectedRevision, JSON.stringify(session)])) === 1;
  }
}

export function createStore(config: Config): SessionStore {
  return config.redis ? new RedisStore(config.redis) : new MemoryStore(config.mode);
}
