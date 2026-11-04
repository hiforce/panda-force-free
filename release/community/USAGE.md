# Using PandaForce Free

## Accounts and first run

Your PandaForce administrator signs you into the browser workspace. Your Codex/model-provider account authorizes model access. They are separate. Start locally, create the administrator in the browser, and complete Codex sign-in with the CLI when required. For remote/proxied setup, use the installation code printed in your own server logs.

The preparation screen reports completed reads, not a simulated timer. If a read fails, retry it or reload. Once the interface itself is ready you may explicitly continue while remaining reads complete. A failure to load the interface cannot be bypassed into a working workspace.

## Projects, sessions and working folders

Create a project using its name and unique code, with an optional description. Add native sessions to it or associate historical sessions. Moving/unlinking a session changes PandaForce metadata; it does not move its working folder or rewrite its native history.

Choose a working folder independently. The same folder may be used by sessions in different projects. Review the selected project and folder before submitting a new session. Drafts are scoped by project/folder for new sessions and by native ID for existing sessions.

## Messages and attachments

Type a message, select files or paste a clipboard image into the composer. Wait for uploads to become ready before sending. Limits are 10 files and 25 MiB per file. Supplied filenames are preserved; browsers sometimes provide a generic clipboard filename instead of the original. Failed uploads remain visible; remove/retry the attachment after fixing the underlying error.

The default attachment storage is local. Optional object storage requires your own credentials. Source images and model input remain separate from reduced-size activity thumbnails. Image/provider compatibility depends on the native engine and account.

## Approvals and questions

Native command/file requests appear in the conversation and the global pending-request inbox. Read the command, folder, reason and available scope before allowing it. Choose once/session/similar-command options only when the native request actually supplies them. A failed response keeps the request available for explicit retry; the UI does not approve automatically.

Native questionnaires can show multiple questions, per-question single-choice options, permitted custom text and masked private input. Answer all required questions and submit the form. Navigation within the page preserves pending answers; a full page reload does not preserve questionnaire drafts. Do not enter secrets into ordinary questions that do not require them.

## Files, review and terminal

File browsing and previews follow the configured workspace boundaries. Review shows changes received from the native engine; Undo/Reapply currently acts on the complete aggregated diff rather than an individual hunk.

The terminal is a real shell with the application's OS privileges. It is not a safe playground for untrusted users. A working web page does not prove the native terminal module is installed correctly; rebuild node-pty for the Node version used by the worker if it cannot start.

## Troubleshooting

- Connection unavailable: confirm the CLI is installed, the model account is ready and the selected isolated/shared mode is correct. Shared mode additionally needs a live socket, matching user access and identical paths.
- Login/setup fails: distinguish PandaForce credentials from model credentials. Inspect private service logs; do not reset model state to repair a browser password.
- Slow startup: inspect which real preparation step is pending. Use local metadata and logs before resuming very large native histories repeatedly.
- Clipboard does nothing: keep focus in the input, confirm the browser actually copied image data, and distinguish no detected attachment from a failed upload or a model submission error.
- Docker cannot write state: verify volume ownership for the configured UID/GID. Do not solve it by exposing all host directories or deleting state.
- Model/CLI behavior differs: record the exact CLI version and the minimal disposable reproduction. Native protocol availability can change between versions.

For help requests, provide OS, Bun/Node/CLI/browser versions, relevant steps, redacted errors and screenshots. Maintenance is best effort without response or fix deadlines. See [SECURITY.md](./SECURITY.md) before sharing sensitive information.
