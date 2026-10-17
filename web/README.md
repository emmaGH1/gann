# gann web — bounded server foundation

This is a real Next.js App Router / TypeScript application, not a completed paid demo. The landing and arena pages are intentionally unstyled placeholders pending the separate design review.

## Implemented

Contract v1 routes from `../docs/API_CONTRACT.md`:

- `POST /api/session`
- `POST /api/session/:id/inspect`
- `POST /api/session/:id/attempt`
- `POST /api/session/:id/finish`
- `GET /api/session/:id` (sanitized public viewer snapshot)
- `GET /api/health`
- `GET /api/s/:seller_id?session=:uuid&attempt=:uuid` (unpaid v2 challenge; attempt optional only for inspection)

Mutations require `X-Gann-Key`, JSON content type, a bounded body (16 KiB, streamed as well as declared), and strict schemas rejecting unknown fields. There is no browser mutation API, caller-provided URL, or credential bundled into a page. Unsupported methods, including seller `HEAD`, are explicitly rejected. API responses are private/no-store.

The server owns seller prices, canonical HTTPS resource URLs, event ordering, session expiry (24 hours), and per-session attempt idempotency. A repeated attempt ID with another seller returns `409`; retries of the same decision return the existing result. CAS retries are bounded. At most 64 attempts and 256 events are retained per run; local memory is limited to 1,000 runs. No signatures, payment payloads, submitted code guesses, broker keys, or fulfillment codes are included in public snapshots or event records. Session UUIDs are viewer capability links, not authenticated user accounts.

Scoring uses confirmed server-side delivery records, not client success/payment assertions. There is deliberately **no production writer for delivery records** in this slice. Wrong-code correction, same-code finish replay, incomplete-run grade cap, and five-check details are implemented. Test-only fixtures exercise the confirmed-delivery branch without claiming a real settlement.

## Critical paid-path limitation

**Paid fulfillment is hard-disabled.** `GANN_ENABLE_PAYMENTS` defaults to false; setting it to true does **not** enable an unfinished path. Health continues to report `payments: "disabled"`. The unpaid challenge explicitly warns callers not to authorize payment in this build.

- Signed requests to Atlas, Spark, and Ledger return non-success and never contact a facilitator.
- Signed Signal requests return `503 paid_fulfillment_not_implemented`.
- Payment requests require a matching recorded attempt, but that is only an order decision, not proof PayBox received anything.
- No `/verify`, `/settle`, RPC, startup discovery, or facilitator-capacity request is made by this implementation.
- Pending/unknown/invalid/unbound delivery states never count as confirmed settlement.

A real paid implementation still needs an atomic, durable authorization-identity-to-canonical-order claim, recovery of identical requests, cross-order reuse rejection, uncertain/pending outcome reconciliation without another authorization, and a confirmed-settlement-to-fulfillment commit before releasing the code. Keep trap settlement permanently disabled.

Do not simply put a database side effect in a `withX402` handler. The inspected `@x402/next@2.27.0` source invokes `routeHandler(request)` before `handleSettlement`, buffers the response, and only then calls `httpServer.processSettlement`. That response buffering does **not** roll back handler side effects. A facilitator `/verify` success is not settlement. We intentionally do not use that wrapper for premature delivery writes.

## Dependencies and reproducibility

Use Node **24.21.0** and pnpm **11.11.0**, pinned in `package.json`. From this directory:

```sh
export PATH=/home/builder/.nvm/versions/node/v24.21.0/bin:$HOME/.local/bin:$PATH
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
NEXT_TELEMETRY_DISABLED=1 pnpm build
```

This directory is its own pnpm workspace; installation does not require root workspace changes. `pnpm-workspace.yaml` allows only the installed esbuild build script. The committed lock pins transitives and registry integrity hashes. Direct pins include Next **16.4.2** (above the researched x402 Next peer floor of 16.2.6), React **19.3.1**, `@x402/core` / `@x402/evm` **2.27.0**, and `@payai/facilitator` **2.4.5**. PayAI is pinned for the selected integration but not invoked by the disabled paid path; `@x402/next` is source-reviewed rather than installed as a runtime wrapper.

Unpaid challenges use `ExactEvmScheme.parsePrice`, `x402ResourceServer.createPaymentRequiredResponse`, `PaymentRequiredV2Schema`, and the maintained SDK's header encoder/decoder. Atomic prices use the explicit Base-native USDC asset and EIP-712 domain from the official $0.01 example. No live facilitator support is fabricated or assumed by the local challenge builder.

## Server configuration

Configure privately in the server environment; never in a `NEXT_PUBLIC_*` variable or plugin bundle:

- `GANN_PUBLIC_ORIGIN`: canonical public HTTPS origin, no credentials/path/query/fragment/non-443 port. Localhost/IP origins are rejected.
- `GANN_BROKER_KEY`: strong random secret, 32–256 characters; the PayBox broker injects it into authenticated mutations.
- `GANN_PAY_TO`: real public Base receiving address (nonzero EVM address), never a private key. No placeholder/default recipient is supplied.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`: both required in production. Uses the conventional Upstash REST token variable name.
- `GANN_ENABLE_PAYMENTS`: optional literal `false`/`true`; false by default. Hard-disabled implementation gate still applies.

`src/server/runtime.ts` reads configuration lazily, so builds require no secrets or network. Missing configuration or persistence causes API `503`, not an ephemeral production fallback. `RedisStore` uses bounded HTTPS REST requests, namespaced keys, atomic Lua create/CAS, and absolute expiry preserved across mutations. Health probes the storage connection, never the facilitator. Expired records return `410` while still present; after Redis TTL eviction they are `404` (same non-usable outcome).

`MemoryStore` is labelled `memory-development` and allowed only for development/tests. Development APIs still need an actual configured origin, recipient, and broker key; no fake env values are auto-created. Local tests use an explicitly labelled in-process seller transport; it is not a deployed HTTPS proof. `inspect` makes a real unpaid GET to the configured origin, enforces a 1.5-second fetch timeout, rejects redirects, bounds response/header size, validates version/resource/recipient/asset/chain/amount, and logs only successfully parsed facts. Cold-start/Redis/end-to-end latency against the plugin's four-second fetch budget remains a hosted gate; Redis request timeouts and CAS retry limits are not a latency guarantee.

## Verification performed in this slice

- `pnpm install --frozen-lockfile`: passed with pnpm 11.11.0 after enabling esbuild in this directory's workspace config.
- `pnpm typecheck`: passed.
- `pnpm test`: **26 offline tests passed**. Coverage includes broker auth failures, strict/body-size validation, notfound/expired sessions, all four exact scenario prices, valid v2 challenges, canonical unpaid inspection and malformed challenges, attempt replay/body collision/concurrency, caller URL rejection, signed trap/disabled paid paths, HEAD rejection, wrong-code correction, viewer sanitization, refused-everything failure/grade cap, pending records, local CAS, Redis command shape/failure, and production fail-closed configuration.
- `NEXT_TELEMETRY_DISABLED=1 pnpm build`: passed; all seven API routes and the arena are dynamic. The build first caught a test helper type inference issue; corrected and checks rerun successfully.
- Bounded local production HTTP smoke (`next start` on 127.0.0.1): landing and arena returned 200; unconfigured health/session/seller APIs returned private/no-store 503. This proves route wiring/fail-closed behavior, not hosted connectivity.
- `pnpm audit --prod --audit-level high`: no known vulnerabilities reported at test time.

Redis adapter tests use a clearly labelled fake REST transport to validate command/CAS shape; they do not execute Lua in a real Redis service. Correct-code tests seed explicitly fake confirmed deliveries directly into the test store; no production endpoint can do this.

## Remaining gates — no success claimed

1. Configure authorized hosting and real persistence; test Redis Lua/TTL/CAS on the actual service.
2. Verify hosted unpaid challenge compatibility through the installed PayBox plugin, including cold-start and inspection latency.
3. Implement and independently review the durable, replay-safe settlement/fulfillment and uncertainty/reconciliation path before enabling payments.
4. Confirm actual facilitator capacity. PayAI's documented no-key allowance is finite, not guaranteed unlimited free capacity; no account or credit purchase is authorized here.
5. Obtain the human's explicit $0.01 approval for a single Signal payment, then separately prove settlement, delivery, and finish. Never approve a trap purchase.
6. Human design approval/browser inspection and later publication/submission remain outside this task.

Sources inspected: [official exact Base $0.01 example](https://docs.payai.network/x402/base-mainnet-express.md), [official Next guide](https://docs.payai.network/x402/servers/typescript/nextjs.md), installed `@x402/core@2.27.0` / `@x402/evm@2.27.0` source, and registry tarball source for `@x402/next@2.27.0`. No hosted validation, wallet interaction, settlement, delivery, deployment, account creation, or payment occurred.
