import type * as z from "zod/v4";

export type Fetch = typeof globalThis.fetch;
export type Environment = Record<string, string | undefined>;
const MAX_RESPONSE_BYTES = 128 * 1024;

export class GannError extends Error {
  constructor(public readonly code: string) { super(code); }
}

/** Non-sensitive origin only. Auth is injected by PayBox's host-scoped broker. */
export function apiOrigin(env: Environment): string {
  const value = env.GANN_API_BASE;
  if (!value) throw new GannError("api_not_configured");
  let url: URL;
  try { url = new URL(value); } catch { throw new GannError("invalid_api_origin"); }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new GannError("invalid_api_origin");
  }
  return url.origin;
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new GannError("response_too_large");
  }
  if (!response.body) throw new GannError("invalid_service_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new GannError("response_too_large");
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new GannError("invalid_service_response"); }
}

export function createClient(env: Environment, fetchImpl: Fetch = globalThis.fetch) {
  return {
    origin: () => apiOrigin(env),
    async post<T extends z.ZodType>(path: string, body: unknown, schema: T): Promise<z.output<T>> {
      const origin = apiOrigin(env);
      // Paths are internally constructed from schema-validated IDs, never merchant URLs.
      if (!path.startsWith("/api/") || path.includes("..") || path.includes("\\")) throw new GannError("invalid_api_path");
      let response: Response;
      try {
        response = await fetchImpl(new URL(path, origin), {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify(body),
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(4000),
        });
      } catch { throw new GannError("service_unavailable"); }
      if (!response.ok) {
        await response.body?.cancel();
        const code = response.status === 401 || response.status === 403 ? "broker_access_denied" :
          response.status === 404 || response.status === 410 ? "session_unavailable" :
          response.status === 409 ? "decision_conflict" : "service_error";
        throw new GannError(code);
      }
      let parsed: ReturnType<T["safeParse"]>;
      try { parsed = schema.safeParse(await boundedJson(response)) as ReturnType<T["safeParse"]>; }
      catch (error) {
        if (error instanceof GannError) throw error;
        throw new GannError("invalid_service_response");
      }
      if (!parsed.success) throw new GannError("invalid_service_response");
      return parsed.data as z.output<T>;
    },
  };
}
