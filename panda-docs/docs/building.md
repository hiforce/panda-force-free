---
title: Build and check the source
---

The source is split into `src/client`, `src/server` and shared modules. Keep authentication before route dispatch, preserve native request IDs and explicitly handle failure paths. Write code comments in English.

```bash
bun install --frozen-lockfile
npm rebuild node-pty --build-from-source
bun run check
bun run test:unit
bun run test:integration
bun audit
bun run build
```

Integration checks need the pinned CLI and disposable state. Some older browser scripts require a prepared server; do not describe the entire browser suite as self-contained. Test changed authentication, rendering, approvals, upload and terminal boundaries with focused regressions.

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
