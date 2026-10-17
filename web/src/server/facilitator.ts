import { createFacilitatorConfig } from "@payai/facilitator";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { boundedText } from "./http";

export interface Facilitator {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements, idempotencyKey: string): Promise<SettleResponse>;
}

// Idempotent settlement retries must have identical wire bytes, not merely JSON
// values. Sort every object key and normalize case-insensitive EVM addresses.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// Manual transport uses the pinned PayAI authentication adapter and x402 core wire
// types. The core HTTP client follows redirects and reads unbounded response bodies;
// here signed requests stay on one fixed HTTPS host with bounded time/body and no
// startup discovery. PayAI documents identical-body settlement polling and a
// 24-hour Idempotency-Key; callers may retry only the exact same payload/key.
export function payAIFacilitator(fetcher: typeof fetch = fetch): Facilitator {
  const config = createFacilitatorConfig();
  async function post<T>(operation: "verify" | "settle", payload: PaymentPayload, requirements: PaymentRequirements, idempotencyKey?: string): Promise<T> {
    const auth = await config.createAuthHeaders?.();
    const headers = new Headers({ "Content-Type": "application/json", ...auth?.[operation] });
    if (operation === "settle") {
      if (!idempotencyKey || !/^[a-f0-9]{64}$/.test(idempotencyKey)) throw new Error("invalid_idempotency_key");
      headers.set("Idempotency-Key", idempotencyKey);
    }
    const timeoutMs = operation === "settle" ? 20_000 : 4_000;
    const stableRequirements = { ...requirements,
      ...(requirements.asset ? { asset: requirements.asset.toLowerCase() } : {}),
      ...(requirements.payTo ? { payTo: requirements.payTo.toLowerCase() } : {}),
    };
    const stablePayload = { ...payload, accepted: { ...payload.accepted,
      asset: payload.accepted.asset.toLowerCase(), payTo: payload.accepted.payTo.toLowerCase(),
    } };
    const response = await fetcher(`https://facilitator.payai.network/${operation}`, {
      method: "POST", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
      headers,
      body: stableJson({ x402Version: 2, paymentPayload: stablePayload, paymentRequirements: stableRequirements }),
    });
    if (response.status >= 300 && response.status < 400) throw new Error("facilitator_redirect_rejected");
    // PayAI OpenAPI specifies structured JSON even on non-2xx settlement
    // responses; settlement_pending may carry a broadcast transaction hash.
    const text = await boundedText(response.body, 16 * 1024, 3_000);
    let result: unknown;
    try { result = JSON.parse(text); } catch { throw new Error("invalid_facilitator_response"); }
    if (!response.ok && operation === "verify") throw new Error("facilitator_verification_unavailable");
    if (!result || typeof result !== "object") throw new Error("invalid_facilitator_response");
    return result as T;
  }
  return {
    verify: (payload, requirements) => post("verify", payload, requirements),
    settle: (payload, requirements, idempotencyKey) => post("settle", payload, requirements, idempotencyKey),
  };
}
