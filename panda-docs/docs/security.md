---
title: Security and maintenance
---

Local accounts distinguish administrators from ordinary members. Administrators can access the host workspace, terminal and shared Codex sessions; ordinary members are restricted to authorized business content. Configure SMTP before verifying an email, inviting members or enabling email password recovery. Members set their own passwords.

The administrator workspace and execution engine still share OS/model privileges. Do not grant administrator access to users who should not hold them. Directory filters and UI permissions do not isolate arbitrary code from the engine's credentials. Independent member coding sandboxes, a credential-hiding enterprise model gateway, member quotas and metered billing are not implemented. See the [feature catalog](https://github.com/hiforce/panda-force-free/blob/main/panda-docs/docs/features.md#security-boundary-and-current-limits) for the current boundary.

For remote access, use HTTPS and authentication. Initial remote/proxied setup additionally requires the installation code printed in private startup logs. Do not expose model sockets or broadly mount host directories.

Never commit credentials, agent settings, work memories, real environment files or logs. Do not publish exploitable details or private prompts in public issues. Use a private reporting route if one has been configured; otherwise request a private contact method without revealing exploit details.

Maintenance is best effort, without an SLA, security-backport schedule or response/fix deadline. A report does not commission paid work. Separately agreed personal services do not restrict the free edition's MIT rights.
