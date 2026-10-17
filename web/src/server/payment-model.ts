import type { SettleResponse } from "@x402/core/types";

// Private durable ledger. Never contains a signed payload, signature, or code guess.
// Authorization identity is global (not session-scoped); the order index prevents
// a replacement authorization from bypassing an uncertain original settlement.
export interface PaymentRecord {
  id: string;
  order: string;
  resource: string;
  session: string;
  attempt: string;
  digest: string;
  version: 2;
  network: "eip155:8453";
  asset: string;
  payTo: string;
  amount: "10000";
  payer: string;
  nonce: string;
  validBefore: number;
  expiresAt: number;
  revision: number;
  owner: string;
  leaseUntil: number;
  // True only after session admission was CAS-persisted before any settle call.
  // Sessionless recovery must never make an unadmitted claim settleable.
  settlementEligible: boolean;
  state: "processing" | "pending" | "confirmed";
  receipt?: SettleResponse;
  code?: string;
  // Sanitized non-terminal settlement evidence only; never a signed payload.
  pendingTransaction?: string;
  pendingReason?: string;
}

export interface PaymentStore {
  getPayment(id: string): Promise<PaymentRecord | null>;
  getOrderPayments(orders: string[]): Promise<(PaymentRecord | null)[]>;
  // Atomic across BOTH independent namespaces, including across sessions.
  claimPayment(record: PaymentRecord): Promise<boolean>;
  reclaimPayment(record: PaymentRecord, expectedRevision: number, now: number): Promise<boolean>;
  markSettlementEligible(record: PaymentRecord, expectedRevision: number): Promise<boolean>;
  markPaymentPending(record: PaymentRecord, expectedRevision: number): Promise<boolean>;
  confirmPayment(record: PaymentRecord, expectedRevision: number): Promise<boolean>;
}

export function validRecord(value: unknown): value is PaymentRecord {
  if (!value || typeof value !== "object") return false;
  const p = value as PaymentRecord;
  return /^[a-f0-9]{64}$/.test(p.id) && /^[a-f0-9]{64}$/.test(p.order) &&
    /^[a-f0-9]{64}$/.test(p.digest) && p.version === 2 && p.network === "eip155:8453" && p.amount === "10000" &&
    /^0x[0-9a-fA-F]{40}$/.test(p.asset) && /^0x[0-9a-fA-F]{40}$/.test(p.payTo) && !/^0x0{40}$/i.test(p.payTo) &&
    /^0x[0-9a-fA-F]{40}$/.test(p.payer) && /^0x[0-9a-fA-F]{64}$/.test(p.nonce) &&
    typeof p.resource === "string" && typeof p.session === "string" && typeof p.attempt === "string" &&
    typeof p.owner === "string" && typeof p.settlementEligible === "boolean" && Number.isSafeInteger(p.validBefore) && Number.isSafeInteger(p.leaseUntil) &&
    Number.isSafeInteger(p.expiresAt) && Number.isSafeInteger(p.revision) &&
    (p.pendingTransaction === undefined || /^0x[0-9a-fA-F]{64}$/.test(p.pendingTransaction)) &&
    (p.pendingReason === undefined || /^[a-z0-9_]{1,80}$/.test(p.pendingReason)) &&
    ["processing", "pending", "confirmed"].includes(p.state) &&
    (p.state !== "confirmed" || p.settlementEligible);
}
