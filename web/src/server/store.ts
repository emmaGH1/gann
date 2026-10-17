import type { Config } from "./config";
import type { Session } from "./model";
import { ApiError, unavailable } from "./errors";
import { boundedText } from "./http";

export interface SessionStore {
  readonly kind: "memory-development" | "redis";
  get(id: string): Promise<Session | null>;
  create(session: Session): Promise<boolean>;
  compareAndSwap(session: Session, expectedRevision: number): Promise<boolean>;
}

export class MemoryStore implements SessionStore {
  readonly kind = "memory-development" as const;
  private readonly sessions = new Map<string, Session>();
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

export class RedisStore implements SessionStore {
  readonly kind = "redis" as const;
  constructor(private readonly config: NonNullable<Config["redis"]>, private readonly fetcher: typeof fetch = fetch) {}
  private key(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new ApiError(400, "invalid_input");
    return `gann:v1:session:${id}`;
  }
  private async command(args: (string | number)[]): Promise<unknown> {
    try {
      const response = await this.fetcher(this.config.url, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(1800),
        headers: { Authorization: `Bearer ${this.config.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      if (!response.ok) unavailable();
      const text = await boundedText(response.body, 256 * 1024, 1800);
      const result = JSON.parse(text) as { result?: unknown; error?: unknown };
      if (result.error || !("result" in result)) unavailable();
      return result.result;
    } catch { unavailable(); }
  }
  async get(id: string): Promise<Session | null> {
    const value = await this.command(["GET", this.key(id)]);
    if (value === null) return null;
    if (typeof value !== "string") unavailable();
    try {
      const session = JSON.parse(value) as Session;
      if (session.id !== id || !Number.isSafeInteger(session.revision) || !Number.isSafeInteger(session.expiresAt) ||
          !Array.isArray(session.events) || !session.attempts || !Array.isArray(session.deliveries)) unavailable();
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
