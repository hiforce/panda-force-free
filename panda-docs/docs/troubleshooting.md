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
