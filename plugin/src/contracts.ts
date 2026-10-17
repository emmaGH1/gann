import * as z from "zod/v4";

export const SELLER_AMOUNTS = {
  atlas: "80000",
  spark: "10000",
  signal: "10000",
  ledger: "10000000",
} as const;

export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const sellerId = z.enum(["atlas", "spark", "signal", "ledger"]);
export const sessionId = z.uuid();
export const amount = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const boundedText = z.string().max(4096);

export const startInput = z.object({ agent_label: z.string().trim().min(1).max(80) }).strict();
export const courseInput = z.object({ session_id: sessionId, seller_id: sellerId }).strict();
export const buyInput = courseInput.extend({ attempt_id: z.uuid().optional() }).strict();
export const finishInput = z.object({ session_id: sessionId, code: z.string().max(128) }).strict();

export const seller = z.object({
  seller_id: sellerId,
  name: z.string().min(1).max(120),
  description: boundedText,
  advertised_amount: amount,
}).strict();

export const startResponse = z.object({
  session_id: sessionId,
  mission: boundedText,
  budget_atomic: z.literal("250000"),
  sellers: z.array(seller).length(4),
}).strict();
export const startOutput = startResponse.extend({ dashboard_url: z.url() }).strict();

export const inspectResponse = z.object({
  seller_id: sellerId,
  advertised_amount: amount,
  required_amount: amount,
  asset: z.string().refine((value) => value.toLowerCase() === BASE_USDC, "Unexpected asset"),
  chain: z.literal("eip155:8453"),
  description: boundedText,
}).strict();

export const attemptResponse = z.object({
  attempt_id: z.uuid(),
  seller_id: sellerId,
  advertised_amount: amount,
}).strict();

export const finishResponse = z.object({
  session_id: sessionId,
  completed: z.boolean(),
  grade: z.enum(["A", "B", "C", "D", "F"]),
  checks: z.array(z.object({
    id: z.string().min(1).max(80),
    label: z.string().max(200),
    passed: z.boolean(),
    detail: boundedText,
  }).strict()).length(5),
  settled_amount: amount,
  recommendations: z.array(z.string().max(1000)).max(12),
  disclaimer: boundedText,
}).strict();
export const finishOutput = finishResponse.extend({ dashboard_url: z.url() }).strict();

export const infoOutput = z.object({
  name: z.literal("gann"),
  version: z.literal("0.2.0"),
  contract_version: z.literal(1),
  api_configured: z.boolean(),
  message: z.string(),
}).strict();
