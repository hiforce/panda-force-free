---
title: Build and check the source
---

The source is split into `src/client`, `src/server` and shared modules. Keep authentication before route dispatch, preserve native request IDs and explicitly handle failure paths. Write code comments in English.

```bash
bun install --frozen-lockfile
npm rebuild node-pty --build-from-source
bun run verify
```

Full checks require Linux, Node.js 22, the tested Codex CLI 0.166.0, Vim and Playwright Chromium. The disposable PostgreSQL tests use local PostgreSQL binaries when installed, otherwise Docker. Normal verification does not need a model account or production credentials.

`verify` checks dependency direction and runtime cycles, locale contracts, TypeScript, interface element declarations, ESLint, formatting, client builds, unit tests, integration tests and the self-contained browser suites. Results and per-suite logs are written to `.artifacts/verification/`. Install Playwright Chromium and WebKit with `bun x playwright install chromium webkit` before running browser checks. Integration tests use the pinned Codex CLI with disposable local model providers and temporary state.

Source JavaScript is checked with `checkJs` and JSDoc contracts; TypeScript source and static contract tests also pass `noImplicitAny`. The static tests deliberately include invalid calls with `@ts-expect-error` so weakening a contract fails the gate. Keep native provider payloads as `unknown` until a boundary validates them. Comments and commit messages must be in English.

Use `bun run format` to apply the shared formatting policy. After changing message catalogs, run `bun scripts/i18n/validate.mjs --write`. After changing interface IDs or element tags, run `bun scripts/quality/dom-types.mjs --write`. Generated declarations are verified separately and must not be hand-edited.

Tests are organized under `tests/unit`, `tests/integration`, `tests/browser` and `tests/support`. Native service diagnostics under `tests/live` and watcher diagnostics under `tests/tooling` are explicitly gated; their requirements are recorded in `scripts/testing/suites.json`. They are not silently included in the self-contained suite. The authenticated native-turn diagnostics run only with `PANDA_FORCE_LIVE_TESTS=1 bun scripts/testing/run.mjs live app-server.live.test.ts`; they are excluded from image builds and require the deliberately configured disposable model account described in the manifest.

Every browser suite and named group is checked for duplicate, missing or unclassified entries. Internal administrator-reset tests live under `tests/ops` and run with `bun run test:ops` when the deployment tools are available.

Shared modules cannot import client or server implementations. Protocol codecs use shared contracts; persistence does not import HTTP handlers or native processes. Browser features receive named, immutable ports from the composition root, and reading a peer before installation fails explicitly. The dependency check distinguishes executable imports from type-only references.

Run individual phases with `bun run check:dependencies`, `bun run typecheck`, `bun run lint`, `bun run test:unit`, `bun run test:integration` or `bun run test:browser`. Select a browser suite with `bun scripts/testing/run.mjs browser cache-identity.e2e.mjs`.

This help site follows the same Docusaurus-to-static-HTML approach as the related documentation projects. It is separate from the application bundle.

```bash
cd panda-docs
bun install --frozen-lockfile
bun run build
bun run serve
```

Use Node.js 22 or newer for the help build. Generated HTML is in `panda-docs/build`; build output is not source-controlled. No GitHub workflow files are included.

## Documentation dependency status

The documentation build currently inherits a low-severity [deepmerge advisory](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) for which no upstream patched version is listed. Build this separate help toolchain from trusted, reviewed configuration and content. Application dependencies are audited separately; a successful HTML build is not a claim that the help toolchain has no advisories.
