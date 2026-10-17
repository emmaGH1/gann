import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ApiError } from "./errors";

export const MAX_BODY = 16 * 1024;
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Gann-Key, Payment-Signature, PAYMENT-SIGNATURE",
  "Access-Control-Expose-Headers": "Payment-Required, PAYMENT-REQUIRED, Payment-Response, PAYMENT-RESPONSE",
};
export const NO_STORE = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  ...CORS,
};

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { ...NO_STORE, ...headers } });
}

export function authenticate(request: Request, key: string) {
  const rawAuth = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const given = request.headers.get("x-gann-key") ?? rawAuth ?? "";
  // Hashing normalizes lengths before timingSafeEqual; no secret is echoed.
  const hash = (value: string) => createHash("sha256").update(value).digest();
  if (!given || given.length > 256 || !timingSafeEqual(hash(given), hash(key))) {
    throw new ApiError(401, "unauthorized");
  }
}

export async function boundedText(stream: ReadableStream<Uint8Array> | null, maxBytes: number, timeoutMs = 2000): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new ApiError(413, "body_too_large");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ApiError(408, "body_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

export async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")) {
    throw new ApiError(415, "json_required");
  }
  if (request.headers.has("content-encoding")) throw new ApiError(415, "encoding_not_supported");
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw new ApiError(413, "body_too_large");
  const text = await boundedText(request.body, MAX_BODY);
  let input: unknown;
  try { input = JSON.parse(text); } catch { throw new ApiError(400, "invalid_json"); }
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "invalid_input");
  return parsed.data;
}

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_input");
  return parsed.data;
}

export const uuid = z.string().uuid().transform((id) => id.toLowerCase());
