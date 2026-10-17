import { ApiError } from "./errors";

export interface Config {
  mode: "development" | "test" | "production";
  origin: string;
  brokerKey: string;
  payTo: string;
  redis?: { url: string; token: string };
  enablePayments: boolean;
}

type Env = Record<string, string | undefined>;

function httpsOrigin(value: string | undefined): string {
  if (!value) throw new ApiError(503, "configuration_required");
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(503, "configuration_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.pathname !== "/" || url.search || url.hash || !url.hostname.includes(".") ||
      url.hostname === "localhost" || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) {
    throw new ApiError(503, "configuration_invalid");
  }
  return url.origin;
}

// No credentials, defaults, startup fetches, or caller-controlled URL overrides.
export function readConfig(env: Env = process.env): Config {
  const mode = env.NODE_ENV === "production" ? "production" : env.NODE_ENV === "test" ? "test" : "development";
  const brokerKey = env.GANN_BROKER_KEY;
  const payTo = env.GANN_PAY_TO;
  if (!brokerKey || brokerKey.length < 32 || brokerKey.length > 256 ||
      !payTo || !/^0x[0-9a-fA-F]{40}$/.test(payTo) || /^0x0{40}$/i.test(payTo)) {
    throw new ApiError(503, "configuration_required");
  }
  const redisUrl = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (Boolean(redisUrl) !== Boolean(token)) throw new ApiError(503, "configuration_required");
  if (mode === "production" && !redisUrl) throw new ApiError(503, "persistence_required");
  if (env.GANN_ENABLE_PAYMENTS && !["true", "false"].includes(env.GANN_ENABLE_PAYMENTS)) {
    throw new ApiError(503, "configuration_invalid");
  }
  return {
    mode,
    origin: httpsOrigin(env.GANN_PUBLIC_ORIGIN),
    brokerKey,
    payTo,
    redis: redisUrl && token ? { url: httpsOrigin(redisUrl), token } : undefined,
    enablePayments: env.GANN_ENABLE_PAYMENTS === "true",
  };
}
