---
title: Configure Harness Runtimes
---

PandaForce 0.1.9 supports **multiple Harness Runtimes**. A runtime selects the native engine and account connection; its model list and reasoning levels come from that runtime. Choose **Harness Runtime → model → reasoning level** in conversations, assistants/Bots and supported creation settings. The published image includes Codex CLI, Grok Build and ZCode. Antigravity is available through an operator-built option.

## Install the matching release

Get the installation configuration from the `main` branch and run the published `hiforceai/panda-force:0.1.9` image:

```bash
git clone --branch main --depth 1 https://github.com/hiforce/panda-force-free.git
cd panda-force-free
docker compose pull panda-force
docker compose up -d --no-build
```

Open [http://localhost:8899](http://localhost:8899), create the application administrator and choose SQLite or configure MySQL. Application sign-in and model-provider sign-in are independent. The image uses **Rocky Linux 9**, with Node.js, Bun, Codex CLI, Grok Build, ZCode and the maintained creative toolchain already installed. Docker/Compose is sufficient; no host CLI daemon or Kubernetes is required for this arrangement.

<div className="base-image-table">

| Component                        | Purpose                                                                                  | Persistent state                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `panda-force`                    | Browser/API service, Codex app-server and on-demand Grok ACP processes                   | Application state, Codex account/session volume and workspace volume |
| Optional `grok-auth`             | Owns the Grok account and delegates native credential renewal                            | A separate private Grok account volume                               |
| Optional `grok-auth-socket-init` | One-time preparation of the named Grok account/socket volumes for the configured UID/GID | No model execution; completes before the account service starts      |

</div>

The Grok overlay adds account ownership and renewal for the included Grok Build CLI.

## Enable Codex

```bash
docker compose exec -it panda-force codex login --device-auth
docker compose restart panda-force
```

The standard Compose file persists `CODEX_HOME=/home/codex/.codex`. See [model providers](model-providers.md) for separately configured API-compatible services. An existing host Codex daemon remains an optional [shared-mode installation](installation.md#use-codex-already-installed-on-the-host).

## Enable Grok Build with managed account renewal

From the same checkout, add the Grok overlay. All three services select the same application release by default:

```bash
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml pull
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml up -d
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml \
  run --rm grok-auth grok --no-auto-update login --device-auth
```

Finish the official device login, then open **Settings → Harness Runtimes → Grok Build**. Check the connection and, when desired, use the explicit **hi** test to send a real small model request and see its reply/duration. Choose that runtime, its model and reasoning level for your work. Provider access depends on your own account. Login and the connection check are separate from the optional real model test.

If an existing installation already has a saved runtime catalog without Grok, add a runtime on this settings page, select the installed Grok Build profile and save it. Administrator/member visibility and the default runtime remain your choice.

Grok ACP processes start when PandaForce needs them. The account service rereads the native account file and uses the native CLI to refresh near-expiry access credentials. You do not need to SSH into the server and keep an interactive Grok or tmux session open. A refresh failure is shown as an account or connection error; a dispatched prompt is not automatically replayed.

The account service owns the refresh credentials. The application mounts only its private socket and gives each isolated agent an access-only snapshot. Named account volumes work on Linux and Docker Desktop. An operator-managed Linux account directory can be selected with `PANDA_FORCE_GROK_ACCOUNT_HOME_HOST`; it must already have the configured UID/GID and private permissions. The initializer does not change ownership of that host bind. Detailed lifecycle and host-service options are in [the account service guide](https://github.com/hiforce/panda-force-free/blob/v0.1.9/deploy/harness/README.md).

## Verify images and preserve accounts

```bash
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml config --images
docker compose exec panda-force codex --version
docker compose exec panda-force grok --no-auto-update --version
docker compose exec panda-force panda-tools doctor
```

For the 0.1.9 release, the reviewed engines are Codex CLI **0.171.0**, Grok Build **1.0.89** and ZCode CLI **0.17.1**. The image already provides Office, PDF/OCR, fonts, browser, image, writing, research and video tools; [contents and purpose](base-images.md) explains the matched build/runtime bases.

`PANDA_FORCE_IMAGE` overrides the application and Grok helpers together, including a private registry or digest. Keep their selected version compatible. `PANDA_FORCE_PULL_POLICY` controls pulls; registry credentials remain in your registry tooling. Before upgrading, check your `.env` for an old image override and preserve the existing Compose project name and volume names. `docker compose down` preserves named volumes; back up application, Codex, Grok-account and workspace storage before changing versions. The socket volume contains communication state, not the account backup.

Switch an existing conversation after the current turn finishes. PandaForce hands over selected context and keeps files in the working directory; it does not load the entire JSONL archive into the next model. Histories retain timestamps for targeted retrieval. Runtime/account access and execution permissions continue to apply.

## ZCode

The 0.1.9 image includes ZCode CLI 0.17.1. The experimental conversation runtime supports text streaming, visible thinking and tool activity, approvals, and resuming sessions. Usage is shown when the runtime reports it. Creation and Bots use their own supported runtimes.

1. Copy the [example provider file](https://github.com/hiforce/panda-force-free/blob/v0.1.9/deploy/harness/zcode-provider.example.json) to a private location outside the checkout and enter your own BigModel Coding Plan key there. Keep the IDs used in the example, or update the Compose profile and provider file together. Give the container user read access to this file.
2. Run the following from the release checkout. Replace the example path with the path to your configured file. Keep your existing Compose project and volumes when upgrading.

   ```sh
   export PANDA_FORCE_ZCODE_PROVIDER_FILE="$HOME/.config/panda-force/zcode-provider.json"
   docker compose -f docker-compose.yml -f deploy/harness/docker-compose.zcode.yml up -d --no-build
   ```

3. Open **Settings → Harness Runtimes → Add**, select the ZCode profile, and save. Choose the runtime in a conversation. Its explicit connection test uses your provider account.

Keep the Grok Compose overlay in the command if you already use it. The ZCode provider file is mounted read-only. Check plan usage with your provider.


## Use several named runtimes

A profile identifies the engine, executable and account connection. A runtime is the named choice shown in the composer. Open **Settings → Harness Runtimes → Add**, choose an installed profile, and give it a recognizable name such as **ZCode Work** or **Grok Research**. You can assign its allowed users and supported defaults, check its connection and choose it by name when composing. In a new project conversation, save the model before sending the first message.

Use an independent account connection for each separate account. Give profiles unique IDs across all providers and keep those IDs during upgrades. An existing runtime can retain its ID when renamed.

| Engine | Separate account connection |
| --- | --- |
| Codex | A distinct app-server Unix socket and account home for each additional profile |
| Grok Build | A distinct private account home and broker socket per account |
| ZCode | A private read-only provider JSON file per account and a model declared in that file |
| Antigravity | A distinct writable account home and operator-provided CLI for each Google login |

Keep all enabled overlays in the same Compose command and use the same project name across upgrades. The [two-ZCode example](https://github.com/hiforce/panda-force-free/blob/v0.1.9/deploy/harness/README.md#run-two-zcode-profiles-alongside-codex-and-grok) runs alongside Codex and Grok. The same guide lists the JSON keys and container mounts for additional profiles.

## Antigravity CLI

The optional ACP adapter uses Google's native `agy acp` process for conversations. Use the [operator build and sign-in guide](https://github.com/hiforce/panda-force-free/blob/v0.1.9/deploy/harness/README.md#antigravity-cli-on-rocky-9) to build the pinned CLI locally, mount a private account directory and complete Google sign-in. Consult the [Antigravity terms](https://antigravity.google/terms) for your account. Google controls the models and reasoning levels visible to that account.

Antigravity asks before tool actions that require approval. In the conversation settings, choose **Auto-approve tools** for the next turn. Antigravity runs that turn with its native permission override. The application container and its mounts still define which resources the process can access.

## Choose host or container mode

These options apply to a PandaForce build with host Harness profile support. Use container mode for a self-contained installation. Use Linux host mode to keep an already configured engine and its login on the machine where it normally runs. The two modes can run together under distinct profile IDs.

| Harness | Container | Linux host |
| --- | --- | --- |
| Codex | Standard Compose service, native `codex login --device-auth` and the model-state volume. | Start the native Codex daemon and use [shared mode](installation.md#use-codex-already-installed-on-the-host) or a named `codex` socket profile. |
| Grok Build | `docker-compose.grok.yml`, with device login in the `grok-auth` service. | Run `grok agent stdio` under the host account with its native `GROK_HOME`. |
| ZCode | `docker-compose.zcode.yml` with the private provider JSON. | Run `zcode app-server --stdio` with the host provider files. The host profile sets `providerId` and `model`. |
| Antigravity | `docker-compose.antigravity.yml`, with a dedicated account home and Google sign-in using `agy`. | Run `agy acp` with the `HOME` used for the host Google login. |
| Claude Code | `docker-compose.claude-code.yml` with an original Claude CLI, the ACP adapter, and a private account home. Sign in using `claude auth login` with that home. | Run the ACP adapter as the user who already signed in to Claude Code. Point `CLAUDE_CODE_EXECUTABLE` at the original CLI and use its existing account home. |

For host mode, the four stdio engines use the private Unix socket provided by `src/server/harness/host-cli.ts`. Set `PANDA_FORCE_HOST_HARNESS_PROFILES` to an array of profiles with distinct `id`, `name`, `kind` and absolute `socketPath` fields. Valid values for `kind` are `codex`, `grok-build`, `zcode`, `antigravity` and `claude-code`. Use `deploy/harness/docker-compose.host.yml` to mount the socket directory read-only and the shared workspace at the same absolute path on both sides. The CLI keeps the login on the host, and the PandaForce service user needs permission to connect to the socket. The **Host and container modes** section of `deploy/harness/README.md` in your checkout contains the full commands and example profiles.

In **Settings → Harness Runtimes**, add the profile, choose **Check connection**, then select it in a conversation. The named host profiles serve administrator conversations. Host Antigravity uses tool approval prompts. When a runtime needs sign-in again, open that runtime's native CLI in the selected environment, complete sign-in, and retry the connection check.

The runtime supplies the models and the reasoning slider's available levels. For Claude Code, use [Claude's custom model configuration](https://code.claude.com/docs/en/model-config#add-a-custom-model-option) for models your account can access that its picker omits. The Claude permission menu lists Manual approval, Accept edits, Plan, Auto, Deny unapproved actions, and Full access. The runtime enables only the modes the adapter offers. Full access maps to [`bypassPermissions`](https://code.claude.com/docs/en/permissions#permission-modes) and requires confirmation. A Claude bridge running as root outside a sandbox does not offer bypass. Claude Code profiles currently serve administrator conversations.

## Source development

Developers customizing the application can follow the [container build guide](building.md#development-container), including its Grok overlay instructions. The installation and account commands on this page use the published `hiforceai/panda-force:0.1.9` image.
