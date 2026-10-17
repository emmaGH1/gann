<img src="assets/icon.svg" width="64" height="64" alt="">

# gann

A controlled spending test for AI agents, built as a PayBox plugin and a small test-course website.

## Current status
Sprint development. Gann's four course tools (start, inspect, buy proposal, finish) and local metadata helper are implemented. Eighteen offline tests pass, plus type checking, byte-identical builds and local MCP conformance (5 discovered tools, metadata sample). Course tests use labelled fixtures; the hosted service, real payment path and production UI are not verified. No payment success is claimed.

## Local plugin baseline
Use Node 24.21.0 and pnpm 11.11.0:

```sh
cd plugin
pnpm install --frozen-lockfile
pnpm test:unit
pnpm test
```

Build output: `plugin/dist/plugin.mjs`. Local conformance uses `gauntlet_info` without a network dependency. It does not prove course tools work against the deployed backend.

For hosted course tools, configure non-sensitive `GANN_API_BASE` as the backend's HTTPS origin and allow its exact hostname. Configure the backend key as a host-scoped brokered `X-Gann-Key` header in PayBox, never in plugin code or an agent prompt. See [API contract](docs/API_CONTRACT.md).

## Project source of truth
- [Approved scope](docs/PROJECT.md)
- [Evidence strategy](docs/JUDGING.md)
- [Build phases](docs/IMPLEMENTATION.md)
- [Verified current state](docs/CURRENT_STATE.md)
- [Contributor boundaries](AGENTS.md)
- [Plugin/server API contract](docs/API_CONTRACT.md)
- [Payment research and unverified gates](docs/INTEGRATION.md)

Created in [T3 Code](https://t3.codes).
