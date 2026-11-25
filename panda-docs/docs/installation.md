---
title: Install and sign in
---

## Understand what runs where

PandaForce provides the browser interface and sends requests through the selected Harness Runtime. The 0.1.11 container includes Codex CLI, Grok Build and ZCode CLI. Choose a runtime, then its model and reasoning level. Your PandaForce administrator account controls application access; each model-provider login is separate. [Codex/Grok container setup and account lifecycle](harness-runtimes.md) describes both engines. The host-service options below apply specifically to Codex.

There are two independent choices:

| Choice                     | Options                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Where PandaForce runs      | Directly on a machine, in Docker, or in a Kubernetes container                                                                        |
| Which Codex executes tasks | A separate Codex service started inside the PandaForce container (`isolated`), or an existing Codex service on the machine (`shared`) |

A host is the machine running a container. It can be a physical server or a virtual machine; in Kubernetes it is the node running the Pod. Connecting to an existing Codex service does **not** mean PandaForce itself must run directly from a host terminal.

With the default container installation, the browser connects to PandaForce in the container, and PandaForce starts Codex in that container. With an existing host service, the browser still connects to PandaForce in the container, but PandaForce forwards work to Codex already running on the host.

A Unix socket is a local communication endpoint between processes, represented by a filesystem path. Mounting the actual socket directory into the container makes that endpoint accessible to PandaForce, subject to filesystem permissions. This shares a service connection, not just a login file.

## Start the published container

The current container release is **hiforceai/panda-force:0.1.11**, currently for Linux amd64. The Rocky Linux 9 image contains Bun, Node.js, Codex CLI 0.171.0, Grok Build 1.0.89, ZCode CLI 0.17.1 and the reviewed creative tools. You do not need to install those tools on the host. Use the matching 0.1.11 Compose files; check an existing `.env` for an old image override.

Clone the `main` branch and enter its directory to use the installation configuration:

```bash
git clone --branch main --depth 1 https://github.com/hiforce/panda-force-free.git
cd panda-force-free
docker compose pull panda-force
docker compose up -d --no-build
docker compose logs panda-force
```

Open http://127.0.0.1:8899. Create your PandaForce administrator in the browser. The password requires at least six characters, including uppercase and lowercase letters and a number. If setup requests an installation code, read your private startup logs. No preset password, model account or object-storage credentials are built into the image.

Sign in to the native model account separately:

```bash
docker compose exec -it panda-force codex login --device-auth
docker compose restart panda-force
```

The default port binds only to localhost. State persists in named volumes. See [storage](./storage.md) before replacing an existing installation. The administrator and model-provider accounts are independent.

## Add Grok Build

Use the [Grok account-service overlay](harness-runtimes.md#enable-grok-build-with-managed-account-renewal) from this same checkout, then complete its native device login. The application and account helpers default to the same versioned image. Codex remains available. Dedicated account and socket volumes preserve credentials and support native renewal without a host terminal session.

## Choose the database on first installation

After creating the first administrator, the application offers **Use SQLite** or **Configure MySQL**. SQLite is stored in the application state volume and requires no database service. Choosing it is recorded and survives restarts; MySQL remains available later in **Settings → Storage and logs**.

For MySQL, prepare a dedicated empty database and a user allowed to create and update its tables. Enter the hostname reachable **from the PandaForce container**, port, database and user credentials. A database on the same Compose network is addressed by its service name; `localhost` inside the container refers to that container. Open TLS settings to configure server-certificate verification and an optional CA file mounted into the application container.

Use **Test connection**, then **Review migration** and **Move data to MySQL**. A failed connection keeps the source database selected and the form available for correction. The migration backs up the source, pauses writes, copies and verifies application data, and restarts the application onto MySQL. Keep the state volume and recovery records until completion. Existing data belonging to another installation is not silently adopted.

The administrator account is created during local bootstrap, then its identity, password hashes, account settings and session-revocation records move with the account domain. After a successful MySQL switch, authentication reads that backend. Model-provider authentication, attachments and workspace files remain in their own persistent locations. Back up both the database and the application/model/workspace volumes.

## Use Codex already installed on the host

This option is for a Linux Docker host with an existing Codex login. Shared mode connects to the host's app-server over a Unix socket. It does not start the image's Codex backend or require a second model login. The image still includes the CLI for standalone installations.

The tested CLI is **0.171.0**. Check `codex --version` and `codex app-server daemon start --help`; older CLI versions may not offer the daemon or compatible session APIs. Run the following as the same host user who normally runs Codex. If that account uses a custom `CODEX_HOME`, preserve it in this shell.

```bash
codex app-server daemon start

export PANDA_FORCE_HOST_WORKSPACE="$(pwd -P)"
export PANDA_FORCE_HOST_SOCKET="$(readlink -f "${CODEX_HOME:-$HOME/.codex}/app-server-control/app-server-control.sock")"
mkdir -p "$PANDA_FORCE_HOST_WORKSPACE/.panda-force/model-state"
test -S "$PANDA_FORCE_HOST_SOCKET"

docker run -d --name panda-force-host --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  -p 127.0.0.1:8899:8899 \
  --mount "type=bind,src=$PANDA_FORCE_HOST_WORKSPACE,dst=$PANDA_FORCE_HOST_WORKSPACE" \
  --mount "type=bind,src=$(dirname "$PANDA_FORCE_HOST_SOCKET"),dst=/run/panda-force/codex-control,readonly" \
  -e HOST=0.0.0.0 -e PORT=8899 \
  -e HOME="$PANDA_FORCE_HOST_WORKSPACE" \
  -e CODEX_HOME="$PANDA_FORCE_HOST_WORKSPACE/.panda-force/model-state" \
  -e PANDA_FORCE_HOME="$PANDA_FORCE_HOST_WORKSPACE/.panda-force" \
  -e PANDA_FORCE_ATTACHMENT_ROOT="$PANDA_FORCE_HOST_WORKSPACE/.panda-force/attachments" \
  -e PANDA_FORCE_CWD="$PANDA_FORCE_HOST_WORKSPACE" \
  -e PANDA_FORCE_REVIEW_ROOT="$PANDA_FORCE_HOST_WORKSPACE" \
  -e PANDA_FORCE_APP_SERVER_MODE=shared \
  -e PANDA_FORCE_APP_SERVER_SOCKET="/run/panda-force/codex-control/$(basename "$PANDA_FORCE_HOST_SOCKET")" \
  -e PANDA_FORCE_AUTH_MODE=password \
  hiforceai/panda-force:0.1.11

docker logs panda-force-host
```

Choose your actual working directory before running this example. Open http://localhost:8899 and create the PandaForce administrator as usual. This is an alternative to the default Compose installation; stop that installation first if it already occupies port 8899.

The workspace is mounted at the **same absolute path** on both sides so the host engine can read uploaded attachments and operate on the selected files. Only sessions whose working directories are mounted will have complete file and terminal access. Mount additional workspaces at identical absolute paths if needed.

The control socket may be a symlink into a temporary directory. The example resolves it and mounts its actual parent directory, allowing replacement of the socket at the same path after daemon restarts. If a CLI upgrade changes that target path, resolve it again and recreate the container. Matching the host user's UID/GID preserves Unix socket access. Rootless Docker, user-namespace remapping and SELinux hosts may require their own bind-mount permission setup; this example assumes standard Linux Docker permissions.

Host model credentials stay on the host; the mounted control directory does not contain `auth.json`. The separate `model-state` directory above is PandaForce's local engine-metadata location, not a copy of the host login. Application settings, rotating logs and attachments persist under the workspace's `.panda-force` directory. Keep that directory private and exclude it from Git.

Stopping or removing this container leaves the host daemon running. Shared mode respects the native task's writer and approval rules; a task actively owned by another client may still require action in that client.

For remote browser access, use an SSH tunnel to the localhost port or a separately configured HTTPS reverse proxy. Do not expose the native control socket over the network.

## Connecting from Kubernetes

See [Kubernetes deployment](./kubernetes.md) for downloadable YAML templates for both arrangements, configuration steps and storage requirements.

A Kubernetes Pod cannot automatically see a node's files or Unix sockets. To connect to Codex on that node, its deployment must:

- Run on the node where the existing Codex service runs, using a node selector or required node affinity.
- Mount the actual socket directory using `hostPath`, resolving any control-socket symlink first.
- Mount the workspaces and attachment directories at the same absolute paths used by the host service.
- Configure `PANDA_FORCE_APP_SERVER_MODE=shared` and `PANDA_FORCE_APP_SERVER_SOCKET` to the socket path visible inside the container, with a compatible Unix UID/GID.

This is why a Kubernetes container can connect to a host Codex service: the deployment explicitly shares its communication endpoint and required files. A Pod moved to another node cannot use the original node's socket through `hostPath`. Mounting the entire host model-home directory is optional for this connection; credentials are used by the host service itself. Some installations also mount that directory for local session metadata.

The default Compose setup instead starts its own Codex service inside the container. Do not copy host-service configuration into that setup unless you intend to connect to an existing service.

## Source development

Use the [development guide](building.md#run-from-source) to run a checkout directly or [build your own application image](building.md#development-container). Container installation uses the published `hiforceai/panda-force:0.1.11` image and the commands above.

## Install on your phone

Use your own HTTPS address. In iPhone Safari, choose **Share → Add to Home Screen**, enable **Open as Web App** when offered, and open PandaForce from its Home Screen icon. This opens an independent window without browser navigation controls. Android browsers can offer **Install app** or **Add to Home screen** from their menu.

Version 0.0.15 adds the PandaForce Home Screen icon and dedicated iPhone launch screens in light and dark appearances, plus immediate feedback before language and sign-in checks finish. If you installed an older shortcut showing a letter P, remove that shortcut and add the site again after updating. This removes the shortcut, not your server data. Browser and installed-app sign-in storage can differ; sign in again if prompted.

A normal browser tab controls its own address bar and navigation. PandaForce cannot force those controls to disappear. Installation does not enable offline access; a connection to your server is required.

[Enable the optional ZCode conversation runtime](harness-runtimes.md#zcode).
