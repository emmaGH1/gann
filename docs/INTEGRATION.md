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
- Atomically bind payment authorization identity to canonical run/order. Identical retries recover same outcome; same authorization cannot unlock a different run. Fail closed on settlement uncertainty, preserve original attempt and reconcile rather than requesting fresh payment.
- PayAI can report settlement_pending; seller function duration and PayBox paid-fetch timeout need testing. Ten-second plugin limit is separate from paid seller settlement.

## Hosting decision needed
Vercel Hobby restricted to non-commercial use. Published examples of commercial usage include requesting/processing visitor payments. Exact controlled self-payment hackathon case is not expressly exempt; do not assume permission or assert a definitive case-specific legal conclusion. Ask user's plan; no paid upgrade without authorization. Use permitted host or obtain clarification before deployment. This affects hosting, not the approved product concept.

## Fallback
CDP production facilitator https://api.cdp.coinbase.com/platform/v2/x402 requires approved credentials. No keys provisioned. Reconcile original uncertain payments before changing facilitators.

## Gate checklist
- [ ] Installed-plugin unpaid validation accepts intended challenge.
- [ ] Hosting plan/use permitted and publication authorized.
- [ ] Facilitator capacity verified from deployed server.
- [ ] Replay/duplicate/uncertain settlement tested offline.
- [ ] Human-approved $0.01 installed-plugin purchase settles and delivers code.

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
- https://docs.cdp.coinbase.com/x402/seller/facilitator

All dependency pins/compatibility above are research candidates, not installed or integration-tested server dependencies yet.
