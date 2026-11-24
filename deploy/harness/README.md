# Configure Harness Runtimes

Use the 0.1.9 release checkout and application image. Combine the normal Compose file and this overlay:

```sh
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml up -d
```

By default, the account lives in a private Docker named volume, including on Docker Desktop. This keeps native Unix file permissions independent of Windows/macOS bind-mount behavior. The initializer assigns the named account and socket volumes to the configured `PUID`/`PGID`.

On Linux, an existing operator account can instead be selected with `PANDA_FORCE_GROK_ACCOUNT_HOME_HOST=/absolute/operator-owned/grok-account`. That directory and its credential file must already belong to the configured `PUID`/`PGID`, with private native permissions. The initializer never changes the ownership of this host bind. Keep the existing owner and use matching IDs, or use the dedicated named volume and sign in there. Do not copy one rotating refresh token into several independently managed account homes.

For a dedicated account, complete the official one-time device login through the account service:

```sh
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml run --rm grok-auth grok --no-auto-update login --device-auth
```

The `grok-auth` service owns the account directory. The application mounts only a named socket volume; this works with Docker Desktop as well as Linux and does not require a host daemon or Kubernetes. Private registries and explicit pull policies remain available through the normal image and pull-policy overrides. The application and both account helpers default to `hiforceai/panda-force:0.1.9`. For a local build or private registry, set `PANDA_FORCE_IMAGE` explicitly so all three services use the same selected image. When building locally, include `docker-compose.build.yml` and build `panda-force` before starting the overlay.

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

The 0.1.9 public Rocky amd64 bases include ZCode. The source recipe adds the locked headless payload, built-in provider configuration and upstream licensing notices to the matching build and runtime bases. The container uses `/usr/local/bin/zcode` and `/opt/panda-zcode/zcode-builtin.json`. Prepare the image inputs on a Linux amd64 build machine using the official archive URL recorded in `scripts/build/zcode-runtime.lock.json`.

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

## Claude Code for a personal instance

Use an unmodified Claude Code CLI and the [Claude Agent ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp). The compatibility probe uses adapter `0.110.1`, Claude Code `2.1.330`, and ACP v1. The npm adapter requires Node.js 22 or later. Each account home must be owned by the PandaForce service user and private to that user (for example, mode `0700`).

Complete sign-in with the original Claude CLI. The CLI manages its account state and sends model requests under your own account. PandaForce uses ACP for connection status, model and reasoning choices, conversation turns, and tool approvals. Use the runtime for your own administrator conversations, subject to the [Claude Code authentication and hosting terms](https://code.claude.com/docs/en/legal-and-compliance).

To prepare the reviewed files in a new directory, run `node scripts/build/claude-runtime.mjs prepare /absolute/path/to/claude-tools` from the release checkout using Node.js 22 or later. This downloads the original CLI and the locked adapter dependencies from their upstream sources. The same preparer is at `/opt/panda-claude-setup/claude-runtime.mjs` in the public base pair.

### Linux source installation

Set `command` to the adapter's absolute executable path and `claudeCommand` to the original CLI's absolute path. Use the same `accountHome` for the CLI and the profile. Sign in as the PandaForce service user.

If Claude Code is already signed in under that same Linux user with its default configuration in `~/.claude`, set `accountHome` to that user's existing private home and proceed to the connection check. For a new login, prepare a dedicated account home as shown below.

```sh
install -d -m 0700 /path/to/panda-claude-account
env HOME=/path/to/panda-claude-account \
  CLAUDE_CONFIG_DIR=/path/to/panda-claude-account/.claude \
  /path/to/claude auth login
export PANDA_FORCE_CLAUDE_CODE_HARNESS_PROFILES='[{"id":"claude-code","name":"Claude Code","command":"/path/to/claude-agent-acp","claudeCommand":"/path/to/claude","accountHome":"/path/to/panda-claude-account"}]'
```

Use the official login in a terminal that you control. If Anthropic asks for a one-time code, enter it in that terminal.

### Docker Compose

Use a PandaForce image built from a source revision that includes this runtime. Prepare a tools directory on the host with the adapter and the original `claude` binary for the container's Linux architecture and libc. In that tools directory, install the reviewed adapter with `npm install --ignore-scripts --save-exact @agentclientprotocol/claude-agent-acp@0.110.1`. Put the executable CLI at `claude` in the same directory. Set `PANDA_FORCE_CLAUDE_CODE_TOOLS_HOST` to this directory and `PANDA_FORCE_CLAUDE_CODE_ACCOUNT_HOME_HOST` to the private account directory. The account directory must belong to the configured `PUID` and `PGID`.

```sh
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.claude-code.yml \
  run --rm --no-deps -e HOME=/run/panda-claude-account \
  -e CLAUDE_CONFIG_DIR=/run/panda-claude-account/.claude \
  --entrypoint /opt/panda-claude-code/claude panda-force auth login
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.claude-code.yml up -d
```

Keep any other active Compose overlays in both commands. After starting PandaForce, open **Settings → Harness Runtimes**. Add the **Claude Code** profile if this is an existing instance, then check its connection. Choose it in a new or existing conversation. If the connection asks for sign-in again, repeat the native CLI login and retry the connection check.

## Host and container modes

Use a PandaForce build that includes `PANDA_FORCE_HOST_HARNESS_PROFILES`. You can combine host profiles with any of the existing container overlays in the same installation. Give each profile a distinct ID such as `claude-host` or `claude-container`. Existing conversations retain their native session bindings. Select the other runtime explicitly to continue with the available handoff context.

| Harness | Container mode | Linux host mode |
| --- | --- | --- |
| Codex | Start the base Compose service and sign in with `codex login --device-auth` in the container. Keep the model-state volume. | Start the account owner's `codex app-server daemon start`. Use the existing [shared Codex setup](../../panda-docs/docs/installation.md#use-codex-already-installed-on-the-host) for the main runtime, or add a named host profile with `kind: codex` and the visible control socket. |
| Grok Build | Use `docker-compose.grok.yml` with the account service and its private account volume. Complete device login in that service. | Start Grok's `agent stdio` under the already signed-in host user. Set `GROK_HOME` to the matching native account directory and add a `grok-build` host profile. |
| ZCode | Use `docker-compose.zcode.yml`, mount the private provider JSON, and select the matching provider ID and model. | Run `zcode app-server --stdio` with the host's built-in and private provider config files. Set the same `providerId` and `model` in the `zcode` host profile. |
| Antigravity CLI | Use `docker-compose.antigravity.yml` and sign in to `agy` with the mounted account home. | Run `agy acp` as the signed-in host user with that account's `HOME`. Add an `antigravity` host profile. The host runtime uses tool approval prompts. |
| Claude Code | Use `docker-compose.claude-code.yml` and run the native login with the mapped account directory. | Start the ACP adapter as the Claude account owner with the original `claude` binary and existing CLI home. Add a `claude-code` host profile. |

### Start a host engine

Named host profiles are for administrator conversations. Run each host process as the Unix user who owns its native account. Codex speaks its own Unix socket protocol. For the other engines, `host-cli.ts` connects the private socket to each process's standard input and output. It runs one native process per connection. Set `PANDA_FORCE_HOST_HARNESS_CLIENT_UID` only when the PandaForce container has a different host-mapped UID. The socket grants access to the native engine under the host account, so assign it only to the PandaForce service user.

Prepare an absolute directory for sockets, such as `/run/panda-host-harness`. It must belong to the user who starts the bridge and allow writes only from that user. For several engine owners, create separate owned subdirectories. Start the bridge from the source checkout under a service manager, or keep the following foreground commands in separate terminals. Replace the sample paths with your installed executables and account configuration. Use absolute paths and native versions that pass the provider's connection check.

```sh
# Claude Code reads the native login of the user running this command.
env CLAUDE_CODE_EXECUTABLE=/path/to/claude CLAUDE_AGENT_ACP_PROTOCOL=v1 \
  bun src/server/harness/host-cli.ts /run/panda-host-harness/claude.sock -- /path/to/claude-agent-acp

# Antigravity reads the Google login from the selected native home.
env HOME=/path/to/antigravity-account \
  bun src/server/harness/host-cli.ts /run/panda-host-harness/antigravity.sock -- /path/to/agy acp

# Grok reads and renews its own login on the host.
env GROK_HOME=/path/to/grok-account GROK_SHARED_DAEMON=false GROK_DISABLE_AUTOUPDATER=1 \
  bun src/server/harness/host-cli.ts /run/panda-host-harness/grok.sock -- \
  /path/to/grok --no-auto-update --no-subagents agent stdio

# Use the existing provider JSON files on the host.
env ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=/path/to/zcode-builtin.json \
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=/path/to/private-zcode-provider.json \
  bun src/server/harness/host-cli.ts /run/panda-host-harness/zcode.sock -- /path/to/zcode app-server --stdio
```

For an existing root-owned Claude login, run the Claude bridge as root with its normal `HOME` and native config directory. Explicitly set the client UID to the application's host-mapped UID if different. Mount the socket directory into PandaForce. The Claude account and its credentials stay under the host user.

### Connect a container to host engines

Choose an existing workspace directory and keep the same absolute path in PandaForce and the host agents. The selected projects and staged attachments must be accessible at those paths to the relevant Unix users. Mount additional project roots at the same absolute path if needed. To keep the existing default project root, add your current `PANDA_FORCE_CWD`, `PANDA_FORCE_PROJECTS_ROOT` and workspace mounts in a Compose override after the host overlay.

```sh
export PANDA_FORCE_HOST_HARNESS_SOCKET_DIR=/run/panda-host-harness
export PANDA_FORCE_HOST_HARNESS_WORKSPACE=/path/to/workspace
export PANDA_FORCE_HOST_HARNESS_PROFILES='[
  {"id":"claude-host","name":"Claude Code Host","kind":"claude-code","socketPath":"/run/panda-host-harness/claude.sock"},
  {"id":"antigravity-host","name":"Antigravity Host","kind":"antigravity","socketPath":"/run/panda-host-harness/antigravity.sock"},
  {"id":"grok-host","name":"Grok Host","kind":"grok-build","socketPath":"/run/panda-host-harness/grok.sock"},
  {"id":"zcode-host","name":"ZCode Host","kind":"zcode","socketPath":"/run/panda-host-harness/zcode.sock","providerId":"YOUR_PROVIDER","model":"YOUR_MODEL"}
]'
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.host.yml up -d
```

Keep only the profiles you operate. To add a named Codex host profile, mount the real control socket directory separately and use its container-visible path with `kind: codex`. If PandaForce itself runs on the host, set the same JSON environment variable with the actual host socket paths. A ZCode profile also accepts `efforts` and `defaultEffort`, as in container mode.

In **Settings → Harness Runtimes**, add each installed profile and choose **Check connection**. Then select the named runtime in a new conversation, choose its model and send a short message. If the connection is unavailable, check the service, socket permissions and common workspace path. If it requires sign-in, complete the provider's native login in the environment for the selected mode, then retry the check.

In an Antigravity conversation, open **Conversation settings → Permissions** and select **Auto-approve tool requests** to use the native ACP approval override on the next turn. New conversations start with **Ask for approval**. The selected mode applies when PandaForce opens or resumes the native session. See [Antigravity ACP permissions](https://antigravity.google/docs/ide/extensions/acp#permissions) for the behavior of existing runtime rules and the terminal sandbox.

### Claude Code models and permissions

PandaForce shows the models and discrete reasoning levels reported by the connected Claude Code adapter. To expose a model your native account can use but its ACP picker omits, use Claude Code's [custom model configuration](https://code.claude.com/docs/en/model-config#add-a-custom-model-option) in the bridge environment. For example, an account with Opus 4.8 access can set `ANTHROPIC_CUSTOM_MODEL_OPTION=claude-opus-4-8` and `ANTHROPIC_CUSTOM_MODEL_OPTION_NAME="Opus 4.8"`. Restart that bridge, then check the connection again.

Open **Conversation settings → Permissions** to see Manual approval, Accept edits, Plan, Claude Auto, Deny unapproved actions, and Full access. Unavailable modes are disabled. **Full access** maps to native `bypassPermissions` and requires PandaForce confirmation. The adapter suppresses bypass for root outside a sandbox and when Claude settings disable it. Use a dedicated non-root user in an isolated environment. Claude Code profiles currently serve administrator conversations. See [Claude Code permission modes](https://code.claude.com/docs/en/permissions#permission-modes).

When changing the operating-system user, sign in with `claude auth login` under the new user. Keep the original runtime registered to resume its native conversations. Switching the runtime in a PandaForce conversation preserves its visible history and hands prior context to the new native session. To move terminal-only history separately, preserve the selected project transcripts and validate `claude --resume` from the matching working directory with the destination account. Keep both source and destination native credentials in their own private homes.

## Operator-built image layer for Claude Code

Use `scripts/build/claude-tools/runtime.lock.json` to prepare the original Linux amd64 CLI and the pinned ACP dependency tree once. Run `node scripts/build/claude-runtime.mjs prepare /path/to/new/context/tools` with Node.js 22 or later and place `scripts/build/claude-runtime.mjs` beside the `tools` directory. Build both targets of `scripts/build/Dockerfile.claude-bases` with the same reviewed Rocky build and runtime parents, using that context and `--network=none`. Publish the pair to your designated registry and select both immutable digests together. The recipe preserves the original executable and contains no account data.

In an application built with the pair, set the Claude Code profile's `command` to `/usr/local/bin/claude-agent-acp` and `claudeCommand` to `/usr/local/bin/claude`. Mount the native account home and complete sign-in there. A host socket profile continues to use the host's own CLI. The application packages its frontend once and uses those bundles to prepare the CDN output. BuildKit keeps independent source and asset copy layers reusable when another directory changes.
