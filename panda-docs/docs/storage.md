---
title: State, files and backups
---

PandaForce source installs use `$HOME/.panda-force`; containers use `/var/lib/panda-force`. Configuration, logs and the project database are separate from the workspace. The model engine retains its own account and session state.

Local attachments currently default to `$CODEX_HOME/panda-force-uploads`. Set `PANDA_FORCE_ATTACHMENT_ROOT` for a separate persistent directory. Project association metadata is `data/projects.sqlite` under the application state root.

## Managed project folders (0.0.15+)

Version 0.0.15 adds managed project workspaces. Earlier images ignore these settings. Use version 0.0.15 or later before relying on directory filtering.

| Setting | Default | Purpose |
| --- | --- | --- |
| `PANDA_FORCE_PROJECTS_ROOT` | `<PANDA_FORCE_HOME>/projects`; Compose forwards `/home/codex/workspace/projects` | Parent directory for `<project-code>/` workspaces. |
| `PANDA_FORCE_ALLOW_EXTERNAL_DIRECTORIES` | `true` | Allow browsing other configured directories and native conversations. Use exactly `false` to restrict browser directory and session visibility to the project root. |

The root is a path **inside** the PandaForce container. Back it with a volume or bind mount. The standard Compose root is already under the workspace volume; choosing another container path also requires mounting persistent storage there. Docker and Kubernetes use the same settings. Shared host engines require an explicitly configured root accessible at the same absolute path on the host and in the container; PandaForce cannot make a container-private directory visible to a host service.

For example, mount your own host `/srv/panda-projects` at `/srv/panda-projects` and set `PANDA_FORCE_PROJECTS_ROOT=/srv/panda-projects`. Projects use `/srv/panda-projects/<code>/`. Use the process UID/GID to grant write access. An existing unmarked directory is not automatically adopted or overwritten. Two installations sharing a root also share its folder-name namespace; their separate project databases do not automatically share ownership.

With external directories disabled, browser directory/file roots and native history access are restricted, and refresh uses a new cache scope. Restart and refresh after changing this setting. This is a browser visibility policy; native command access is still governed by the engine's permissions. Application-owned attachments remain available through their authorized routes. Native session records stay in the engine's own state directory rather than moving into project folders.

The Compose service is `panda-force`; its default release image is `hiforceai/panda-force:0.0.15`; the development overlay uses `panda-force:local`. Volumes are `panda-force-state`, `panda-force-model-state` and `panda-force-workspace`, with a Compose project prefix.

For existing volumes, set `PANDA_FORCE_STATE_VOLUME_NAME`, `PANDA_FORCE_MODEL_VOLUME_NAME` and `PANDA_FORCE_WORKSPACE_VOLUME_NAME` to their actual Docker names before recreating the service. For absolute host-directory mounts, use `PANDA_FORCE_HOME_HOST`, `PANDA_FORCE_MODEL_HOME_HOST` and `PANDA_FORCE_WORKSPACE_HOST`. Renaming defaults does not migrate or delete old data.

Back up the configuration, application data, model state, attachments and workspace separately. Use SQLite online backup or stop PandaForce and copy the full data directory, including WAL/SHM files when present. `docker compose down` stops services; `docker compose down --volumes` also deletes named volumes.

Logs go to stdout/stderr and rolling files. Keep logs private and redact them before reporting issues.
