# Design direction — discovery in progress

Human review of landing first fold and primary arena probe is required before visual propagation. No final visual system or implementation has been approved.

## User-selected reference qualities
Updated from design conversation:
- User wants gann to feel bold and challenging, while retaining a fresh, playful paper-based personality.
- Portfolio reference (user image 1000199456.jpg): borrow ruled-paper background, expressive typography, generous spacing and overall composition. User explicitly rejects folder-tab sections.
- Feature-section reference (user image 1000199504.jpg, Bolt): user proposes an asymmetric grid of differently sized illustrated feature panels. Explore the layout rhythm, substantial headings and integrated illustrations; do not copy its checkout claims, assets or metrics.
- Earlier racing telemetry and examiner-sheet proposals are not selected defaults.
- User selected flat cut-paper illustrations with a few ink-drawn details. Use product-specific offer slips, price labels, receipts and test sheets rather than generic AI imagery. This illustration direction is selected; finished artwork/probe still needs review.
- Landing page must be demoable: it is part of the product demo, not a separate marketing detour. Prioritize a readable opening shot, quick explanation and clear transition into the actual agent/run journey.

## Demo-first composition constraints
- Target roughly 5–15 seconds on the landing page in the demo; this is a planning target, not an official duration requirement.
- First fold: lowercase wordmark, short product-specific promise, controlled-course illustration and a single primary action to copy the Grok test prompt. Do not claim the browser starts the agent.
- Keep any feature section compact and optional to understanding the first fold; no long marketing scroll required for the demo.
- Provide a clear route to an existing run without fabricating a session or outcome. Arena uses sanitized read-only viewer data only once integrated.
- Important copy, prices and actions must be readable in a standard desktop recording and on mobile; no hover-only explanation.
- Use static illustrations for the first probe. No animation/video production is authorized by this illustration choice.

## Proposed synthesis — final probe not yet approved
- Quiet ruled paper as the continuous canvas; bold ink typography and generous whitespace.
- Asymmetric feature composition, with restrained panel fills and illustrations specific to the controlled spending test. Avoid a generic equal-card feature grid.
- At most two type families: expressive, highly legible sans for headings/body/UI plus a handwritten accent face used sparingly for annotations. Use tabular numerals for prices and evidence. Exact fonts, palette and artwork remain undecided.
- Candidate feature topics: four controlled sellers; inspect advertised versus required prices; distinguish attempts, settlements and delivery; explain five run-specific checks. No invented run results or safety certification.
- Probe scope remains landing first fold plus primary arena only; feature-section layout is a subsequent design topic, not permission to expand implementation.

## First implementation probe — awaiting user review
- Synced core checkpoint ce08ca6 into design/gann without replacing dependency/configuration files.
- Implemented landing first fold and compact three-step strip; asymmetric illustrated feature section deliberately deferred until probe approval.
- Implemented /arena/probe as explicitly labelled empty design preview. /arena/[id] polls only the sanitized public GET viewer; no browser mutations or payment controls.
- Files: web/src/app/{page.tsx,layout.tsx,globals.css,design-ui.tsx,arena/[id]/page.tsx,arena/[id]/viewer.tsx}. Next dev generated web/AGENTS.md.
- Verification: Node 24.21.0, frozen-lockfile installation, TypeScript, 26 existing offline tests and production build passed. Playwright Chromium inspected desktop landing/arena and mobile landing; overflow checks passed at 390px for both pages. Clipboard copy interaction passed.
- Host HTML preview/collaborative browser remains blocked by AppArmor; no privileged host change made. Used existing Playwright Chromium for actual browser inspection instead.
- No hosted validation, paid settlement, run-result visual integration or installed-Grok journey tested. Google Fonts currently loads DM Sans and Patrick Hand remotely; local font hosting is a follow-up before final demo reliability polish.
- User review required before expanding feature sections or propagating the design. No deployment or merge to core authorized/performed.

## Hero refinement — user-requested second pass
- Removed Claude-like asterisk. Added original lowercase block-letter SVG wordmark with thin irregular coral outline and handwritten annotation, adapting the ROBIN reference rather than copying its letters.
- CTA is now agent-neutral: “Copy test prompt”, mint torn-paper label with adjacent arrow fragment; stable-width copied state and accessible status announcement. Prompt text remains agent-neutral and requires an installed PayBox plugin.
- Reduced headline/art scale to accommodate identity; softened and tightened paper ruling. No new sections or backend changes.
- Production build and TypeScript passed; actual Playwright desktop and 390/360px mobile overflow checks passed. Clipboard interaction and unchanged button width verified. Production browser screenshots captured without development toolbar.
- T3 preview still blocked by host sandbox setup; independently inspected with existing Playwright Chromium. No host security settings changed. Awaiting user review before further propagation.

## Superseded initial proposal
The following examiner-sheet brief is retained as historical context, not the approved direction.

## Proposed direction: examiner's sheet
Precise, watchful, composed, tactile. Numbered checkpoints, ruled rows and concise annotations; not a game or trading terminal. Warm paper #F4F1E8, ink #20231F, slate #68716B, restrained orange #C65A32. Two type families maximum: legible sans and restrained mono for amounts/evidence. Tabular numerals. Clear hierarchy, modest radii, no decorative live dots, fake metrics, glass or gradients.

## Entry probe
Headline: Give your agent a budget. See what it actually does.
Supporting copy: A controlled spending test for AI agents. Follow their decisions, actual payments and delivered results.
Primary action must match implemented onboarding (e.g. copy agent prompt); do not promise a website can start an agent without a real integration.
Proof uses a real run or clearly labelled example layout, never invented live outcomes. Show controlled-test disclaimer without overwhelming the main promise.

## Arena probe
Mission/budget strip; seller offers; ordered evidence ledger; final explainable checks. Separate inspections, attempts, confirmed payments and deliveries. Unknown outcomes are not confirmed. Preserve partial evidence on error. Mobile single-column, readable amounts and no hover-dependent evidence. Desktop capture should require little scrolling.

## Review candidates
1. Warm examiner's clipboard (recommended for first probe).
2. Cooler roadside inspection form, slate structure and numbered checkpoints.
Build only entry first fold + one main screen for review, not the full UI. Neither direction approved yet.
