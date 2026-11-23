# Configure Harness Runtimes

Use the 0.1.7 release checkout and application image. Combine the normal Compose file and this overlay:

```sh
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml up -d
```

By default, the account lives in a private Docker named volume, including on Docker Desktop. This keeps native Unix file permissions independent of Windows/macOS bind-mount behavior. The initializer assigns the named account and socket volumes to the configured `PUID`/`PGID`.

On Linux, an existing operator account can instead be selected with `PANDA_FORCE_GROK_ACCOUNT_HOME_HOST=/absolute/operator-owned/grok-account`. That directory and its credential file must already belong to the configured `PUID`/`PGID`, with private native permissions. The initializer never changes the ownership of this host bind. Keep the existing owner and use matching IDs, or use the dedicated named volume and sign in there. Do not copy one rotating refresh token into several independently managed account homes.

For a dedicated account, complete the official one-time device login through the account service:

```sh
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml run --rm grok-auth grok --no-auto-update login --device-auth
```

The `grok-auth` service owns the account directory. The application mounts only a named socket volume; this works with Docker Desktop as well as Linux and does not require a host daemon or Kubernetes. Private registries and explicit pull policies remain available through the normal image and pull-policy overrides. The application and both account helpers default to `hiforceai/panda-force:0.1.7`. For a local build or private registry, set `PANDA_FORCE_IMAGE` explicitly so all three services use the same selected image. When building locally, include `docker-compose.build.yml` and build `panda-force` before starting the overlay.

Before model discovery, connection tests and chat dispatch, the account service rereads the account file. Within five minutes of expiry it runs the installed native CLI's `models` command in an empty temporary directory, with stdin closed, automatic updates disabled and a private leader socket. This exercises native authentication without sending a model prompt. Concurrent refreshes coalesce; an account-side file lock serializes native refresh workers. The native CLI owns OAuth, its own interaction with other native CLI processes, and persistence of rotated credentials. The integration does not implement a separate OAuth client or overwrite the native account file.

Each agent receives an atomic access-only snapshot in its existing isolated `GROK_HOME`. Long-running agents keep that snapshot current; refresh credentials never enter the conversation, model prompt or catalog. Account identities are pinned for managed native sessions. Authentication and session-opening failures can recover once before dispatch. A dispatched prompt is never replayed automatically. Failed refresh attempts use a short cooldown; network failures remain connection failures, and rejected refresh grants require a new login.

Managed renewal requires a single identified account entry in the native file. Use separate homes/services for distinct accounts. Existing installations can retain operator-managed read-only snapshots by omitting `credentialSocket`. For a host service, run `bun src/server/harness/auth/main.ts` with explicit absolute `PANDA_FORCE_GROK_AUTH_HOME`, `PANDA_FORCE_GROK_AUTH_COMMAND` and `PANDA_FORCE_GROK_AUTH_SOCKET` paths. Point the installed profile's `credentialSocket` at the private socket visible to the application; the default Grok profile also accepts `PANDA_FORCE_GROK_AUTH_SOCKET`. Socket directories must be owner-only and clients must run as that owner.

The optional `panda-force-grok-auth@.service` template runs as the named existing Unix account. Bundle `src/server/harness/auth/main.ts` with `bun build --target=bun --outfile=/opt/panda-force/grok-auth/broker.js`, configure the three paths and the Bun/CLI executable `PATH` in `/etc/panda-force/grok-auth-<user>.env`, and use `/run/panda-force-grok-auth-<user>/broker.sock`. Install and enable the template explicitly; application startup never installs host services. A container client needs only a read-only bind of that private socket directory, with a matching Unix owner. Keep the runtime directory across service stops/restarts so an existing container bind continues to see the new socket. Preserve a previous bundle/configuration for rollback, and do not restore an old refresh token after native rotation.

## Named conversation runtimes

To configure named runtimes, expose the operator profiles below to the application. Use **Settings → Harness Runtimes → Add** to give each configured runtime a distinct display name and select its profile. One profile can back several runtime names. Use separate profiles when the engines, credentials or connection details differ. Switch by name from the conversation composer after the active turn settles. The conversation, workspace and selected handoff context travel across the switch. Each runtime has its own native session binding.

| Environment variable                       | JSON array entries                                                                                                                                                                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PANDA_FORCE_HARNESS_PROFILES`             | Grok entries with `id`, `name`, absolute `command`, absolute `accountHome` and optional absolute `credentialSocket`. Use separate account homes or credential services for distinct accounts.                                                                         |
| `PANDA_FORCE_CODEX_HARNESS_PROFILES`       | Additional Codex entries with `id`, `name` and absolute `socketPath`. Point each profile at its own operator-managed Codex app-server Unix socket. The server and PandaForce must see the same project paths.                                                         |
| `PANDA_FORCE_ZCODE_HARNESS_PROFILES`       | Experimental ZCode entries with `id`, `name`, absolute `command`, absolute `builtinConfig`, absolute `providerConfig`, `providerId` and `model`. For models that require a reasoning level, provide an `efforts` array and a member of that array as `defaultEffort`. |
| `PANDA_FORCE_ANTIGRAVITY_HARNESS_PROFILES` | Antigravity entries with `id`, `name`, a dedicated absolute `accountHome`, optional absolute `command` (default `/usr/local/bin/agy`) and optional `deployment` (`local` or `container`). Create a separate profile and account home for each Google account.         |

For ZCode, use an executable that accepts `app-server --stdio` and supply its built-in provider configuration. The first tested combination is ZCode 3.18.2 / CLI 0.17.1. Mount a private ZCode personal-provider JSON file at runtime. The model and provider IDs must match the file. A Codex `config.toml` uses a different format. For a BigModel Coding Plan API key, configure ZCode's OpenAI-compatible connection with `https://open.bigmodel.cn/api/coding/paas/v4` and use it for coding requests. The provider's account page reports the applicable plan usage. Test the runtime in Settings with a small coding request after the connection check.

### Rebuild the Rocky base images with ZCode

The 0.1.7 public Rocky amd64 bases include ZCode. The source recipe adds the locked headless payload, built-in provider configuration and upstream licensing notices to the matching build and runtime bases. The container uses `/usr/local/bin/zcode` and `/opt/panda-zcode/zcode-builtin.json`. Prepare the image inputs on a Linux amd64 build machine using the official archive URL recorded in `scripts/build/zcode-runtime.lock.json`.

```sh
archive_url=$(node -p 'require("./scripts/build/zcode-runtime.lock.json").archive.url')
mkdir -p .artifacts/zcode-base
curl --fail --location "$archive_url" --output .artifacts/zcode-base/ZCode.AppImage
node scripts/build/zcode-runtime.mjs prepare .artifacts/zcode-base/inputs .artifacts/zcode-base/ZCode.AppImage
docker build --network=none --platform linux/amd64 -f scripts/build/Dockerfile.zcode-bases \
  --target build-base -t panda-force-build-base:zcode-rocky .artifacts/zcode-base/inputs
docker build --network=none --platform linux/amd64 -f scripts/build/Dockerfile.zcode-bases \
  --target runtime-base -t panda-force-runtime-base:zcode-rocky .artifacts/zcode-base/inputs
```

Pass `--build-arg BUILD_BASE=...` and `--build-arg RUNTIME_BASE=...` to use your rebuilt pair or matching Rocky parents in an administrator's registry. Select both derived images when building PandaForce. For a cluster deployment, reference their immutable registry digests and mount `providerConfig` as a private read-only file. The AppImage is used only to prepare the verified headless payload. Credentials, the desktop app and session state remain outside the derived images.

The experimental ZCode profile supports text conversation, continuation, streamed replies, thinking and tool status, approval and cancellation. Conversations default to asking for approval. Selecting Full access applies ZCode’s native full-access mode before the next turn, including after session recovery. Additional Codex socket profiles and experimental ZCode profiles are exposed in conversations. Scoped applications such as Creation and Bots have their own catalog with the runtimes that support their tool boundary. To use ZCode in the release image, follow the [Compose setup](../../panda-docs/docs/harness-runtimes.md#zcode).

### Run two ZCode profiles alongside Codex and Grok

Make two private copies of `zcode-provider.example.json` and configure each with its own key. Keep the sample provider ID and model until you have verified the connection. To use a different model, edit the selected profile and that account's provider file together.

```sh
export PANDA_FORCE_ZCODE_PROVIDER_FILE="$HOME/.config/panda-force/zcode-primary.json"
export PANDA_FORCE_ZCODE_SECONDARY_PROVIDER_FILE="$HOME/.config/panda-force/zcode-secondary.json"
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml \
  -f deploy/harness/docker-compose.zcode.yml -f deploy/harness/docker-compose.zcode-multiple.example.yml \
  up -d --no-build
```

Add each profile in **Settings → Harness Runtimes** with a distinct name, access setting and any supported default model or reasoning level. The same engine can appear as multiple runtimes. Give each profile ID a stable value unique across all providers, including the built-in `codex` ID. Keep saved names and IDs when upgrading so existing sessions can resume.

To add operator-managed profiles, put the full JSON array for that provider in the application service's `environment` in the last Compose override. Compose replaces an environment value as a whole. Include existing entries when appending another one. Every executable, config file, directory and Unix socket in those arrays must use its absolute path **inside the application container**.

- **Codex** uses the built-in runtime with the installation's Codex account. For a separate account, run a separate account-owned app-server and mount its accessible Unix socket directory in the application. Add a `PANDA_FORCE_CODEX_HARNESS_PROFILES` entry such as `{"id":"codex-team","name":"Codex Team","socketPath":"/run/codex-team/app-server.sock"}`.
- **Grok Build** uses one private account home and broker per account. Keep the existing `grok-build` entry and add another `PANDA_FORCE_HARNESS_PROFILES` entry with its own ID, name, account-home path and private `credentialSocket`. Mount the second broker directory read-only in the application. Use the same UID/GID for the broker and its client.
- **ZCode** profiles bind a provider and model. The Compose example supplies two read-only account files. Both may use the same model, or each may select a model declared in its provider file.
- **Antigravity** uses a separate writable `accountHome` and matching Google login for each profile. Add another entry to `PANDA_FORCE_ANTIGRAVITY_HARNESS_PROFILES` and mount a separate directory at its container path. Complete the native login with that path as `HOME`.

## Antigravity CLI on Rocky 9

The public image includes the ACP adapter. For an approved Antigravity installation, build both `linux/amd64` bases locally using the same Google release lock. The Google archive is verified offline against its pinned SHA-512 before `agy` is installed. The images carry the CLI and its release metadata. Google login and native sessions live in the operator's dedicated writable account directory. Review the [Antigravity terms](https://antigravity.google/terms) for your account and use the source build below to create the application image for this option.

```sh
mkdir -p .artifacts/antigravity-base/inputs
cp scripts/build/antigravity-runtime.lock.json .artifacts/antigravity-base/inputs/
archive_url=$(node -p 'require("./scripts/build/antigravity-runtime.lock.json").url')
curl --fail --location "$archive_url" --output .artifacts/antigravity-base/inputs/cli_linux_x64.tar.gz
for base_target in build runtime; do
  docker build --network=none --platform linux/amd64 -f scripts/build/Dockerfile.antigravity-bases \
    --target "${base_target}-base" -t "panda-force-${base_target}-base:rocky9-antigravity-1.5.14" \
    .artifacts/antigravity-base/inputs
done

export PANDA_FORCE_BUILD_BASE=panda-force-build-base:rocky9-antigravity-1.5.14
export PANDA_FORCE_RUNTIME_BASE=panda-force-runtime-base:rocky9-antigravity-1.5.14
export PANDA_FORCE_IMAGE=panda-force:antigravity
docker compose -f docker-compose.yml -f docker-compose.build.yml build panda-force
```

For a private registry, supply the matching Rocky parents through `BUILD_BASE` and `RUNTIME_BASE` when deriving the dependency images. Select both resulting immutable registry digests when building an application image. On refresh, review the official release manifest, update the pinned archive and checksum together, and repeat the offline toolchain and ACP probes on both bases before selecting the new pair.

For Compose, create a private account directory owned by the application's `PUID`/`PGID` and set `PANDA_FORCE_ANTIGRAVITY_ACCOUNT_HOME_HOST` to its absolute path. Keep `PANDA_FORCE_IMAGE` pointed at the application image built above. Run the official login with the container's configured user and complete Google OAuth in the browser.

```sh
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.antigravity.yml \
  run --rm --no-deps -e HOME=/run/panda-antigravity-account \
  -e XDG_CACHE_HOME=/run/panda-antigravity-account/.cache --entrypoint /usr/local/bin/agy \
  panda-force acp --login
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.antigravity.yml \
  up -d --no-build --pull never panda-force
```

For Kubernetes, mount a dedicated writable volume at `accountHome`, sign in as the application user with that home, and set `PANDA_FORCE_ANTIGRAVITY_HARNESS_PROFILES` with the mounted path. In **Settings → Harness Runtimes**, add a runtime using the Antigravity CLI profile and run its connection test. Select it by name in a conversation. The adapter reopens native sessions with ACP `session/resume`, streams replies and tool activity, forwards permission prompts, and records Google's per-turn token counters when supplied. Model and thinking choices come from the native session. For a different Google account, add a profile with a fresh account directory and create a new runtime so existing conversations keep their original native identity.

In an Antigravity conversation, open **Conversation settings → Permissions** and select **Auto-approve tool requests** to use the native ACP approval override on the next turn. New conversations start with **Ask for approval**. The selected mode applies when PandaForce opens or resumes the native session. See [Antigravity ACP permissions](https://antigravity.google/docs/ide/extensions/acp#permissions) for the behavior of existing runtime rules and the terminal sandbox.
