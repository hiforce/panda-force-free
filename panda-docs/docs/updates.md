---
title: Upgrade PandaForce
---

Use the published `hiforceai/panda-force:0.2.4` image and matching release configuration. Review the [release notes](releases.md#024) before upgrading. The [installation guide](installation.md) is for a new installation.

## Preserve your installation

- Back up application state, the selected SQLite/MySQL database, model-account storage, workspaces and attachments using the [storage guide](storage.md). Back up a Grok account through its existing owner; avoid creating independent copies of a rotating account.
- Keep the existing Compose project name, `.env`, volume names and administrator configuration. Review configuration changes before merging them into your own files.
- Check `PANDA_FORCE_IMAGE` in `.env` and your shell. Update an old override to `hiforceai/panda-force:0.2.4`, or use your matching private-registry image. Registry credentials remain in your registry tooling.
- Retain the previous image digest and compatible backups for rollback. A database migration may require restoring its corresponding backup rather than simply starting an older image.

## Update the standard installation

From the same installation directory and Compose project:

```bash
docker compose config --images
docker compose pull panda-force
docker compose up -d --no-build
docker compose logs --tail 100 panda-force
```

Confirm the image selection before recreating containers. Keep application and model-account volumes; do not delete them to fix login or startup errors. Startup logs are private and can contain the initial installation code.

## Update an installation using Grok account renewal

Use the same Grok overlay for pulling and restarting all matching services:

```bash
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml config --images
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml pull
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml up -d --no-build
```

The application and both account helpers select the same release by default. Preserve the existing Grok account and socket volumes. Follow [Harness setup](harness-runtimes.md) if a provider needs login or if an older runtime catalog needs a Grok entry.

## Check after upgrading

Sign in with the existing administrator. Confirm your project list, saved documents and workspace files, then open **Settings → Harness Runtimes** to check the engine connection. The optional **hi** button sends a real model request. Failed startup or login is a reason to inspect the error and retained state, not to replay unfinished user tasks.

Developers maintaining custom builds can use the [development guide](building.md#development-container). Source-snapshot publication is covered separately in the [maintainer guide](releases.md#maintainer-source-snapshots).
