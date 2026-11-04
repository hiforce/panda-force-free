---
title: Install and sign in
---

## Start the published container

The first container release is **hiforceai/panda-force:0.0.1**, currently for Linux amd64. The image contains Bun, Node.js and the supported Codex CLI. You do not need to install those tools separately on the host.

From a checkout of this repository:

```bash
docker compose pull panda-force
docker compose up -d
docker compose logs panda-force
```

Open http://127.0.0.1:8899. Create your PandaForce administrator in the browser. The password requires at least six characters, including uppercase and lowercase letters and a number. If setup requests an installation code, read your private startup logs. No preset password, model account or object-storage credentials are built into the image.

Sign in to the native model account separately:

```bash
docker compose exec -it panda-force codex
```

The default port binds only to localhost. State persists in named volumes. See [storage](./storage.md) before replacing an existing installation. The administrator and model-provider accounts are independent.

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
