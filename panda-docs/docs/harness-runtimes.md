---
title: Codex and Grok Build in containers
---

PandaForce 0.1.3 supports **multiple Harness Runtimes**. A runtime selects the native engine and account connection; its model list and reasoning levels come from that runtime. Choose **Harness Runtime → model → reasoning level** in conversations, assistants/Bots and supported creation settings. Codex and the newly integrated **Grok Build** are both included in the published application image.

## Install the matching release

Get the installation configuration from the `main` branch and run the published `hiforceai/panda-force:0.1.3` image:

```bash
git clone --branch main --depth 1 https://github.com/hiforce/panda-force-free.git
cd panda-force-free
docker compose pull panda-force
docker compose up -d --no-build
```

Open [http://localhost:8899](http://localhost:8899), create the application administrator and choose SQLite or configure MySQL. Application sign-in and model-provider sign-in are independent. The image uses **Rocky Linux 9**, with Node.js, Bun, Codex CLI, Grok Build and the maintained creative toolchain already installed. Docker/Compose is sufficient; no host CLI daemon or Kubernetes is required for this arrangement.

<div className="base-image-table">

| Component                        | Purpose                                                                                  | Persistent state                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `panda-force`                    | Browser/API service, Codex app-server and on-demand Grok ACP processes                   | Application state, Codex account/session volume and workspace volume |
| Optional `grok-auth`             | Owns the Grok account and delegates native credential renewal                            | A separate private Grok account volume                               |
| Optional `grok-auth-socket-init` | One-time preparation of the named Grok account/socket volumes for the configured UID/GID | No model execution; completes before the account service starts      |

</div>

Both CLI engines are already in the application image. The Grok overlay adds account ownership and renewal; it does not install another Grok binary or replace Codex.

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

The account service owns the refresh credentials. The application mounts only its private socket and gives each isolated agent an access-only snapshot. Named account volumes work on Linux and Docker Desktop. An operator-managed Linux account directory can be selected with `PANDA_FORCE_GROK_ACCOUNT_HOME_HOST`; it must already have the configured UID/GID and private permissions. The initializer does not change ownership of that host bind. Detailed lifecycle and host-service options are in [the account service guide](https://github.com/hiforce/panda-force-free/blob/v0.1.3/deploy/harness/README.md).

## Verify images and preserve accounts

```bash
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml config --images
docker compose exec panda-force codex --version
docker compose exec panda-force grok --no-auto-update --version
docker compose exec panda-force panda-tools doctor
```

For the 0.1.3 release, the reviewed engines are Codex CLI **0.171.0** and Grok Build **1.0.89**. The image already provides Office, PDF/OCR, fonts, browser, image, writing, research and video tools; [contents and purpose](base-images.md) explains the matched build/runtime bases.

`PANDA_FORCE_IMAGE` overrides the application and Grok helpers together, including a private registry or digest. Keep their selected version compatible. `PANDA_FORCE_PULL_POLICY` controls pulls; registry credentials remain in your registry tooling. Before upgrading, check your `.env` for an old image override and preserve the existing Compose project name and volume names. `docker compose down` preserves named volumes; back up application, Codex, Grok-account and workspace storage before changing versions. The socket volume contains communication state, not the account backup.

Switch an existing conversation after the current turn finishes. PandaForce hands over selected context and keeps files in the working directory; it does not load the entire JSONL archive into the next model. Histories retain timestamps for targeted retrieval. Runtime/account access and execution permissions continue to apply.

## Source development

Developers customizing the application can follow the [container build guide](building.md#development-container), including its Grok overlay instructions. The installation and account commands on this page use the published `hiforceai/panda-force:0.1.3` image.
