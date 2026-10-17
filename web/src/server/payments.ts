import { x402ResourceServer } from "@x402/core/server";
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import { PaymentRequiredV2Schema } from "@x402/core/schemas";
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

export async function unpaidChallenge(config: Config, seller: SellerId, resource: string) {
  const price = await scheme.parsePrice({
    amount: SELLERS[seller].required,
    asset: USDC,
    extra: { name: "USD Coin", version: "2" },
  }, CHAIN);
  const required = await resourceServer.createPaymentRequiredResponse([
    {
      scheme: "exact", network: CHAIN, amount: price.amount, asset: price.asset,
      payTo: config.payTo, maxTimeoutSeconds: 60, extra: price.extra ?? {},
    },
  ], { url: resource, description: SELLERS[seller].description, mimeType: "application/json" },
  "Payment required. Paid fulfillment is disabled in this build; do not authorize a payment.");
  PaymentRequiredV2Schema.parse(required);
  return json(required, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) });
}

export async function inspectLive(config: Config, seller: SellerId, session: string, fetcher: typeof fetch) {
  const url = resourceUrl(config, seller, session);
  try {
    const response = await fetcher(url, {
      method: "GET", redirect: "error", cache: "no-store",
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

// PAID PATH BLOCKER: a durable authorization-to-order claim + uncertainty
// reconciliation + confirmed-settlement-to-fulfillment commit is not implemented.
// A generic withX402 handler runs BEFORE settlement and must NOT create delivery
// records. /verify alone is not payment. Even enablePayments=true cannot bypass
// this hard gate. No SDK client capable of transmitting a payment is instantiated.
export const PAID_PATH_READY = false;
