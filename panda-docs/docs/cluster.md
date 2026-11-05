---
title: Optional gateway cluster
---

import useBaseUrl from '@docusaurus/useBaseUrl';

This optional deployment is available in **0.0.8 and later**. Keep the [single-instance templates](./kubernetes.md) for a simple installation; single-instance deployments continue to use SQLite and do not require PostgreSQL. This example uses one workspace, two web gateways, one engine owner and an operator-managed PostgreSQL database; it is not a multi-user tenant isolation feature.

<a href={useBaseUrl('/downloads/kubernetes/panda-force-cluster.yaml')} download>Download optional cluster template (.yaml)</a>

## What scales

The gateways accept HTTP, WebSocket, terminal and event-stream connections. They authenticate their internal requests and forward them to the current owner. Gateways do not open the workspace database or start a CLI. They can run on different nodes without sticky browser sessions.

Exactly one owner runs the isolated engine. It owns the persistent workspace, model login, settings, administrator, project catalog, attachment files, session revocations and rotating service logs. All gateways access those files through the owner. User-owned object storage is optional; there is no bundled OSS account.

PostgreSQL holds the workspace owner and monotonically increasing generation, an event journal and durable command identities. Completed command results are retained for seven days, then reduced to uncertain tombstones. An uncertain command is never automatically executed again. Events are retained for one day; reconnecting clients refresh authoritative session state when they cannot replay their previous generation. Local browser caches are not the persistence boundary.

This scales the **web entry points**. It does not distribute a single workspace's CLI execution across owners, migrate SQLite to PostgreSQL, automatically take over unfinished tasks, or provide a ready-made Claude adapter. The current registered conversation engine is Codex. An unavailable owner makes its workspace temporarily unavailable.

## Prepare and start

Use PostgreSQL reachable from every Pod, with a dedicated database and credentials authorized to create the coordination tables. Manage database backups and connection security yourself. Use a CSI volume provisioner supporting `ReadWriteOncePod` for the owner, so another Pod cannot mount the workspace concurrently. SQLite WAL remains on that exclusive owner volume; it is never shared between gateway processes. [Kubernetes access modes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes) and [SQLite WAL restrictions](https://sqlite.org/wal.html) explain these storage constraints.

1. Download the template. Replace **every** `REPLACE_WITH_VERIFIED_IMAGE` with your tested release image or immutable digest. Set `PANDA_FORCE_PUBLIC_URL` to your actual HTTPS origin on both roles. Configure `storageClassName` if there is no suitable default. Keep the owner at one replica and isolated engine mode.
2. Create the namespace and Secret. Put your PostgreSQL URL in a local file named `database-url`, and a randomly generated signing key of at least 32 characters in `signing-key`. Keep those files private and out of Git. The two roles use the same values:

   ```bash
   kubectl create namespace panda-force
   kubectl -n panda-force create secret generic panda-cluster \
     --from-file=database-url --from-file=signing-key
   kubectl apply -f panda-force-cluster.yaml
   kubectl -n panda-force rollout status statefulset/panda-owner --timeout=300s
   kubectl -n panda-force rollout status deployment/panda-gateway --timeout=300s
   ```

3. Point your TLS ingress at `service/panda-force:8899`. Configure WebSocket upgrades, an event-stream timeout longer than a normal request, and disable buffering for `/api/events`. Owner communication must remain on a trusted private network, protected by network policy or your mesh. The request signatures provide integrity and authentication; they do not encrypt HTTP traffic. Provision internal HTTPS if the network requires encryption.
4. Open your public origin. Create the PandaForce administrator using the owner Pod's installation code if prompted. Sign in to the native engine **on the owner**:

   ```bash
   kubectl -n panda-force logs panda-owner-0 -c panda-force
   kubectl -n panda-force exec -it panda-owner-0 -c panda-force -- codex login --device-auth
   ```

Create a session, upload an image, open the session in another browser connection, and confirm both connections see the same work. Terminal sessions also run on the owner. Native engine sandbox requirements still apply to your cluster.

## Planned updates and recovery

For a planned update, drain new work and stop active tasks as needed. Gracefully stop the owner. The app releases ownership only after its engine has stopped; the next owner can then claim a new generation. Keep the persistent volume. Do not force-delete a running owner to accelerate deployment.

After an abrupt crash or lease timeout the database deliberately retains the old ownership record. **Lease expiry alone does not prove external CLI work has stopped.** First confirm that the previous owner Pod, its container execution namespace and every task it started are stopped. During a node partition this may require fencing or powering off the old node. Confirming only that the Pod is missing from the API is insufficient.

An operator can read the previous generation in PostgreSQL:

```sql
SELECT workspace, node_id, boot_id, fence, expires_at, released
FROM panda_workspace_owners WHERE workspace = 'example-workspace';
```

After confirming the old execution environment has stopped, set `PANDA_FORCE_CLUSTER_RECOVER_FENCE` to that exact `fence` value on the replacement owner. Recovery succeeds only after the previous lease expires and if the generation still matches. Remove the recovery override after successful startup. Never automate that override on every restart. Inspect the session before resubmitting any command reported as uncertain.

Back up the owner volume and coordination database together while the owner is stopped. Restore into an isolated environment first. Restoring only PostgreSQL does not restore native conversations, project SQLite data, authentication files or local attachments. A node-local volume requires restoring or moving its data before the owner can run elsewhere.

## Operations

- Scale `deployment/panda-gateway`; never increase `statefulset/panda-owner` replicas for this workspace.
- Use `/health/liveness` for process health and `/health/readiness` for owner availability.
- The owner persists rolling logs under `/var/lib/panda-force/logs`. Gateways keep bounded local logs in their temporary volume and also write to Kubernetes stdout/stderr; use your cluster log collector for gateway history across Pod replacement.
- A lost or stalled lease closes the owner rather than continuing native writes. Fix PostgreSQL connectivity before recovery.
- Gateway image builds run the same complete verification gate as the owner image. The runtime image includes `/app/verification.json`, recording tested source identity and tool versions.

The template contains no organization-specific domains, node paths, credentials or deployment identifiers. It does not create PostgreSQL, an ingress controller, a TLS certificate, backups or automatic failover.
