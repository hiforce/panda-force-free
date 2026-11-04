---
title: Configure PandaForce
---

PandaForce settings use the `PANDA_FORCE_` prefix. Legacy environment settings remain accepted for migration. The PandaForce setting wins when both names are supplied, including an explicitly empty value. All current examples use the PandaForce names. Native engine settings such as `CODEX_HOME` belong to that engine, not to PandaForce branding.

| Variable | Purpose |
| --- | --- |
| `HOST`, `PORT` | Bind address and port; defaults are localhost and 8899. |
| `PANDA_FORCE_HOME` | Private application state root. |
| `PANDA_FORCE_CWD` | Default working folder. |
| `PANDA_FORCE_REVIEW_ROOT` | Review boundary. Required in projectless mode. |
| `PANDA_FORCE_APP_SERVER_MODE` | `auto`, `isolated` or `shared` native engine connection. |
| `PANDA_FORCE_APP_SERVER_SOCKET` | Explicit shared-engine socket. |
| `PANDA_FORCE_AUTH_MODE` | Optional authentication mode; default setup creates an administrator. |
| `PANDA_FORCE_ATTACHMENT_STORAGE` | `local` by default; optional `oss` requires your own account. |
| `PANDA_FORCE_ATTACHMENT_ROOT` | Private persistent attachment directory. |
| `PANDA_FORCE_LOG_DIR` | Log directory override. |
| `PANDA_FORCE_LOG_MAX_BYTES`, `PANDA_FORCE_LOG_MAX_FILES` | Rolling limits; defaults 10 MiB and ten segments. |

```bash
PANDA_FORCE_CWD=/absolute/path/to/workspace bun run start
```

Use Bun to install dependencies so the tracked compatibility patch is applied. Supply secrets privately at runtime, never in committed environment files or client bundles.
