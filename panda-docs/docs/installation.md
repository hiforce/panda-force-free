---
title: Install and sign in
---

## Understand what runs where

PandaForce provides the browser interface and a service that sends your requests to an execution engine. Codex is the currently supported engine: it reads files, runs commands and returns results. Your PandaForce administrator account controls access to the interface; your Codex login controls access to the model service.

There are two independent choices:

| Choice | Options |
| --- | --- |
| Where PandaForce runs | Directly on a machine, in Docker, or in a Kubernetes container |
| Which Codex executes tasks | A separate Codex service started inside the PandaForce container (`isolated`), or an existing Codex service on the machine (`shared`) |

A host is the machine running a container. It can be a physical server or a virtual machine; in Kubernetes it is the node running the Pod. Connecting to an existing Codex service does **not** mean PandaForce itself must run directly from a host terminal.

With the default container installation, the browser connects to PandaForce in the container, and PandaForce starts Codex in that container. With an existing host service, the browser still connects to PandaForce in the container, but PandaForce forwards work to Codex already running on the host.

A Unix socket is a local communication endpoint between processes, represented by a filesystem path. Mounting the actual socket directory into the container makes that endpoint accessible to PandaForce, subject to filesystem permissions. This shares a service connection, not just a login file.

## Start the published container

The current container release is **hiforceai/panda-force:0.0.10**, currently for Linux amd64. The image contains Bun, Node.js and the supported Codex CLI. You do not need to install those tools separately on the host.

From a checkout of this repository:

```bash
docker compose pull panda-force
docker compose up -d
docker compose logs panda-force
```

Open http://127.0.0.1:8899. Create your PandaForce administrator in the browser. The password requires at least six characters, including uppercase and lowercase letters and a number. If setup requests an installation code, read your private startup logs. No preset password, model account or object-storage credentials are built into the image.

Sign in to the native model account separately:

```bash
docker compose exec -it panda-force codex login --device-auth
docker compose restart panda-force
```

The default port binds only to localhost. State persists in named volumes. See [storage](./storage.md) before replacing an existing installation. The administrator and model-provider accounts are independent.

## Use Codex already installed on the host

This option is for a Linux Docker host with an existing Codex login. Shared mode connects to the host's app-server over a Unix socket. It does not start the image's Codex backend or require a second model login. The image still includes the CLI for standalone installations.

The tested CLI is **0.166.0**. Check `codex --version` and `codex app-server daemon start --help`; older CLI versions may not offer the daemon or compatible session APIs. Run the following as the same host user who normally runs Codex. If that account uses a custom `CODEX_HOME`, preserve it in this shell.

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
  hiforceai/panda-force:0.0.10

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

## Build from source

Install Bun 1.4.2, Node.js 22, Git, Python 3 and a C++ build toolchain. The tested CLI is 0.166.0.

```bash
bun install --frozen-lockfile
npm rebuild node-pty --build-from-source
npm install -g @openai/codex@0.166.0
codex
bun run start
```

## Build a local container for development

Use the build overlay. It tags the local result as `panda-force:local`, separately from the published release tag.

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build -d
docker compose logs panda-force
```

The community Dockerfile uses public base images. This source build is optional; normal installation pulls the released image.
