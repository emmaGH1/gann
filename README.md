<img src="assets/icon.svg" width="64" height="64" alt="">

# gann

A controlled spending test for AI agents, built as a PayBox plugin and a small test-course website.

## Current status
Sprint development. The official PayBox v1.0.2 echo starter passes type checking, byte-identical builds and local MCP conformance. Gann tools, hosted service, UI and actual payment journey are not implemented yet. No hosted/payment success is claimed.

## Local plugin baseline
Use Node 24.21.0 and pnpm 11.11.0:

```sh
cd plugin
pnpm install --frozen-lockfile
pnpm test
```

Build output: `plugin/dist/plugin.mjs`. Currently the original echo sample, not the completed Gann submission.

## Project source of truth
- [Approved scope](docs/PROJECT.md)
- [Evidence strategy](docs/JUDGING.md)
- [Build phases](docs/IMPLEMENTATION.md)
- [Verified current state](docs/CURRENT_STATE.md)
- [Contributor boundaries](AGENTS.md)

Created in [T3 Code](https://t3.codes).
