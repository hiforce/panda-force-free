---
title: Troubleshooting
---

| Symptom                           | First checks                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Disconnected or preparation stuck | Inspect the pending preparation step and server logs; confirm engine mode and native CLI availability.                   |
| Model cannot run                  | Check native model sign-in independently of PandaForce login.                                                            |
| Setup rejected                    | Check username/password requirements and installation code, without deleting model state.                                |
| Paste does nothing                | Focus the composer and confirm the clipboard contains image data; distinguish detection, upload and submission failures. |
| Terminal cannot start             | Rebuild node-pty for the actual Node version.                                                                            |
| Container cannot write state      | Verify volume ownership for UID/GID 1000 or the configured user.                                                         |
| Shared mode fails                 | Check socket permissions, matching user identity and identical host/container paths.                                     |

Include exact OS, browser, Bun, Node and CLI versions, reproduction steps and redacted errors in reports. Avoid resubmitting a command merely because its progress display stopped updating.

## Background sign-in verification

Version 0.0.2 checks browser sign-in in the background every five minutes while the page is visible and online. Hidden/offline pages pause checks. Returning to the page rechecks when the previous successful check is at least one minute old; rapid tab switching does not generate duplicate checks. Protected API requests that return 401 still trigger an immediate status check.

A single timeout or temporary failure stays quiet and retries with backoff. An unavailable notice appears only after repeated failures spanning at least fifteen seconds; it disappears after recovery. Confirmed expiry still prompts sign-in immediately, preserving the page and draft.

Local account disablement, role changes and password changes invalidate old browser credentials. Shared native connections are closed after credential revalidation; logout revocation is persistent. A request to send a password reset email does not itself revoke an existing session.

If invitation or reset mail does not arrive, check SMTP configuration, the displayed delivery state, spam filtering and the sender's delivery logs. SMTP acceptance does not prove inbox delivery. Resending an invitation invalidates its previous link. Do not delete application state or model-provider credentials to repair email delivery.

## Message contrast and theme preferences

Version 0.0.2 restores white workspace backgrounds in Light mode and neutral gray surfaces in Dark mode. User-message backgrounds, text and borders follow the selected application theme, including when it differs from the operating-system theme. Reload after upgrading to fetch the matching styles.
