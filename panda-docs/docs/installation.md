---
title: Install and sign in
---

## Published images

A public prebuilt image has not been released. No image tag is advertised as available. Maintainers will publish a versioned image before enabling the pull-and-start installation path.

## Build from source

Install Bun 1.4.2, Node.js 22, Git, Python 3 and a C++ build toolchain. The tested CLI is 0.166.0.

```bash
bun install --frozen-lockfile
npm rebuild node-pty --build-from-source
npm install -g @openai/codex@0.166.0
codex
bun run start
```

Open http://127.0.0.1:8899. Create your PandaForce administrator in the browser. The password requires at least six characters, including uppercase and lowercase letters and a number. No startup password is required. Sign in to the native CLI separately when needed.

## Build a local container

This path is for source builders. It uses public base images and does not require the maintainer's registry credentials.

```bash
docker compose up --build -d
docker compose logs panda-force
docker compose exec -it panda-force codex
```

If initial setup requests an installation code, read your private startup logs. The default port binds only to localhost. See [storage](./storage.md) before replacing an existing installation.
