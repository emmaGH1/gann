# Payment integration research — not a paid-path proof

Updated 2026-10-17. Source: bounded read-only delegated research. No transactions, deployments or account creation performed. Parent separately checked Vercel fair-use wording through web research.

## Candidate implementation
- Official proposal helper: Base eip155:8453, maxAmount 10000 atomic USDC ($0.01), fixed server-owned HTTPS seller URL, x402OutputSchema.
- Proposal envelope version 1 does NOT establish x402 wire version 1. Prefer maintained x402 v2 server packages, but confirm installed-plugin parser accepts challenge with unpaid hosted validation before claiming compatibility.
- PayAI exact flow supports Base. Candidate facilitator https://facilitator.payai.network (no /v1 prefix). Child observed unauthenticated supported/health reads, NOT a settlement.
- PayAI docs allow no-account/no-key exact usage within finite free allowance. Shared hosting may exhaust allowance; free capacity not guaranteed. Do not assume unlimited free or configure fake credentials.
- Candidate aligned SDKs from maintained example: @payai/facilitator 2.4.5; @x402/core and @x402/evm 2.27.0. @x402/next 2.27.0 has Next >=16.2.6 and @x402/paywall ^2.27.0 peers; verify installed packages before use.

## Critical semantics
- Plugin ends before approval/payment; agent polls PayBox request ID, never repeats buy to poll.
- /verify does not move money. Require successful server-to-facilitator settlement, not agent assertions or HTTP 200 alone.
- Middleware may execute handler before settlement and buffer output. Do not mark delivered or publish code in pre-settlement side effects. Require settlement-backed durable fulfillment record before finish can succeed.
- Atomically bind payment authorization identity to canonical run/order, and CAS-admit at most one Signal payment per session. Finish is blocked while that payment is unresolved. Identical retries recover the same outcome; the same authorization cannot unlock a different run. Fail closed on settlement uncertainty; never ask for a replacement payment.
- PayAI's current published OpenAPI describes an Idempotency-Key with a 24-hour window, identical-body settlement polling, and `settlement_pending` with a broadcast hash. The server uses deterministic request JSON, normalized address casing, one same-key/same-body immediate poll, and later retry of the same authorization after a lease/backoff. The actual PayAI matching/terminal behavior remains untested. Seller function duration (`maxDuration=60s`) and installed PayBox paid-fetch timeout need hosted tests; the plugin's 10-second tool limit is separate.

## Hosting decision and Cloudflare local check
Vercel Hobby is not a suitable assumption for this payment demo: its published fair-use guidance restricts Hobby to non-commercial use and explicitly lists requesting or processing visitor payments as commercial use. The exact controlled hackathon self-payment case is not expressly exempt, so do not deploy there without written permission or an eligible plan. Do not buy an upgrade without authorization.

Cloudflare Workers Free is the preferred free-hosting candidate: its published Workers pricing currently lists 100,000 requests/day and a 10 ms CPU-time limit per invocation, and does not describe the Workers Free tier as personal/non-commercial-only. Its general terms and AUP still apply; treat that as a better fit, not legal clearance. Local OpenNext compatibility is now wired with pinned `@opennextjs/cloudflare` 1.20.12, Wrangler 4.148.0 and Node compatibility. `pnpm cloudflare:build` succeeded; local Wrangler preview served the home page and health route (200), admitted a fixture session, and produced an unpaid Signal x402 v2 challenge (402) with payments disabled and development memory storage. Wrangler `deploy --dry-run` bundled the Worker/assets at 5,094.82 KiB total (1,044.93 KiB gzip) and exited without uploading. This is local compatibility evidence only—not a hosted deployment, installed-PayBox test, Redis durability test, free-tier CPU measurement, facilitator test, or payment proof. No account was created, and no deploy/tunnel was started.

The OpenNext cache overrides remain dummy and no KV/R2/Queue is configured because the app has no reviewed cache-revalidation need; durable sessions/payments still require separately configured hosted Redis. Free-tier CPU headroom, external Redis latency/durability, seller request wall-clock/PayBox timeout, and facilitator availability must be checked before any hosted unpaid test. The local compatibility date is 2026-10-13, the newest date supported by the pinned local `workerd` binary. Publishing still requires explicit human approval.

## Fallback
CDP production facilitator https://api.cdp.coinbase.com/platform/v2/x402 requires approved credentials. No keys provisioned. Reconcile original uncertain payments before changing facilitators.

## Current implementation / gates
- [x] Offline replay, duplicate, uncertain settlement, exact-body idempotency serialization, session payment-admission/finalization CAS, and trap/default-disabled behavior exercised with fake facilitator fixtures.
- [x] Payment Lua command shape tested against mock REST; a local Redis 7 smoke executed session/payment Lua with fixtures only.
- [ ] Independent review of the fixes for byte-identical idempotency bodies and admission/finalization race.
- [ ] Installed-plugin unpaid validation accepts intended challenge.
- [ ] Cloudflare Workers Free appears to be the preferred candidate, but confirm the user's account/terms and authorize publication; configure hosted Redis with durability/eviction/retention policy.
- [ ] Hosted Redis Lua/CAS/concurrency/failover/TTL behavior and payment timeout/latency verified.
- [ ] Facilitator capacity, PayAI idempotency/body matching and actual v2 verification/receipt behavior tested in the hosted environment.
- [ ] Human-approved $0.01 Signal-only installed-plugin purchase settles, survives replay and delivers code. No real payment yet.

## Sources
- https://developer.paybox.sh/requirements.md
- https://docs.paybox.sh/reference/mcp-tools.md
- https://facilitator.payai.network/supported
- https://facilitator.payai.network/developers.md
- https://facilitator.payai.network/openapi.json
- https://docs.payai.network/x402/facilitators/authentication.md
- https://docs.payai.network/x402/facilitators/pricing.md
- https://docs.payai.network/x402/facilitators/capacity-and-limits.md
- https://docs.payai.network/x402/base-mainnet-express.md
- https://docs.payai.network/x402/servers/typescript/nextjs.md
- https://vercel.com/docs/limits/fair-use-guidelines
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/
- https://opennext.js.org/cloudflare/get-started
- https://docs.cdp.coinbase.com/x402/seller/facilitator

The server pins the candidate SDK dependencies and validates the unpaid challenge offline. The real installed-plugin, hosted Redis, PayAI live flow and payment behaviors remain unverified.
