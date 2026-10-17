# gann web — durable, default-disabled payment slice

Real Next.js App Router / TypeScript application implementing the frozen [API contract](../docs/API_CONTRACT.md). UI pages remain untouched placeholders pending the separate design review. One public Cloudflare Workers Free deployment is authorized for unpaid validation; its home page responds, but the API currently returns `503 configuration_required` until production variables/secrets and hosted Redis are configured. **No successful hosted validation, hosted Redis, real facilitator call, cryptographic payment verification, settlement, or payment has been performed.** The Redis Lua was smoke-tested against a temporary local Redis 7 process with fixtures only.

## Implemented routes and boundaries

- `POST /api/session`, `/api/session/:id/inspect`, `/api/session/:id/attempt`, `/api/session/:id/finish`
- `GET /api/session/:id` — allowlisted public viewer, never code/signature/nonce/digest/transaction/credentials
- `GET /api/health` — storage probe; `configured` is configuration, **not** payment proof
- `GET /api/s/:seller_id?session=:uuid&attempt=:uuid` — local SDK-built v2 challenge or bounded paid handling; inspection alone may omit attempt

Mutations require broker-injected `X-Gann-Key`, JSON content type, bounded streamed bodies (16 KiB), strict schemas, and server-owned origin/prices/recipient. No caller-selected URL or payTo. Unsupported methods including seller HEAD fail. API responses are private/no-store. Sessions last 24 hours; CAS retries, events (256), attempts (64), and local memory capacity (1,000) are bounded. Attempts are decisions, never inferred PayBox receipt, rejection, approval, or payment.

## Paid implementation (off by default)

`GANN_ENABLE_PAYMENTS` defaults to **false**. Disabled signed Signal requests return `503 payments_disabled` without contacting the facilitator. Signed Atlas, Spark, and Ledger requests always fail; trap sellers can **never** reach verify/settle, regardless of toggle. Setting the toggle true now selects real code, not the previous hard-disabled placeholder. **Do not enable hosted payments before independent review and the remaining gates below.**

The supported paid scope is deliberately narrow: **x402 v2 exact EIP-3009, Base mainnet `eip155:8453`, native USDC, exactly 10000 atomic units ($0.01), recorded Signal attempt, configured nonzero recipient**. Legacy `X-PAYMENT`, v1 payloads, Permit2, caller changes to requirements/resource/recipient/amount/asset/chain/domain, unbounded authorization lifetimes, and ambiguous/duplicate headers are rejected. Combined payment headers are limited to 16 KiB. EOA compact/65-byte signatures are supported structurally; contract-wallet signatures and other mechanisms are not enabled.

### Ordering and persistence

1. Decode with pinned x402 SDK, validate exact payload/requirements against **server-owned** requirements and canonical order URL, and compute a canonical signed-payload digest. First-use authorization must be currently valid and expire within 60 seconds.
2. Check the durable authorization and order indexes **before re-verifying**, so an already-spent/expired authorization can still recover its previously confirmed delivery.
3. `/verify` must return literal `isValid: true` and the expected payer. It is not settlement and creates no delivery.
4. After verification, atomically claim **both** the global authorization identity (`Base + USDC + payer + EIP-3009 nonce`) and canonical order key, then CAS-admit one Signal payment per session. A separate durable `settlementEligible` CAS is written only after admission succeeds; claims that lose admission remain ineligible and cannot block finish or sessionless recovery. The same session CAS serializes admission with finish: an eligible pending payment blocks finish, and a different Signal order cannot settle after one order has been admitted/confirmed. Different order/session reuse is rejected; changed signed digest cannot recover a code; a replacement authorization cannot bypass the same order's pending state.
5. Only an eligible claim owner calls `/settle` with a stable idempotency key derived from the authorization. An uncertain/pending result may be polled once immediately using the exact same payload, normalized requirements, key, and deterministic JSON serialization. The 55-second lease and 5-second pending backoff permit takeover only for that same authorization/order; they do not authorize a replacement payment. Same-order concurrent duplicates return pending or recover the stored result.
6. Only literal facilitator success with expected network, payer, optional exact amount, and nonzero 32-byte transaction hash can create a confirmed record. Facilitator errors, timeouts, pending, mismatched or malformed responses remain uncertain; only sanitized transaction/error evidence is retained.
7. Generate a private random code **after** confirmed settlement, persist sanitized receipt plus code with owner/revision/order/digest CAS, then read back the durable record **before** returning code and the SDK-encoded v2 `PAYMENT-RESPONSE`. No code is ever generated in a pre-settlement handler, event, error, or public viewer.
8. Finish and viewer read the actual payment ledger. Plausible session-only delivery metadata and client paid assertions cannot complete a mission. Repeated identical authorized requests recover the same code/receipt, including after the original authorization/session expires or the session record is TTL-evicted. An unavailable session permits only existing digest-bound ledger recovery, never a new payment.

`MemoryStore` is tests/development only and rejects production. `RedisStore` uses bounded authenticated HTTPS REST with atomic Lua claim/CAS. Payment keys use independent namespaces `gann:v1:{payments}:authorization:<hash>` and `gann:v1:{payments}:order:<hash>` (one Redis cluster slot). Both keys retain the same absolute expiry: **max(authorization expiry, session expiry) + 30 days**. They are never tied to shortened session TTL. No raw signatures or signed payloads are persisted or logged; the private ledger stores only identity/order/digest, ownership, sanitized receipt and the code. Session expiry does not release an outstanding authorization for another order. Local memory retains payment claims rather than evicting outstanding payments to admit new ones.

### Uncertainty and explicit recovery

After any settlement call, non-confirmation is **not a claimed failed payment**. Responses are `202 payment_pending` with instructions to retry the **identical signed request for the original order**; never authorize a replacement payment. The server performs at most one immediate same-body/idempotency-key poll per request; a later identical retry can reclaim after the 5-second pending backoff or 55-second processing lease. A non-retryable facilitator failure is retained as pending too. Unsigned requests for claimed orders return 202 without a fresh `PAYMENT-REQUIRED`. Pending admitted settlement blocks finish and a session cannot admit a second Signal order. Sessionless recovery can reconcile only claims whose durable eligibility bit proves the session gate had succeeded before any `/settle` call. If confirmation committed but its acknowledgement was lost, an identical retry or matching-ledger finish repairs the session gate and recovers the original durable code.

PayAI's published API documents the `Idempotency-Key` header (24-hour window), identical-body `/settle` polling, and `settlement_pending` responses with a broadcast hash. The implementation uses a stable authorization-derived key and deterministic wire JSON; **actual PayAI idempotency/body-conflict behavior is still untested**. Once repeated same-authorization polls remain unresolved, operator reconciliation is still required: inspect the original private ledger, reconcile through PayAI and Base/native-USDC transaction evidence, and use independently reviewed tooling to bind any proven settlement and commit one delivery. Do not delete claims, shorten retention, switch facilitators, invent a transaction, or take another payment to resolve uncertainty. The 30-day record retention is not an automated recovery guarantee; outstanding incidents need a reviewed procedure before expiry.

## SDK and facilitator transport

Pinned direct dependencies: Node **24.21.0**, pnpm **11.11.0**, Next **16.4.2**, React **19.3.1**, `@x402/core` / `@x402/evm` **2.27.0**, `@payai/facilitator` **2.4.5**. Full tooling pins and lockfile retained; no dependency/root changes in this slice.

Unpaid construction uses `ExactEvmScheme.parsePrice`, `x402ResourceServer.createPaymentRequiredResponse`, SDK schema validation and header encoding. Payment decoding/response encoding use the maintained core SDK. `src/server/facilitator.ts` provides an injectable facilitator interface and manual v2 transport using the pinned PayAI config/authentication adapter and core types. Transport is fixed to `https://facilitator.payai.network/{verify,settle}`, rejects redirects, bounds verification to 4s and settlement to 20s plus 3s response-body reading, and caps bodies at 16 KiB. Settlement is polled at most once immediately with the same idempotency key/body; there is no startup discovery. Seller route `maxDuration` is 60 seconds. Configuration/credentials stay server-side. SDK interfaces/source were inspected before implementing: the core HTTP client follows redirects/reads unbounded bodies, while the resource-server settlement helper can retry pending settlement; neither is used.

Do **not** substitute a database side effect inside `withX402`: the inspected Next SDK runs the handler before settlement. `/verify` is not a paid delivery.

## Configuration and reproducible checks

Configure privately, never as `NEXT_PUBLIC_*` or plugin fields:

- `GANN_PUBLIC_ORIGIN`: canonical HTTPS origin, no credentials/path/query/fragment/non-443 port; localhost/IP rejected.
- `GANN_BROKER_KEY`: strong random secret, 32–256 characters; injected by the PayBox broker.
- `GANN_PAY_TO`: real nonzero public Base receiving address, not a private key.
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`: both required in production; never an ephemeral production fallback.
- `GANN_ENABLE_PAYMENTS`: literal `false`/`true`, defaults **false**. Leave false until independently reviewed and authorized.
- Optional PayAI server credentials: `PAYAI_API_KEY_ID` / `PAYAI_API_KEY_SECRET` via the pinned adapter. No account/key is created here. Finite no-key capacity is not guaranteed.

Lazy runtime configuration means builds require no secrets or network. Missing config/persistence fails closed with 503. Health probes storage, never facilitator. Session APIs return 410 while expired records remain, then 404 after TTL eviction. No new payment is allowed then; the original signed seller request can still recover an existing durable delivery/pending state while payment evidence is retained and the paid path is enabled. Backend/facilitator/Redis/end-to-end cold-start latency and paid fetch timeouts remain hosted gates, not local guarantees.

```sh
export PATH=/home/builder/.nvm/versions/node/v24.21.0/bin:$HOME/.local/bin:$PATH
cd web
pnpm --version # 11.11.0 (run in this workspace)
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
NEXT_TELEMETRY_DISABLED=1 pnpm build
cd ../plugin
pnpm test:unit
```

## Cloudflare Workers adapter (local evaluation only)

OpenNext is wired through `open-next.config.ts` and `wrangler.jsonc` for Cloudflare Workers, with `nodejs_compat` and static assets. No KV/R2/Queue cache binding is configured; OpenNext uses its dummy cache overrides. Durable session/payment state still requires separately configured Redis. The optional `rclone.js` peer is intentionally omitted because this app does not use remote R2 cache population. Wrangler declares `NODE_ENV`, `GANN_PUBLIC_ORIGIN`, and `GANN_ENABLE_PAYMENTS=false`; `keep_vars` preserves dashboard-managed values such as `GANN_PAY_TO`. Secrets are never stored in Wrangler config.

To run a local production-worker preview with **fake development-only values**, copy `wrangler.vars.example` to `.dev.vars` (the actual `.dev.vars` file is ignored), then:

```sh
pnpm install --frozen-lockfile
pnpm cloudflare:build
pnpm cloudflare:preview
```

`cloudflare:preview` builds and starts Wrangler locally on `127.0.0.1`; it does not publish or expose a tunnel. The local-only fixtures enable in-memory development storage and keep payments disabled. Never use them as hosted credentials. A single public deployment was made with the user's explicit authorization; there is deliberately no automatic deployment script. Future deployments still require authorization.


Pinned adapter/Wrangler compatibility was tested locally on 2026-10-17 with compatibility date 2026-10-13, the newest date supported by the pinned local `workerd` runtime. A Wrangler `deploy --dry-run` bundled the Worker/assets at 5,094.82 KiB total (1,044.93 KiB gzip) and exited without uploading. The Worker Free tier currently documents 100,000 requests/day and 10 ms CPU per invocation; actual hosted CPU headroom has not been measured. Local build/preview success does not establish hosted Redis persistence, free-tier capacity, PayBox compatibility, payment timeout behavior, or facilitator behavior. See [hosting research](../docs/INTEGRATION.md).

## Verification for this slice

- `pnpm typecheck`: passed.
- `pnpm test`: **49 offline tests passed** (Node 24.21.0), including success -> durable delivery -> correct-code finish, exact-body idempotency serialization, pending recovery/evidence retention, admission/finish CAS and confirmed-ledger gate repair, overlapping distinct-order/expired-session rejection, durable settlement-eligibility CAS, pre-claim failure recovery, verification rejection/no settle, malformed receipts, cross-order/session replay, default toggle/traps, private viewer sanitization and Redis Lua command shape/corruption.
- `NEXT_TELEMETRY_DISABLED=1 pnpm build`: passed (routes dynamic where required).
- `cd plugin && pnpm test:unit`: **22 offline tests passed**, including **4 actual plugin/application-handler integration tests** using simulated broker/HTTPS transport. These do not exercise paid PayBox fetches or live payments.

Paid tests inject a clearly labelled fake facilitator; they do **not** perform cryptographic signature verification, on-chain settlement, or prove external facilitator behavior. Redis tests validate command shape with fake REST transports; a separate one-off smoke executed session/payment Lua against local Redis 7, but does **not** prove Upstash/hosted cluster behavior, durability or failover. Earlier correct-code fixtures are explicitly test-only durable ledger records. No live payments occurred. The authorized Cloudflare deployment is currently unconfigured; no Cloudflare or Upstash account was created by this project.

## Remaining gates — no integration success inferred

1. Independent review rounds 3–5 found and helped close P2 issues in idempotency body identity, admission/finalization and ineligible-claim recovery. Round 6 found no remaining concrete blocker in the paid code. This is offline code review, not payment certification; prepare a reviewed operator-reconciliation procedure before any enablement.
2. Authorized compliant hosting, real Redis Lua/TTL/CAS/concurrency tests, durable retention/incident procedure, and storage reliability.
3. Hosted unpaid challenge compatibility through the installed PayBox plugin, capacity and cold-start/inspection latency.
4. Actual facilitator v2/payer/receipt behavior and available capacity, paid fetch timeout behavior and any officially supported reconciliation/idempotency contract. No assumptions from local mocks.
5. Only after authorization: one human-approved Signal **$0.01** payment, separately proving settlement, durable code recovery and finish. Total ceiling $5. Never approve traps.
6. Separate human design approval/browser inspection, publication and submission gates remain outside this slice.
