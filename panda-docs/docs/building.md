---
title: Build and check the source
---

The source is split into `src/client`, `src/server` and shared modules. Keep authentication before route dispatch, preserve native request IDs and explicitly handle failure paths. Write code comments in English.

```bash
bun install --frozen-lockfile
npm rebuild node-pty --build-from-source
bun run verify
```

Full checks require Linux, Node.js 22, the tested Codex CLI 0.171.0, Vim and Playwright Chromium. The disposable PostgreSQL tests use local PostgreSQL binaries when installed, otherwise Docker. Normal verification does not need a model account or production credentials.

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

## Run from source

For source development, install Bun 1.4.2, Node.js 22, Git, Python 3 and a C++ build toolchain. The release uses Codex CLI 0.171.0. Keep model accounts and application state outside the checkout:

```bash
bun install --frozen-lockfile
npm rebuild node-pty --build-from-source
npm install -g @openai/codex@0.171.0
codex login --device-auth
bun run start
```

## Development container

For a custom image, choose your own development tag and build the checkout. The following tag is created on your machine by the build command; the command does not publish it to a registry:

```bash
export PANDA_FORCE_IMAGE=panda-force:source
docker compose -f docker-compose.yml -f docker-compose.build.yml build panda-force
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --no-build
```

Keep `PANDA_FORCE_IMAGE` set to the same image for all commands. To add Grok account renewal to this custom build, use all three Compose files so the application and account helpers use your chosen image:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml \
  -f deploy/harness/docker-compose.grok.yml up -d --no-build
docker compose -f docker-compose.yml -f docker-compose.build.yml \
  -f deploy/harness/docker-compose.grok.yml \
  run --rm grok-auth grok --no-auto-update login --device-auth
```

Keep account and workspace volumes when rebuilding. The release Dockerfile reuses the public bases described below. Packaging runs compilation/startup checks by default; execute source and affected behavior checks independently.

## Container base images

The 0.1.11 source defaults to the public **Rocky creative build/runtime pair** for Linux amd64. Both include Codex CLI and Grok Build plus the reviewed Office/PDF/OCR, font, image, research, writing, browser and video tools. The build image adds the application development/native compilation dependencies; the runtime image carries production dependencies. [Contents, purpose, exact inputs and self-build workflow](base-images.md) explains the pair.

The Dockerfile, both Compose build overlays and `scripts/build/base-images.json` use the same actual public digests. The [development container commands](#development-container) build your checkout using that pair.

The first pull can be large. Later application builds reuse these installed layers. Ordinary assets are served by the application; an optional CDN requires your own settings. For a private registry, mirror both bases and set `PANDA_FORCE_BUILD_BASE` / `PANDA_FORCE_RUNTIME_BASE`, or use direct Docker build arguments `BUILD_BASE` / `RUNTIME_BASE`. Registry credentials and pull policies remain administrator-managed outside source and image layers.

## Build your own base images

Use the [Rocky creative builder](base-images.md#rebuild-and-select-rocky-bases) from the same clean release checkout. It builds both roles from reviewed locks, checksums and profiles, verifies installed inventories, and supports explicit pull policies and trusted image/npm overrides. After dependency or plugin changes, rebuild and verify the pair before selecting new immutable digests. A version-only application release can reuse compatible bases.

The earlier Debian recipes remain an explicit legacy alternative and supply the Debian Harness seed used by the Rocky recipe. They do not install the complete creative toolset. The full legacy chain includes **core → media → Harness engines**; a core/media pair alone does not satisfy this release's engine lock.

<details>
<summary>Advanced: rebuild the compatible legacy Debian pair</summary>

```bash
# 1. Locked dependency cores.
docker build --platform linux/amd64 -f scripts/build/Dockerfile.bases --target build-base \
  --build-arg APT_MIRROR=http://deb.debian.org --build-arg NPM_REGISTRY=https://registry.npmjs.org \
  -t panda-build:legacy-core .
docker build --platform linux/amd64 -f scripts/build/Dockerfile.bases --target runtime-base \
  --build-arg APT_MIRROR=http://deb.debian.org --build-arg NPM_REGISTRY=https://registry.npmjs.org \
  -t panda-runtime:legacy-core .
# 2. Media overlay.
docker build --platform linux/amd64 -f scripts/build/Dockerfile.media-bases --target build-base \
  --build-arg BUILD_BASE=panda-build:legacy-core --build-arg RUNTIME_BASE=panda-runtime:legacy-core \
  -t panda-build:legacy-media .
docker build --platform linux/amd64 -f scripts/build/Dockerfile.media-bases --target runtime-base \
  --build-arg BUILD_BASE=panda-build:legacy-core --build-arg RUNTIME_BASE=panda-runtime:legacy-core \
  -t panda-runtime:legacy-media .
# 3. Reviewed native Harness engines.
node scripts/build/harness-engines.mjs prepare --output .artifacts/legacy-engine-inputs
docker build --platform linux/amd64 -f scripts/build/Dockerfile.engine-bases --target build-base \
  --build-arg BUILD_BASE=panda-build:legacy-media --build-arg RUNTIME_BASE=panda-runtime:legacy-media \
  -t panda-build:legacy-engines .artifacts/legacy-engine-inputs
docker build --platform linux/amd64 -f scripts/build/Dockerfile.engine-bases --target runtime-base \
  --build-arg BUILD_BASE=panda-build:legacy-media --build-arg RUNTIME_BASE=panda-runtime:legacy-media \
  -t panda-runtime:legacy-engines .artifacts/legacy-engine-inputs
# 4. Explicitly select the complete legacy pair for the application.
export PANDA_FORCE_BUILD_BASE=panda-build:legacy-engines
export PANDA_FORCE_RUNTIME_BASE=panda-runtime:legacy-engines
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

For a Rocky seed refresh, use the verified **Debian engine build** image with `creative-tools.mjs build --seed-image ...`; the seed stage installs portable fonts through apt. The final Rocky stages install RPMs and rebuild native modules themselves. Do not select the new Rocky default as that Debian seed.

</details>

## Monthly Harness engine refresh

Both standard bases include Codex CLI and Grok Build. The separate engine layer is built by `scripts/build/Dockerfile.engine-bases` on top of the reviewed dependency/media parents. Credentials and mutable `CODEX_HOME` / `GROK_HOME` directories stay outside images. Bind the operator-owned Grok account **directory** read-only, as in `deploy/harness/docker-compose.grok.yml`; binding only `auth.json` can retain an obsolete inode after an atomic token refresh. New runtime sessions copy the current access credentials without refresh tokens. The connection check opens an authenticated session; the runtime list also offers an explicit real “hi” test, with its reply and duration, in a temporary workspace outside normal chat history.

During the monthly maintenance window, resolve the latest stable versions and review `scripts/build/harness-engines.lock.json`:

```bash
node scripts/build/harness-engines.mjs refresh
node scripts/build/harness-engines.mjs prepare --output .artifacts/harness-engine-inputs

docker build -f scripts/build/Dockerfile.engine-bases --platform linux/amd64 \
  --target build-base -t my-registry/panda-force-build-base:NEW_FIXED_TAG \
  .artifacts/harness-engine-inputs
docker build -f scripts/build/Dockerfile.engine-bases --platform linux/amd64 \
  --target runtime-base -t my-registry/panda-force-runtime-base:NEW_FIXED_TAG \
  .artifacts/harness-engine-inputs
```

`prepare` verifies the pinned Codex npm integrity, Grok binary checksum and license checksum. Normal application builds use this reviewed lock; they do not resolve `latest` or upgrade engines at startup. The current published architecture is Linux amd64. Parent `BUILD_BASE` and `RUNTIME_BASE` arguments and the installation `NPM_REGISTRY` can be overridden for administrator-managed registries.

Check both CLI versions, Codex app-server initialization and Grok ACP initialization in disposable containers without account credentials or model inference. Publish and verify the new Debian seed, then rebuild both Rocky creative bases with that reviewed `--seed-image`, refresh the creative locks and run the offline output probe. Update the default build/runtime references only to that verified full Rocky pair, together with the engine/creative input hashes in `scripts/build/base-images.json`, Dockerfiles and Compose defaults. Keep `legacyEngineBuildBase` / `legacyEngineRuntimeBase` for the separate seed/legacy references. Each application is released independently; the shared host daemon is managed separately.

The engine manifest is `/opt/panda-harness/engines.json`; the Grok license is `/opt/panda-harness/licenses/grok-LICENSE`. Prior image tags remain available for rollback. This is a manual monthly maintenance workflow, not an installed background schedule.

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
