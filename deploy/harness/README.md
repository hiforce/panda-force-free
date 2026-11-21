# Grok authentication and Harness Runtime

Build the current source image, then combine the normal Compose file and this overlay:

```sh
export PANDA_FORCE_IMAGE=panda-force:local
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml up -d
```

By default, the account lives in a private Docker named volume, including on Docker Desktop. This keeps native Unix file permissions independent of Windows/macOS bind-mount behavior. The initializer assigns the named account and socket volumes to the configured `PUID`/`PGID`.

On Linux, an existing operator account can instead be selected with `PANDA_FORCE_GROK_ACCOUNT_HOME_HOST=/absolute/operator-owned/grok-account`. That directory and its credential file must already belong to the configured `PUID`/`PGID`, with private native permissions. The initializer never changes the ownership of this host bind. Keep the existing owner and use matching IDs, or use the dedicated named volume and sign in there. Do not copy one rotating refresh token into several independently managed account homes.

For a dedicated account, complete the official one-time device login through the account service:

```sh
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml run --rm grok-auth grok --no-auto-update login --device-auth
```

The `grok-auth` service owns the account directory. The application mounts only a named socket volume; this works with Docker Desktop as well as Linux and does not require a host daemon or Kubernetes. Private registries and explicit pull policies remain available through the normal image and pull-policy overrides. Build from source containing this feature; older stable images do not contain the credential service.

Before model discovery, connection tests and chat dispatch, the account service rereads the account file. Within five minutes of expiry it runs the installed native CLI's `models` command in an empty temporary directory, with stdin closed, automatic updates disabled and a private leader socket. This exercises native authentication without sending a model prompt. Concurrent refreshes coalesce; an account-side file lock serializes native refresh workers. The native CLI owns OAuth, its own interaction with other native CLI processes, and persistence of rotated credentials. The integration does not implement a separate OAuth client or overwrite the native account file.

Each agent receives an atomic access-only snapshot in its existing isolated `GROK_HOME`. Long-running agents keep that snapshot current; refresh credentials never enter the conversation, model prompt or catalog. Account identities are pinned for managed native sessions. Authentication and session-opening failures can recover once before dispatch. A dispatched prompt is never replayed automatically. Failed refresh attempts use a short cooldown; network failures remain connection failures, and rejected refresh grants require a new login.

Managed renewal requires a single identified account entry in the native file. Use separate homes/services for distinct accounts. Existing installations can retain operator-managed read-only snapshots by omitting `credentialSocket`. For a host service, run `bun src/server/harness/auth/main.ts` with explicit absolute `PANDA_FORCE_GROK_AUTH_HOME`, `PANDA_FORCE_GROK_AUTH_COMMAND` and `PANDA_FORCE_GROK_AUTH_SOCKET` paths. Point the installed profile's `credentialSocket` at the private socket visible to the application; the default Grok profile also accepts `PANDA_FORCE_GROK_AUTH_SOCKET`. Socket directories must be owner-only and clients must run as that owner.

The optional `panda-force-grok-auth@.service` template runs as the named existing Unix account. Bundle `src/server/harness/auth/main.ts` with `bun build --target=bun --outfile=/opt/panda-force/grok-auth/broker.js`, configure the three paths and the Bun/CLI executable `PATH` in `/etc/panda-force/grok-auth-<user>.env`, and use `/run/panda-force-grok-auth-<user>/broker.sock`. Install and enable the template explicitly; application startup never installs host services. A container client needs only a read-only bind of that private socket directory, with a matching Unix owner. Keep the runtime directory across service stops/restarts so an existing container bind continues to see the new socket. Preserve a previous bundle/configuration for rollback, and do not restore an old refresh token after native rotation.
