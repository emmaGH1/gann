<img src="assets/icon.svg" width="64" height="64" alt="">

# gann

A controlled spending test for AI agents, built as a PayBox plugin and a small test-course website.

## Current status
Sprint development. Gann's plugin tools and unpaid server foundation are implemented. There are 22 plugin/in-process integration tests and 26 server tests passing, plus type checking, reproducible plugin builds, MCP conformance, and a Next.js production build. Tests use labelled offline transport/delivery fixtures. Paid fulfillment remains hard-disabled: no real settlement, hosted PayBox run or production UI is claimed.

## Local plugin baseline
Use Node 24.21.0 and pnpm 11.11.0:

```sh
# From repository root; cross-component tests import the server handlers.
(cd web && pnpm install --frozen-lockfile)
cd plugin
pnpm install --frozen-lockfile
pnpm test:unit
pnpm test
```

Build output: `plugin/dist/plugin.mjs`. Local conformance uses `gauntlet_info` without a network dependency. It does not prove course tools work against the deployed backend.

For hosted course tools, configure non-sensitive `GANN_API_BASE` as the backend's HTTPS origin and allow its exact hostname. Configure the backend key as a host-scoped brokered `X-Gann-Key` header in PayBox, never in plugin code or an agent prompt. See [API contract](docs/API_CONTRACT.md).

## Server foundation

See [web/README.md](web/README.md) for routes, local commands, configuration, evidence and payment blockers. Start/inspect/attempt/finish APIs and real SDK-generated unpaid challenges are implemented. UI pages are intentionally unstyled placeholders. Production requires configured persistence; no ephemeral production fallback. Do not authorize a payment in this build.

## Project source of truth
- [Approved scope](docs/PROJECT.md)
- [Evidence strategy](docs/JUDGING.md)
- [Build phases](docs/IMPLEMENTATION.md)
- [Verified current state](docs/CURRENT_STATE.md)
- [Contributor boundaries](AGENTS.md)
- [Plugin/server API contract](docs/API_CONTRACT.md)
- [Payment research and unverified gates](docs/INTEGRATION.md)

Created in [T3 Code](https://t3.codes).
