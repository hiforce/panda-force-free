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

Every browser suite and named group is checked for duplicate, missing or unclassified entries.

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

## Container base images

Source builds use two public Docker Hub images for **Linux amd64**:

| Image                                                       | Purpose                                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `hiforceai/panda-force-build-base:media-44d133985283bf79`   | Node.js, Bun, Codex CLI, compilers and locked development dependencies              |
| `hiforceai/panda-force-runtime-base:media-44d133985283bf79` | Node.js, Bun, Codex CLI, production dependencies, FFmpeg/FFprobe and Noto CJK fonts |

The Dockerfile, Compose build overlay and `scripts/build/base-images.json` pin the same immutable image digests. Docker pulls them automatically; no registry account, manual image import or separate base build is required. These are dependency bases, not runnable PandaForce releases. Ordinary installations serve static assets from the application; CDN is optional and requires your own configuration.

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

The initial download can be large. Later builds reuse the downloaded layers and compile the checked-out application; they do not reinstall JavaScript dependencies, FFmpeg or fonts. Compilation and any explicitly enabled CDN upload still take time. Packaging records that regression tests run separately. Run `bun run check` and the affected tests during development, or select a verification profile explicitly.

For a private registry, mirror **both** bases with your normal registry tools, log in using Docker's own credential configuration, and set `PANDA_FORCE_BUILD_BASE` and `PANDA_FORCE_RUNTIME_BASE` to the corresponding mirrored references before the same Compose command. For direct `docker build`, pass the independently overridable `BUILD_BASE` and `RUNTIME_BASE` arguments. Keep credentials out of Dockerfiles and build arguments; deployment registry credentials and pull policies remain administrator-managed. The original dependency tags remain available for existing pinned installations.

The reusable recipes are `scripts/build/Dockerfile.bases` for locked dependency cores and `scripts/build/Dockerfile.media-bases` for the media overlay. Ordinary application changes do not require rebuilding either. A changed lockfile, dependency, patch or base recipe requires publishing and selecting a matching pair; compatibility checks stop a mismatched build rather than reinstalling dependencies silently. Selecting an older runtime without media tools may trigger the explicitly enabled installation fallback.

Both dependency stages defer installation scripts and then explicitly rebuild `node-pty` with npm's native toolchain. Development dependencies stay out of the runtime image. This build-lifecycle correction preserves the locked dependency inventory and compatibility with the pinned published bases.

## Build your own base images

Run these commands from a **clean checkout of the same release**, using Docker with Linux amd64 support. The first core builds install locked JavaScript/native dependencies, the pinned Codex CLI, compilers and browser tools; they take longer than an application build. They use public upstream images and the checked-in `bun.lock` and `patches/`.

```bash
# 1. Build the two dependency cores.
docker build --platform linux/amd64 -f scripts/build/Dockerfile.bases --target build-base \
  --build-arg APT_MIRROR=http://deb.debian.org \
  --build-arg NPM_REGISTRY=https://registry.npmjs.org \
  -t panda-force-build-base:local-core .
docker build --platform linux/amd64 -f scripts/build/Dockerfile.bases --target runtime-base \
  --build-arg APT_MIRROR=http://deb.debian.org \
  --build-arg NPM_REGISTRY=https://registry.npmjs.org \
  -t panda-force-runtime-base:local-core .

# 2. Add the compiler label and runtime media tools.
docker build --platform linux/amd64 -f scripts/build/Dockerfile.media-bases --target build-base \
  --build-arg BUILD_BASE=panda-force-build-base:local-core \
  --build-arg RUNTIME_BASE=panda-force-runtime-base:local-core \
  -t panda-force-build-base:local .
docker build --platform linux/amd64 -f scripts/build/Dockerfile.media-bases --target runtime-base \
  --build-arg BUILD_BASE=panda-force-build-base:local-core \
  --build-arg RUNTIME_BASE=panda-force-runtime-base:local-core \
  -t panda-force-runtime-base:local .

# 3. Build and run the application with that pair.
export PANDA_FORCE_BUILD_BASE=panda-force-build-base:local
export PANDA_FORCE_RUNTIME_BASE=panda-force-runtime-base:local
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

For a direct application build, pass `--build-arg BUILD_BASE=panda-force-build-base:local` and `--build-arg RUNTIME_BASE=panda-force-runtime-base:local` to `docker build -t panda-force:local .`. These tags are local examples: choose your own registry and publish both bases with your normal tools when builds run on another machine. Docker credentials stay in its separately managed credential store. Use your trusted APT/npm mirror overrides where appropriate; the recipe also accepts `BUN_IMAGE` and `NODE_IMAGE` overrides for administrator-managed upstream images.

The application still validates the selected bases against the dependency inputs. A normal release-version change can reuse existing bases when the root package has no installation hooks. Dependency, lockfile, patch, installation-hook or base-recipe changes require a compatible newly built pair and an updated `scripts/build/base-images.json` compatibility fingerprint. Record that fingerprint with `node scripts/build/dependencies.mjs profile .`; keep image references and the media-recipe digest consistent with the pair you built. Regenerate and review the metadata only after checking the new bases, rather than disabling compatibility checks.

## Select release verification scope

Container builds default to compilation and packaging (`VERIFICATION_PROFILE=none`), with regression tests run separately. For an icon or brand-asset update, select the related checks explicitly:

```bash
docker build --build-arg VERIFICATION_PROFILE=brand -t panda-force:brand-review .
```

The `brand` profile builds the client, checks brand rendering and image-proof contracts, and exercises installation/startup assets in Chromium and WebKit. Its `verification.json` records `verificationProfile: "brand"`, `fullVerification: false` and the suites not run. Use `VERIFICATION_PROFILE=full` for the complete plan. Deployment gates require an explicit matching profile to accept a targeted certificate. Runtime smoke checks and deployment health checks still apply.

For optional static resource uploads during compilation and the targeted `cdn` verification profile, see [Build-time static CDN](cdn-build.md).

## Refresh README screenshots

After building the client assets, run `bun scripts/release/capture-readme.mjs` from the repository root. The script starts a disposable local application with a simulated engine and fictional English/Chinese content, then captures desktop Chromium and mobile WebKit views. It does not use an installed model account or a production workspace. `PANDA_FORCE_README_SCREENSHOTS` can select an output directory; the default is `panda-docs/static/img`. Review the images before publishing them.

## Build the help website

The optional help website in `panda-docs` requires Node.js 20 or later. Install its own locked dependencies and build from that directory with `bun install --frozen-lockfile` followed by `bun run build`. Keep its dependency directory and generated `.docusaurus` cache separate from another checkout. The main application source build uses the repository-root Docker/Compose instructions.

For the anonymous enterprise Bot example, run `bun scripts/release/capture-bot-usecase.mjs` after the client build. It exercises scoped submission, idempotent replay and review against a disposable application, then renders explicitly simulated task outcomes. It blocks worker dispatch and never publishes a real product. Both screenshot scripts use the dark Aurora appearance.
