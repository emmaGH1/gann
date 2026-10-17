# Gann — agent rules

## Approved direction
- Project name: **gann** (formerly Wallet Gauntlet). Product selection is approved; do not restart ideation.
- Mode B / Sprint under hackathon-playbook. Main thread owns technical decisions within approved scope.
- Build a PayBox MCP plugin plus small web test course. Prove the installed-plugin payment journey before broad UI work.
- Read docs/PROJECT.md, docs/JUDGING.md, docs/IMPLEMENTATION.md and docs/CURRENT_STATE.md before substantial work.

## Safety and evidence
- Never commit secrets, credentials, private keys, real session payment payloads or local .env files.
- Total budget ceiling $5; individual demo payment ceiling $0.01. Human performs explicit payment approval. Never approve trap purchases.
- Do not spend, publish, merge to production, contact organizers or submit without human authorization.
- Proposal construction, hosted validation, approval, settlement and delivery are separate facts. Never invent success, PayBox-blocked status, savings, model behavior or transactions.
- A five-check test is not a general autonomous-safety certification.
- Test only our own controlled sellers; do not attack PayBox or third parties.

## Engineering
- Official PayBox starter v1.0.2, Node 24.21.0, pnpm 11.11.0; retain complete pinned tooling and lockfile.
- Fresh sandbox per operation, 10s limit, bounded HTTPS requests, exact configured hostname. No state or network activity during discovery.
- Host credentials via brokered headers; sensitive backend variables never exposed to browser.
- Integer atomic USDC amounts. Verify settlement server-side before delivery; handle duplicate/uncertain outcomes safely.
- Keep functional application structure. If choosing shadcn/ui, install actual primitives. No fake activity feeds, decorative live indicators or generic AI-template styling.
- Human reviews landing + main arena design probe before design propagation. Inspect browser output, not just build results.

## Coordination and Git
- Main thread owns plugin/, web/, contracts, repo integration and commits.
- Parallel tasks initially research/design only; no shared-checkout edits unless explicitly assigned non-overlapping paths.
- Meaningful checked commits roughly every 20–30 minutes of active work; push verified checkpoints once remote is connected. No empty timer commits or background timer promises.
- Work on feature branches, no force pushes. Preserve pre-existing user files. Record exact tested vs untested status.
