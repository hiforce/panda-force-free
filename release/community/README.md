# PandaForce Free

A free, MIT-licensed AI workspace with best-effort community maintenance and no SLA commitments. Free to use, modify, and fork, including commercially.

[简体中文](./README-zh.md) · [License](./LICENSE) · [Usage](./USAGE.md) · [Security](./SECURITY.md) · [Contributing](./CONTRIBUTING.md) · [Updates](./UPDATES.md)

## Features

- Native Codex conversations, streaming responses, tool activity and model controls.
- Named projects with unique codes and optional descriptions, independently associated with native sessions and working folders.
- Command/file approvals, global pending-request inbox, native question forms and change review.
- Image/file attachments, including clipboard image uploads; local storage is the default and no cloud credentials are included.
- Workspace file browsing, source previews and an integrated terminal.
- Browser-based administrator setup, real preparation progress, mobile layouts, English/Simplified Chinese and light/dark themes.

The current execution engine is Codex app-server. Claude and other CLI engines are not integrated. Native question forms support per-question single choice and permitted free text; multiple selections in one question are not implemented. Only public reasoning summaries supplied by the engine can be displayed.

## Quick start

Requirements: Bun **1.4.2**, Node.js **22** (validated with 22.23.4), Git, and an installed Codex CLI. The application has been validated against Codex CLI **0.166.0**; newer protocol versions can change behavior. Windows has not been fully validated.

```bash
git clone https://github.com/hiforce/panda-force-free.git
cd panda-force-free
bun install --frozen-lockfile
npm rebuild node-pty --build-from-source
npm install -g @openai/codex@0.166.0
codex
bun run start
```

Sign in to Codex when prompted, then open **http://127.0.0.1:8899**. A fresh PandaForce installation asks you to create an administrator. No preset password, cloud account, private registry or configuration file is required. This administrator is separate from your model-provider account.

The terminal's native module needs Python 3, Make and a C++ compiler. On Debian/Ubuntu, install `python3 build-essential`; on macOS, install the Xcode Command Line Tools. Rebuild node-pty after changing Node versions. If Conda interferes, use `npm_config_python=/usr/bin/python3 npm rebuild node-pty --build-from-source`. Use Bun to install dependencies: the tracked urllib compatibility patch is applied by Bun, not by plain `npm install`.

To choose a working directory:

```bash
CODEX_WEBUI_CWD=/absolute/path/to/workspace bun run start
```

Prefer absolute paths. Normal folder browsing is constrained to your home directory. All admitted users share the same workspace, terminal privileges and native model account; this is not a multi-tenant isolation boundary.

## Docker

The included Dockerfile uses public, digest-pinned Bun and Node images. Compose binds to localhost and uses persistent named volumes by default:

```bash
docker compose up --build -d
docker compose logs codex-webui
```

On first initialization through Docker, use the installation code printed in the logs if requested. To sign in to the container's model account:

```bash
docker compose exec -it codex-webui codex
```

Keep the state volumes. `docker compose down` stops the service; adding `--volumes` deletes the named state volumes. The defaults run as UID/GID 1000. When mounting host directories, prepare ownership for that user before starting. Shared host-daemon mode additionally requires matching socket permissions, user identity and identical paths; the standalone example intentionally uses isolated mode.

## Storage, configuration and logs

- Source installs use `$HOME/.panda-force` for application configuration, rolling logs and project metadata. Docker uses `/var/lib/panda-force`.
- Model account state uses `$CODEX_HOME` or `$HOME/.codex`, independently of the PandaForce administrator.
- Local attachments default to `$CODEX_HOME/codex-webui-uploads`; set `CODEX_WEBUI_ATTACHMENT_ROOT` to choose a private persistent directory. Up to 10 files per message and 25 MiB per file are supported.
- Application logs go to both stdout/stderr and the logs directory; defaults retain at most 10 segments of 10 MiB each.
- Project metadata lives in `data/projects.sqlite`. Back up via SQLite's online backup facility or stop the application and copy the entire data directory, including WAL/SHM files where present.
- `.env.example` documents optional settings. Provider/API usage, hosting and storage costs remain yours.

CLI shared mode and optional IDAAS/OSS integrations are available in the source, but are not needed for local use. Supply your own credentials privately; no maintainer credentials or bucket configuration are distributed. Never expose the terminal/workspace to untrusted users. Put remote access behind HTTPS and authentication.

## Maintenance and free use

Maintenance is best effort. The maintainer may review reports and publish updates, but promises no SLA, release schedule, response time, security backport or fix deadline. Paid personal work, customization and time-bound support require a separate agreement; they are not prerequisites for exercising this edition's MIT rights.

This edition has no PandaForce project-value usage fee, including for commercial projects. You may modify it and maintain your own forks under the applicable licenses. Commercial policies of another edition do not withdraw rights already granted for this snapshot. Models, APIs and other providers can charge separately.

## Provenance and third-party rights

PandaForce derives from [lezi-fun/codex-webui](https://github.com/lezi-fun/codex-webui). Thank you to lezi-fun and the upstream contributors. The original MIT copyright and permission notice are preserved. See [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

The exported tree contains source-controlled PandaForce visuals and Lucide icons; extracted proprietary desktop images/animation data are excluded. Installed dependencies retain their own licenses. PandaForce is independent of OpenAI and Anthropic and is not endorsed by either company.

`SNAPSHOT.json` inventories the published files and content hashes. It contains no private Git history. This repository has its own public update history. See [UPDATES.md](./UPDATES.md) for safe subsequent changes.
