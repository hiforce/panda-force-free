---
title: Configure PandaForce
---

PandaForce settings use the `PANDA_FORCE_` prefix. Legacy environment settings remain accepted for migration. The PandaForce setting wins when both names are supplied, including an explicitly empty value. Image fallback defaults are considered only after explicit new or legacy runtime settings, so an image default cannot hide a deployed setting. All current examples use the PandaForce names. Native engine settings such as `CODEX_HOME` belong to that engine, not to PandaForce branding.

| Variable                                                 | Purpose                                                                                            |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `HOST`, `PORT`                                           | Bind address and port; defaults are localhost and 8899.                                            |
| `PANDA_FORCE_BIND_IP`, `PANDA_FORCE_PORT`                | Compose host binding; legacy aliases remain accepted.                                              |
| `PANDA_FORCE_HOME`                                       | Private application state root.                                                                    |
| `PANDA_FORCE_CWD`                                        | Default working folder.                                                                            |
| `PANDA_FORCE_PROJECTS_ROOT`                              | Persistent root for new project folders named by project code.                                     |
| `PANDA_FORCE_ALLOW_EXTERNAL_DIRECTORIES`                 | `true` by default. Set `false` to restrict web directory and session browsing to the project root. |
| `PANDA_FORCE_REVIEW_ROOT`                                | Review boundary. Required in projectless mode.                                                     |
| `PANDA_FORCE_APP_SERVER_MODE`                            | `auto`, `isolated` or `shared` native engine connection.                                           |
| `PANDA_FORCE_APP_SERVER_SOCKET`                          | Explicit shared-engine socket.                                                                     |
| `PANDA_FORCE_AUTH_MODE`                                  | Optional authentication mode; default setup creates an administrator.                              |
| `PANDA_FORCE_ATTACHMENT_STORAGE`                         | `local` by default; optional `oss` requires your own account.                                      |
| `PANDA_FORCE_ATTACHMENT_ROOT`                            | Private persistent attachment directory.                                                           |
| `PANDA_FORCE_LOG_DIR`                                    | Log directory override.                                                                            |
| `PANDA_FORCE_LOG_MAX_BYTES`, `PANDA_FORCE_LOG_MAX_FILES` | Rolling limits; defaults 10 MiB and ten segments.                                                  |

```bash
PANDA_FORCE_CWD=/absolute/path/to/workspace bun run start
```

Use Bun to install dependencies so the tracked compatibility patch is applied. Supply secrets privately at runtime, never in committed environment files or client bundles.

## Interface language

Choose **Language** in the top navigation, or **Workspace preferences → Language**
on a phone, to use English, Simplified Chinese,
or the browser preference. If you have not selected a language, PandaForce follows
the order of your browser languages and falls back to English. The choice persists
across visits and also applies to sign-in pages. The same preference is available
under **Settings → Appearance → Language**.

Language changes affect PandaForce controls. Native CLI responses, commands,
logs, questions, filenames, project names, and your draft retain their original
text. Additional language packs are published after translation and review.

## Third-party model providers

See [Model providers](model-providers.md) for Codex CLI configuration with Zhipu GLM, Ollama and DeepSeek, including Docker environment variables and model catalogs.

## Local members and email

The first administrator chooses a username and password. An email address is optional at installation.
Configure **Settings → Members and email → Email delivery (SMTP)** before binding an administrator email or inviting members. TLS or STARTTLS is required. Supply your own SMTP account, sender address and the public HTTPS application address. Credentials are encrypted with a private persistent application key; a successful connection test confirms SMTP authentication, not inbox delivery.

Invite a member by email and role. Administrators never choose member passwords: recipients use a single-use, 24-hour email link to set their own password. The sign-in page offers password recovery after SMTP is configured. Administrator email binding requires confirmation from the recipient. Password recovery revokes old passwords and browser sessions only when the new password is successfully committed.

Explicit administrators can use the shared host workspace, terminal and native sessions. Ordinary members can only use their authorized business content. Model API keys and native model login remain independent from application accounts.

Back up the complete application configuration, `data/users.sqlite` (or the MySQL identity tables), and `config/local-users.key`. Keep the encryption key private and persistent. A backup of `administrator.json` alone does not include later password recovery or email settings.

Dedicated IDaaS login is no longer provided by new versions. Existing IDaaS installations must complete an operator-controlled local-account migration before upgrading; unsupported authentication modes fail startup instead of silently exposing the application. No third-party directory or organization service is required.
