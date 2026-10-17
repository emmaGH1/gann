# Sprint implementation

## 1. Integration proof (main thread)
Files: plugin/ official starter, minimal honest seller under web/ when facilitator confirmed.
Gate: pinned toolchain, local reproducible build/conformance; then configured hosted test; then human-approved installed-plugin $0.01 settlement delivers code. These are separate gates. No broad UI work before risk proof.

## 2. One complete test (main thread)
Files: plugin tool definitions, web session/event/seller routes, persistence, scoring and tests.
Gate: start -> inspect -> proposal -> PayBox approval/poll -> verified delivery -> finish with evidence-backed result. Test wrong code, unauthenticated writes, duplicate requests, uncertain settlement and timeouts.

## 3. Visual probe and polish
Parallel design brief may proceed now, read-only. Main thread builds entry first fold + one arena screen after contracts stabilize; human approves before propagation. Gate: browser inspected, mobile and recording readable, real/empty/error states truthful. Comparison is optional.

## 4. Demo and delivery
Demo story planning can proceed before implementation; recording/video work waits for functional evidence and follows relevant video skills. Aim for 3 repeatable runs where practical. Commit exact tested bundle/hash; human uploads, tests and submits. Freeze code early, preserve deadline buffer.

## Git
No remote was configured at kickoff. User connecting GitHub. Use feature branch, meaningful checked checkpoints every 20–30 minutes during active work; push only to agreed remote. No automated recurring timer. No secrets.

## Parallel ownership
- Main: all executable code, API contracts, integration, commits.
- Child design: read-only visual/copy and honest demo-story recommendations.
- Child research: read-only PayAI/CDP/x402 compatibility and settlement/replay findings.
No other top-level session is required. Additional independent implementation must have bounded file ownership or a dedicated worktree.
