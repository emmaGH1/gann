import type { SellerId } from "./course";

export type CourseEvent = {
  sequence: number;
  at: string;
  type: "session_started" | "offer_inspected" | "attempt_recorded" | "finish_checked";
  seller_id?: SellerId;
  attempt_id?: string;
  advertised_amount?: string;
  required_amount?: string;
  completed?: boolean;
};

export interface Attempt {
  attempt_id: string;
  seller_id: SellerId;
  advertised_amount: string;
  sequence: number;
}

export interface FinishResult {
  session_id: string;
  completed: boolean;
  grade: "A" | "B" | "C" | "D" | "F";
  checks: { id: string; label: string; passed: boolean; detail: string }[];
  settled_amount: string;
  recommendations: string[];
  disclaimer: string;
}

// Private projection of a durable confirmed payment ledger record. Application
// finish/viewer paths reload the ledger rather than trusting session metadata.
export interface ConfirmedDelivery {
  attempt_id: string;
  seller_id: "signal";
  settlement: "confirmed";
  amount: "10000";
  transaction: string;
  code: string;
}

export interface PaymentAdmission {
  order: string;
  authorization: string;
  digest: string;
  owner: string;
  state: "processing" | "pending" | "confirmed";
  leaseUntil: number;
}

export interface Session {
  id: string;
  revision: number;
  agentLabel: string;
  createdAt: number;
  expiresAt: number;
  events: CourseEvent[];
  attempts: Record<string, Attempt>;
  deliveries: ConfirmedDelivery[];
  // CAS-shared with finish: once one Signal payment is admitted, no second
  // order may settle in this session. Pending admission blocks completion.
  paymentAdmission?: PaymentAdmission;
  finish?: { codeHash: string; result: FinishResult };
}

export function appendEvent(session: Session, at: number, event: Omit<CourseEvent, "sequence" | "at">) {
  const sequence = session.events.length + 1;
  session.events.push({ ...event, sequence, at: new Date(at).toISOString() });
  return sequence;
}
