---
title: State, files and backups
---

PandaForce source installs use `$HOME/.panda-force`; containers use `/var/lib/panda-force`. Configuration, logs and the project database are separate from the workspace. The model engine retains its own account and session state.

Local uploads from the composer are stored under the selected working directory. Uploads from older clients that do not supply a working directory retain their persistent staging location, defaulting to `$CODEX_HOME/panda-force-uploads`, or `PANDA_FORCE_ATTACHMENT_ROOT` when configured. Existing attachment links are preserved. With SQLite selected, project association metadata is `data/projects.sqlite` under the application state root. With MySQL selected, business records use that database; workspace files and model state still need separate backups.

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

## S3-compatible storage for saved originals

In **Settings → Storage**, an installation administrator can choose local storage or an S3-compatible connection for new images, videos, presentations, web pages and other creative files. Select the file types to route, then provide the bucket, region, optional object prefix and access credentials. Advanced options include a custom root endpoint and path-style addressing. An empty endpoint uses the regional AWS S3 endpoint. The provider must support the standard conditional-write, metadata, exact-version and byte-range operations used by the application.

Local storage is the default. Saving these settings does not contact the provider or move existing files. New writes check read authority and connectivity before uploading. Connection changes retain the frozen locations of existing originals; use the saved-connection credential repair form when an older connection needs replacement keys. Empty credential fields preserve saved keys, and leaving the page clears newly entered secrets. Stored secret keys remain on the server; a presigned URL carries the non-secret access-key identifier and a signature limited to that object. The connection needs read, write and cleanup permissions, including access to the application's object versions when bucket versioning is enabled.

Viewing, playback and downloads start with application login and project authorization. For S3 originals, the application then redirects the browser to a signed, exact-object download URL so original media bytes travel directly from the provider to the browser. The application reuses a link for up to 24 hours and refreshes it near expiry; signing happens locally without a separate token request to S3. The configured endpoint must be reachable from the browser. Local files retain their existing delivery, and bounded gallery thumbnails are generated and served by the application. The application does not set public ACLs or change bucket policies; a bucket an administrator has independently made public retains that policy. Login authentication must remain enabled to request new links.

Choose **Get image link** or **Get file link** in the file viewer to reveal and copy its direct URL. Only this explicit sharing action shows the 24-hour lifetime and the actual expiry time. Anyone holding a signed URL can use it until expiry, including after logout, permission changes or moving the file to Trash; those actions prevent new grants but do not revoke URLs already issued. Completed permanent deletion removes the known object versions so those links no longer retrieve the originals. Temporary provider credentials or a provider policy may impose an earlier expiry.

Moving a file to Trash preserves its originals and resources for restoration. **Delete permanently** records an irreversible deletion request and queues cleanup of that asset's known S3 object versions and resources. Independent copies use separate object keys. Interrupted or denied cleanup remains visible and retryable, including after an application restart; an uncertain upload is not reported as deleted just because a temporary existence check finds no object.

This configuration is separate from static CDN credentials and from conversation attachment storage. It covers saved creative originals and their resources; native engine history and private renderer recovery caches keep their existing storage. Keep the application metadata and project content in backups alongside the S3 objects so saved locations and cleanup receipts remain available. No shared engine state is automatically removed when an original is deleted.

Configuration, independent credential records and cleanup journals live in the private `original-storage` directory under the application state root, which the standard Compose state volume already persists. Administrators needing a different parent may set `PANDA_FORCE_ORIGINAL_STORAGE_PARENT` in the service environment and mount that parent on persistent storage; the application still uses its dedicated `original-storage` child. These settings are included in the published 0.1.6 application image.

## Managed project folders (0.0.15+)

Version 0.0.15 adds managed project workspaces. Earlier images ignore these settings. Use version 0.0.15 or later before relying on directory filtering.

| Setting                                  | Default                                                                          | Purpose                                                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PANDA_FORCE_PROJECTS_ROOT`              | `<PANDA_FORCE_HOME>/projects`; Compose forwards `/home/codex/workspace/projects` | Parent directory for `<project-code>/` workspaces.                                                                                                                  |
| `PANDA_FORCE_ALLOW_EXTERNAL_DIRECTORIES` | `true`                                                                           | Allow browsing other configured directories and native conversations. Use exactly `false` to restrict browser directory and session visibility to the project root. |

The root is a path **inside** the PandaForce container. Back it with a volume or bind mount. The standard Compose root is already under the workspace volume; choosing another container path also requires mounting persistent storage there. Docker and Kubernetes use the same settings. Shared host engines require an explicitly configured root accessible at the same absolute path on the host and in the container; PandaForce cannot make a container-private directory visible to a host service.

For example, mount your own host `/srv/panda-projects` at `/srv/panda-projects` and set `PANDA_FORCE_PROJECTS_ROOT=/srv/panda-projects`. Projects use `/srv/panda-projects/<code>/`. Use the process UID/GID to grant write access. An existing unmarked directory is not automatically adopted or overwritten. Two installations sharing a root also share its folder-name namespace; their separate project databases do not automatically share ownership.

With external directories disabled, browser directory/file roots and native history access are restricted, and refresh uses a new cache scope. Restart and refresh after changing this setting. This is a browser visibility policy; native command access is still governed by the engine's permissions. Application-owned attachments remain available through their authorized routes. Native session records stay in the engine's own state directory rather than moving into project folders.

The Compose service is `panda-force`; its release image is `hiforceai/panda-force:0.1.6`. Volumes are `panda-force-state`, `panda-force-model-state` and `panda-force-workspace`, with a Compose project prefix. The Grok overlay adds separate account and socket volumes. The account service owns the account volume; the socket volume holds communication state and does not replace an account backup.

For existing volumes, set `PANDA_FORCE_STATE_VOLUME_NAME`, `PANDA_FORCE_MODEL_VOLUME_NAME` and `PANDA_FORCE_WORKSPACE_VOLUME_NAME` to their actual Docker names before recreating the service. For absolute host-directory mounts, use `PANDA_FORCE_HOME_HOST`, `PANDA_FORCE_MODEL_HOME_HOST` and `PANDA_FORCE_WORKSPACE_HOST`. Renaming defaults does not migrate or delete old data.

Back up the configuration, application data, model state, attachments and workspace separately. Use SQLite online backup or stop PandaForce and copy the full data directory, including WAL/SHM files when present. `docker compose down` stops services; `docker compose down --volumes` also deletes named volumes.

Logs go to stdout/stderr and rolling files. Keep logs private and redact them before reporting issues.
