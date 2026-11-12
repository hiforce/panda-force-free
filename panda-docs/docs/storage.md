---
title: State, files and backups
---

PandaForce source installs use `$HOME/.panda-force`; containers use `/var/lib/panda-force`. Configuration, logs and the project database are separate from the workspace. The model engine retains its own account and session state.

Local uploads from the composer are stored under the selected working directory. Uploads from older clients that do not supply a working directory retain their persistent staging location, defaulting to `$CODEX_HOME/panda-force-uploads`, or `PANDA_FORCE_ATTACHMENT_ROOT` when configured. Existing attachment links are preserved. Project association metadata is `data/projects.sqlite` under the application state root.

## Attachment working directories

PandaForce uses one layout within each shared workspace:

```text
<working-directory>/attachments/
  input/<upload-id>/<original-filename>
  work/<session-id>/
  output/<session-id>/
```

The composer captures its destination when uploading, including when navigation changes before the upload finishes. A new managed project uses its server-resolved workspace. Input files retain their original names and separate upload IDs prevent collisions. Processing and output directories are isolated by session. Originals, intermediate files and delivered files remain in the workspace volume; PandaForce does not automatically remove them when a conversation ends.

Application context on each submitted turn, steering message and queued message tells the engine where to process files and deliver attachments. This also covers existing loaded conversations without replacing their instructions or restarting the shared daemon. The context is excluded from displayed user messages, composer history and optimistic message matching. Normal repository edits continue to use their intended project files.

The engine and web service must see the workspace at the **same absolute path**, backed by persistent storage. A private marker at `attachments/.panda-attachments.json` identifies the directory prepared by the web service. The application context tells the engine to read and verify that marker before file processing; a missing or different marker indicates a mount mismatch. If the service cannot prepare a writable attachment directory, ordinary conversation continues with an explicit unavailable-workspace context instead of silently choosing another directory.

Container-private directories, host-only `/mnt/data` and `/tmp` are not delivery locations. A `sandbox:` link changes no filesystem mounts. Copy externally generated tool results into the workspace output directory before linking them. Download and image routes continue to enforce their existing file boundaries; symlinked attachment directories and paths outside the configured roots are rejected.

Legacy local attachments and configured OSS uploads remain readable through their existing routes. OSS input storage does not make engine-generated output files available automatically: those outputs still belong in the shared workspace. No automatic search, basename guessing or copying from arbitrary host paths is performed when a link fails.

## Managed project folders (0.0.15+)

Version 0.0.15 adds managed project workspaces. Earlier images ignore these settings. Use version 0.0.15 or later before relying on directory filtering.

| Setting                                  | Default                                                                          | Purpose                                                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PANDA_FORCE_PROJECTS_ROOT`              | `<PANDA_FORCE_HOME>/projects`; Compose forwards `/home/codex/workspace/projects` | Parent directory for `<project-code>/` workspaces.                                                                                                                  |
| `PANDA_FORCE_ALLOW_EXTERNAL_DIRECTORIES` | `true`                                                                           | Allow browsing other configured directories and native conversations. Use exactly `false` to restrict browser directory and session visibility to the project root. |

The root is a path **inside** the PandaForce container. Back it with a volume or bind mount. The standard Compose root is already under the workspace volume; choosing another container path also requires mounting persistent storage there. Docker and Kubernetes use the same settings. Shared host engines require an explicitly configured root accessible at the same absolute path on the host and in the container; PandaForce cannot make a container-private directory visible to a host service.

For example, mount your own host `/srv/panda-projects` at `/srv/panda-projects` and set `PANDA_FORCE_PROJECTS_ROOT=/srv/panda-projects`. Projects use `/srv/panda-projects/<code>/`. Use the process UID/GID to grant write access. An existing unmarked directory is not automatically adopted or overwritten. Two installations sharing a root also share its folder-name namespace; their separate project databases do not automatically share ownership.

With external directories disabled, browser directory/file roots and native history access are restricted, and refresh uses a new cache scope. Restart and refresh after changing this setting. This is a browser visibility policy; native command access is still governed by the engine's permissions. Application-owned attachments remain available through their authorized routes. Native session records stay in the engine's own state directory rather than moving into project folders.

The Compose service is `panda-force`; its default release image is `hiforceai/panda-force:0.0.15`; the development overlay uses `panda-force:local`. Volumes are `panda-force-state`, `panda-force-model-state` and `panda-force-workspace`, with a Compose project prefix.

For existing volumes, set `PANDA_FORCE_STATE_VOLUME_NAME`, `PANDA_FORCE_MODEL_VOLUME_NAME` and `PANDA_FORCE_WORKSPACE_VOLUME_NAME` to their actual Docker names before recreating the service. For absolute host-directory mounts, use `PANDA_FORCE_HOME_HOST`, `PANDA_FORCE_MODEL_HOME_HOST` and `PANDA_FORCE_WORKSPACE_HOST`. Renaming defaults does not migrate or delete old data.

Back up the configuration, application data, model state, attachments and workspace separately. Use SQLite online backup or stop PandaForce and copy the full data directory, including WAL/SHM files when present. `docker compose down` stops services; `docker compose down --volumes` also deletes named volumes.

Logs go to stdout/stderr and rolling files. Keep logs private and redact them before reporting issues.
