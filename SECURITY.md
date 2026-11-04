# Security and operational boundaries

## Maintenance expectations

Security work is best effort. There is no SLA, guaranteed response time, scheduled backport or fix deadline. This is not a statement that maintenance has stopped, and it is not a commitment that every report will be resolved. Review the snapshot, dependencies and deployment before use.

## Reporting

Do not disclose credentials, private prompts or exploitable details in public issues. If this repository enables GitHub private vulnerability reporting, use that route. If no private route is available, do not post exploit details publicly; request a private contact method without disclosing the exploit. No support payment is required to submit a security report.

Describe affected versions, reproduction in disposable state, expected impact and possible mitigation. A report does not commission paid work or create a response/resolution promise.

## Trust model

PandaForce can read/edit workspace files, request native command execution and provide a terminal. Admit only users who should have those powers. Authenticated users share the workspace and model account; login does not isolate one user's files or shell from another user.

Local listening is the default. Use HTTPS and authentication for remote access; do not expose port 8899 directly to untrusted networks. A fresh install requires administrator setup before access to the workspace. Remote/proxied initial setup also requires the random installation code printed in private service logs. Keep the administrator database, model state, socket and backups private.

Do not grant broader host mounts or process privileges than your installation needs. Standalone Docker uses isolated mode and an unprivileged UID. Connecting to a host daemon requires deliberate matching of user identity, socket access and paths; review those choices independently.

## Data handling

Local attachment storage is the default. Bring your own provider/storage credentials if enabling optional integrations. Never commit credential files, agent metadata or real environment files, and never put credentials into a client bundle.

Back up administrator/configuration records separately from model state and workspaces. Use SQLite's online backup mechanism, or stop PandaForce and copy the full project data directory rather than an inconsistent main database file. Logs are bounded but can contain operational context; treat them as private and redact reports.

## Code safeguards and limits

Preserve the existing authentication/origin checks, browser RPC allowlist, HTML sanitization, filesystem path checks, bounded upload/image handling and exact approval IDs. These are individual safeguards, not a claim of a hardened multi-tenant sandbox or a guarantee that no vulnerability exists. Review native approval details before authorizing execution, and update dependencies when adopting later versions.
