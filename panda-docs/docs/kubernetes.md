---
title: Deploy on Kubernetes
---

import useBaseUrl from '@docusaurus/useBaseUrl';

PandaForce can run in Kubernetes using either of the [two Codex arrangements](./installation.md#understand-what-runs-where). These downloadable templates are independently written public examples. They contain no private deployment settings, credentials, domains, node identities or account data.

## Download a template

Choose **one** template. Both define the same application and storage names; do not apply both to the same namespace or switch an existing installation without a data migration plan.

| Template | Where tasks execute | Model login |
| --- | --- | --- |
| Container Codex (`isolated`) | A Codex service started inside the PandaForce container | Sign in inside the Pod |
| Existing machine Codex (`shared`) | A Codex service already running on a specific Kubernetes node | Reuse that service's host login |

- <a href={useBaseUrl('/downloads/kubernetes/panda-force-isolated.yaml')} download>Download container Codex template (.yaml)</a>
- <a href={useBaseUrl('/downloads/kubernetes/panda-force-shared.yaml')} download>Download existing machine Codex template (.yaml)</a>

In a source checkout, these files are under `panda-docs/static/downloads/kubernetes/`. Download links in the built HTML help serve the actual YAML files, not a screenshot or a code preview. Save and edit your own copy before applying it.

## Before deploying

Use a Linux amd64 cluster, `kubectl`, and a working persistent-volume provisioner. The templates use the public `hiforceai/panda-force:0.0.7` image and a 10 GiB `ReadWriteOnce` PVC. If your cluster has no default StorageClass, add `storageClassName: YOUR_STORAGE_CLASS` under the PVC's `spec`. Confirm the class supports your node placement; a class using `WaitForFirstConsumer` can defer volume binding until scheduling.

Both templates include a Namespace, PVC, Deployment and ClusterIP Service. They use one replica and `Recreate` updates for this single-instance application and its SQLite data. CPU/memory values are starting points; adjust them for your workload. Persistent-volume ownership must allow the configured Unix user to write; the example uses UID/GID 1000 and `fsGroup: 1000`. The init container creates only application directories on the PVC, and does not change node directories.

The example does not create a domain, Ingress, TLS certificate or model account. Start with port forwarding; configure your own HTTPS ingress separately if needed.

## Option A: use Codex inside the container

This requires no Codex installation on the node. After downloading the isolated template:

```bash
kubectl apply -f panda-force-isolated.yaml
kubectl -n panda-force rollout status deployment/panda-force --timeout=300s
kubectl -n panda-force logs deployment/panda-force -c panda-force
kubectl -n panda-force port-forward service/panda-force 8899:8899
```

Keep port forwarding running and open **http://localhost:8899**. Create your PandaForce administrator; retrieve the installation code from the private Pod logs if asked. In a second terminal, sign in to your model account:

```bash
kubectl -n panda-force exec -it deployment/panda-force -c panda-force -- codex login --device-auth
kubectl -n panda-force rollout restart deployment/panda-force
kubectl -n panda-force rollout status deployment/panda-force --timeout=300s
```

Reconnect port forwarding if the Pod restart closes it, then refresh the browser. Follow the sign-in instructions printed by the CLI. The image includes the tested CLI; neither host authentication files nor host socket mounts are needed in this arrangement.

## Option B: connect to Codex already on a node

The container still runs PandaForce. Task execution happens in the node's existing Codex service. Follow these steps before applying the shared template:

1. Choose the node that actually runs Codex. Obtain its Kubernetes node name with `kubectl get nodes`. Replace `REPLACE_WITH_NODE_NAME` in `nodeSelector`.
2. On that node, as the account that normally runs Codex, start the service and resolve the real socket:

   ```bash
   codex --version
   codex app-server daemon start
   readlink -f "${CODEX_HOME:-$HOME/.codex}/app-server-control/app-server-control.sock"
   id -u
   id -g
   ```

   The tested CLI is 0.166.0. Preserve a custom `CODEX_HOME` when running these commands. This step starts a service; it does not start PandaForce directly on the node.
3. Split the resolved socket path into its directory and filename. Set the `host-control` volume's `hostPath.path` to that directory. Replace `REPLACE_WITH_SOCKET_FILENAME` in `PANDA_FORCE_APP_SERVER_SOCKET` with the actual filename. The directory is mounted at `/run/panda-force/codex-control` inside the container. Mounting only the original symlink's directory can leave its target inaccessible.
4. Replace **every** `/srv/panda-force/workspace` occurrence with your chosen, existing workspace's absolute path, including `HOME`, `PANDA_FORCE_CWD`, `PANDA_FORCE_REVIEW_ROOT`, `PANDA_FORCE_ATTACHMENT_ROOT`, `volumeMounts` and `hostPath`. Keep the workspace at the **same absolute path** inside and outside the container. The Codex account must be able to write it and the attachment subdirectory.
5. Set `runAsUser`, `runAsGroup` and `fsGroup` to the host account's actual UID/GID, and confirm the PVC supports those ownership settings. The socket directory's permissions must allow that account access. Cluster admission policies must permit these specific hostPath mounts.

Check your edited file has no remaining placeholder values:

```bash
# This should print no matches after you finish editing.
grep -n 'REPLACE_WITH_' panda-force-shared.yaml
kubectl apply -f panda-force-shared.yaml
kubectl -n panda-force rollout status deployment/panda-force --timeout=300s
kubectl -n panda-force logs deployment/panda-force -c panda-force
kubectl -n panda-force port-forward service/panda-force 8899:8899
```

Open **http://localhost:8899** and create the PandaForce administrator. Do not run a second model login inside the Pod: this arrangement uses the node service's existing login. The template mounts the actual socket directory and workspace, without mounting the host's entire model home or `auth.json`.

HostPath data and sockets belong to a particular node. The node selector is required for this arrangement; moving the Pod to another node does not move the Codex service or workspace. Mount additional workspace directories at identical absolute paths if you need their file and terminal access. If a CLI update changes the real socket path, update the template and recreate the Pod. A cluster whose policy disallows hostPath cannot use this specific shared template.

Stopping PandaForce leaves the node service running. Existing tasks continue to follow Codex's writer and approval rules; actions owned by another client may need to be completed there.

## Storage, logs and checks

| Data | Container Codex template | Existing machine Codex template |
| --- | --- | --- |
| PandaForce settings, administrator, project data and rotating logs | PVC at `/var/lib/panda-force` | PVC at `/var/lib/panda-force` |
| Model login and model sessions | PVC `model-state` directory | Managed by the node's existing Codex service |
| Workspace | PVC `workspace` directory | Explicit node workspace bind mount |
| Attachments | PVC `attachments` directory | `.panda-force-attachments` under the mounted node workspace |

The shared template also keeps PandaForce's own engine metadata in the PVC's `model-state` directory; this is not a copy of the host account. Model and app storage should both be backed up. See [storage and backups](./storage.md). Removing or deleting the PVC can delete application data depending on the StorageClass reclaim policy; these instructions do not delete it.

```bash
kubectl -n panda-force get pods,pvc,service
kubectl -n panda-force describe deployment panda-force
kubectl -n panda-force logs deployment/panda-force -c panda-force --tail=100
```

Application logs are also written under `/var/lib/panda-force/logs`, with 10 MiB per segment and ten segments by default. Kubernetes stdout/stderr retention is controlled separately by your cluster's logging configuration.

If the Pod is Pending, check PVC binding, resources and the node selector. If it cannot mount a host directory, check the path exists on the selected node. If shared mode reports an unavailable socket, check the resolved target, filename and Unix permissions. A Ready Pod confirms the app-server connection, not that a model account can complete a paid model request. Verify your first conversation and upload after login. Native CLI command execution also depends on your cluster's support for the engine's sandbox requirements.

These templates are validated as Kubernetes manifests and the help build checks both download files. They are examples for adaptation, not an automatic migration of an existing deployment.

Kubernetes references: [Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/), [hostPath volumes](https://kubernetes.io/docs/concepts/storage/volumes/#hostpath), and [Pod security contexts](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/).
