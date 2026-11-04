---
title: Troubleshooting
---

| Symptom | First checks |
| --- | --- |
| Disconnected or preparation stuck | Inspect the pending preparation step and server logs; confirm engine mode and native CLI availability. |
| Model cannot run | Check native model sign-in independently of PandaForce login. |
| Setup rejected | Check username/password requirements and installation code, without deleting model state. |
| Paste does nothing | Focus the composer and confirm the clipboard contains image data; distinguish detection, upload and submission failures. |
| Terminal cannot start | Rebuild node-pty for the actual Node version. |
| Container cannot write state | Verify volume ownership for UID/GID 1000 or the configured user. |
| Shared mode fails | Check socket permissions, matching user identity and identical host/container paths. |

Include exact OS, browser, Bun, Node and CLI versions, reproduction steps and redacted errors in reports. Avoid resubmitting a command merely because its progress display stopped updating.

## Background sign-in verification

Version 0.0.2 checks browser sign-in in the background every five minutes while the page is visible and online. Hidden/offline pages pause checks. Returning to the page rechecks when the previous successful check is at least one minute old; rapid tab switching does not generate duplicate checks. Protected API requests that return 401 still trigger an immediate status check.

A single timeout or temporary failure stays quiet and retries with backoff. An unavailable notice appears only after repeated failures spanning at least fifteen seconds; it disappears after recovery. Confirmed expiry still prompts sign-in immediately, preserving the page and draft.

IDAAS token-introspection results are cached for up to five minutes, never beyond the token expiry. Local logout and known expiry remain immediate; remote revocation can take up to five minutes to propagate. No protected access is granted on an unsuccessful required revalidation.

Slow or failed IDAAS calls emit `auth/provider-request` with operation, duration, HTTP status and outcome. Slow or failed status handling emits `auth/status-request`. These records omit tokens, cookies, client secrets, query strings and provider error bodies. Gateway request duration measures the whole HTTP request and must not be treated as the duration of an IDAAS request or a Codex socket call.

## Message contrast and theme preferences

Version 0.0.2 restores white workspace backgrounds in Light mode and neutral gray surfaces in Dark mode. User-message backgrounds, text and borders follow the selected application theme, including when it differs from the operating-system theme. Reload after upgrading to fetch the matching styles.
