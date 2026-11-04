---
title: State, files and backups
---

PandaForce source installs use `$HOME/.panda-force`; containers use `/var/lib/panda-force`. Configuration, logs and the project database are separate from the workspace. The model engine retains its own account and session state.

Local attachments currently default to `$CODEX_HOME/panda-force-uploads`. Set `PANDA_FORCE_ATTACHMENT_ROOT` for a separate persistent directory. Project association metadata is `data/projects.sqlite` under the application state root.

The Compose service is `panda-force`; its default release image is `hiforceai/panda-force:0.0.3`; the development overlay uses `panda-force:local`. Volumes are `panda-force-state`, `panda-force-model-state` and `panda-force-workspace`, with a Compose project prefix.

For existing volumes, set `PANDA_FORCE_STATE_VOLUME_NAME`, `PANDA_FORCE_MODEL_VOLUME_NAME` and `PANDA_FORCE_WORKSPACE_VOLUME_NAME` to their actual Docker names before recreating the service. For absolute host-directory mounts, use `PANDA_FORCE_HOME_HOST`, `PANDA_FORCE_MODEL_HOME_HOST` and `PANDA_FORCE_WORKSPACE_HOST`. Renaming defaults does not migrate or delete old data.

Back up the configuration, application data, model state, attachments and workspace separately. Use SQLite online backup or stop PandaForce and copy the full data directory, including WAL/SHM files when present. `docker compose down` stops services; `docker compose down --volumes` also deletes named volumes.

Logs go to stdout/stderr and rolling files. Keep logs private and redact them before reporting issues.
