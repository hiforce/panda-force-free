---
title: Package and publish manually
---

Maintainers build a tested source export and push versioned images to the selected registry. End users should pull a published image; local builds are a separate source-development path. The current public release is `hiforceai/panda-force:0.1.11` for Linux amd64. Application builds reuse the matched, digest-pinned public Rocky creative build/runtime bases. Verify a release digest after pushing and test a pristine container before announcing it.

```bash
PANDA_FORCE_IMAGE=hiforceai/panda-force:VERSION
export PANDA_FORCE_IMAGE
docker build -t "$PANDA_FORCE_IMAGE" .
docker push "$PANDA_FORCE_IMAGE"
```

Replace the example with your actual authenticated registry and reviewed version. Authenticate using your own registry tooling. Keep credentials outside source and build context. This command is a manual example, not evidence of a published image.

Users can set `PANDA_FORCE_IMAGE` to that exact tag and run:

```bash
docker compose pull panda-force
docker compose up -d --no-build
docker compose logs panda-force
```

Review source, dependency licenses, English comments and the explicit public inventory before exporting. Verify the final clean tree, then review staged files. No internal Git history, old help, design records or agent directories belong in the public snapshot. Release changes go to the private repository for review first.

## Maintainer source snapshots

Keep the previous clean export and its `SNAPSHOT.json` outside the working checkout. Its file hashes identify that baseline; public Git records later community edits.

For a new version or selected patch, test the reviewed result in the private development repository. Update the approved public file list only after checking ownership and license eligibility. Export the committed tree, then generate a full-index patch between the old and new clean exports.

```bash
bun scripts/release/prepare-update.mjs \
  --base /absolute/path/to/previous-export \
  --next /absolute/path/to/new-export \
  --out /absolute/path/to/update.patch \
  --repo /absolute/path/to/public-checkout --apply
```

Three-way application preserves independent public changes and stops on conflicts. The tool neither commits nor pushes. Do not merge private Git branches into the public repository. New commercial material in an existing filename still needs explicit review; a path whitelist cannot make that licensing decision.

## 0.2.1

The 0.2.1 source is available on the `develop` branch. Follow the [source build guide](building.md) to run it.

- Project memory can retain and recall authorized information across project conversations. Private conversations can use existing project memories when recall is enabled. Their messages do not become memory sources.
- Managed conversations keep a single history when switching Harness runtimes. Each supported runtime can resume its own saved session.
- Project creation categories use a common navigation layout. The mobile layout gives document and media content the full width.

## 0.1.11

Use Git tag `v0.1.11` and `hiforceai/panda-force:0.1.11` on Linux amd64. [Install](installation.md) or [upgrade](updates.md).

- Enabled Harness runtimes are available to Bots by default. In Settings → Harness Runtimes, turn off Bot access for an individual runtime to keep it out of the Bot picker.
- Bot chat resolves the runtime and model from the same catalog used by Bot settings. If the selection becomes unavailable, the message stays in the composer so you can choose another runtime and retry.
- Configured ZCode, Claude Code and Antigravity runtimes can handle Bot chat and tasks. Use the [Harness setup guide](harness-runtimes.md) for the required CLI and account connection.
- Creation skills use full-width covers with a compact add button next to the title.
- The creations library has category lists and thumbnail cards for images, slides and videos, with an in-page viewer for saved PowerPoint files.
- Creation uses the selected runtime to save native outputs. You can send additional instructions while a creation is active, and the composer clears skills that were already submitted.

## 0.1.8

Use Git tag `v0.1.8` and `hiforceai/panda-force:0.1.8` on Linux amd64. [Install](installation.md) or [upgrade](updates.md).

- Assistant management fits the title, task counts, search and actions into one row on wide screens. Search stays next to the actions on mobile.
- The project directory brings creation, search and view controls into a compact toolbar and wraps the secondary controls on narrow screens.
- Skills use a compact toolbar and the shared loading indicator when opening the page or fetching the catalog. Retry keeps your query.

## 0.1.7

Use Git tag `v0.1.7` and `hiforceai/panda-force:0.1.7` on Linux amd64. [Install](installation.md) or [upgrade](updates.md).

- The session workspace shows the project, model, status and last activity in compact rows. The main list and project session lists show 30 rows per page. Search can find older conversations.
- The sidebar groups conversations by working folder. Each expanded folder shows its subfolders first, followed by the conversations stored directly in that folder.
- Administrators can set additional folder-tree roots. Restricted installations start the tree at their configured working folder. See [session folder roots](configuration.md#session-folder-roots).

## 0.1.6

Use Git tag `v0.1.6` and `hiforceai/panda-force:0.1.6` on Linux amd64. [Install](installation.md) or [upgrade](updates.md).

- The creation home uses a compact composer and larger skill covers. Select a cover or title to read the full description. Open creation history from the header to search and return to earlier work.
- Switching between creation and conversations refreshes the engine controls and transcript for the destination and preserves unsent drafts.
- The optional Antigravity ACP runtime offers automatic tool approval for the next turn. New sessions ask for approval by default. See the [Antigravity setup](harness-runtimes.md#antigravity-cli).

## 0.1.10

Use Git tag `v0.1.10` and `hiforceai/panda-force:0.1.10` on Linux amd64. [Install](installation.md) or [upgrade](updates.md).

- Open and confirm Full access from the settings of a new Claude Code conversation. Canceling keeps the current permission, and the confirmed permission takes effect on the next message.
- Discover models and send test messages through a host runtime using the configured shared workspace.
- Update the optional Claude Code build recipe to CLI 2.1.332 with Claude Agent ACP 0.110.1. The public application image uses the operator-supplied Claude installation. [Set up Claude Code](harness-runtimes.md).

## 0.1.5

Use Git tag `v0.1.5` and `hiforceai/panda-force:0.1.5` on Linux amd64. [Install](installation.md) or [upgrade](updates.md).

- Save a runtime model in a project conversation before the first message. The first turn uses the chosen model and the composer retains the draft when settings are saved.
- Keep follow-up drafts while managed conversation runtimes are responding. Send after the turn ends or stop the turn explicitly.
- Refine the standalone SSH terminal header on small screens.
- Document [named Harness Runtimes](harness-runtimes.md), including the optional Antigravity ACP adapter and its operator-built image.

## 0.1.4

Use Git tag `v0.1.4` and `hiforceai/panda-force:0.1.4` on Linux amd64. [Install](installation.md) or [upgrade](updates.md).

- Adds the experimental ZCode conversation runtime with named profiles, streamed replies, thinking and tool activity, usage where reported, and native approvals.
- Keeps creative discussions in the same session. Questions and missing requirements can be resolved before generating another artifact.
- Adds a compact notification center with paginated history and shared notification sources.
- Adds workspace tool links and a standalone SSH terminal with password and key authentication, host fingerprint review, reconnect and font controls.
- The Rocky Linux 9 build and runtime bases now ship ZCode CLI 0.17.1 from ZCode 3.18.2, alongside Codex CLI and Grok Build. Configure your own provider to enable it.

## 0.1.3

The `v0.1.3` Git tag and `hiforceai/panda-force:0.1.3` application image identify this patch release. [Install](installation.md) or [upgrade with Compose](updates.md).

- Show a shared sending indicator inside the send button in creation, conversations and Bot chat.
- Resolve the Harness selection before the first creation request. Keep the draft and reuse the original request ID when a response is lost.
- Show model and reasoning settings in creation. The service manages execution permissions for creation tasks.

## 0.1.2

The immutable `v0.1.2` tag and `hiforceai/panda-force:0.1.2` application image identify this release. Branches may receive later documentation or development updates; use the version tag for the exact release source. Both Codex CLI and Grok Build are included; the optional Compose account service provides native Grok credential renewal. [Install and select Harness Runtimes](harness-runtimes.md).

- Keep active creation runs alive through activity-based budgets, while retaining inactivity, cancellation, disconnect and user-question handling.
- Persist completion notifications atomically with saved artifacts; the inbox opens the authorized document or exact asset version and retains read state.
- Add maintained Rocky Linux creative build/runtime recipes, dependency profiles and locks for slides, images, research, writing, web and video. Document the [contents, purpose and self-build workflow](base-images.md); the matching public Rocky pair is now the default.
- Renew Grok credentials through an account-owned broker and preserve portable account directories and socket mounts across runtime sessions.
- Compact project context in the session inspector and remove the Files/Changes/Terminal shortcut block from its overview.
- Align README, installation/upgrade instructions, Compose application/account helpers and all Kubernetes application/init roles at 0.1.2; verify a clean install and upgrade without replacing account/data volumes.
- Align the application and community source version at 0.1.2. The project uses `bun.lock`; no root `package-lock.json` is generated.

## 0.1.1

- Add the shared camera, photo, file, installed-skill and project-document picker to Bot conversations. Project documents attach a copy of the selected saved version under the existing read permissions.
- Keep generated documents in the Bot conversation with preview, Markdown source, copy and download controls; they are not automatically archived to projects. Place the short delivery caption beneath the skill title using the shared row style.
- Preserve Bot input drafts across navigation and uncertain send receipts. Bind selected materials and skill guidance to the owner, conversation generation and execution lease; older text-only conversations receive the material toolset safely.
- Decode URI-encoded Chinese image paths through the existing local-file authorization checks. Local image previews offer an explicit original-image download that preserves the filename and bytes.
- Retain the existing digest-pinned dependency bases and complete self-build instructions. Docker/Compose and Kubernetes installation examples now select 0.1.1. Unchanged installation, database and base-build behavior reuses the completed 0.1.0 verification baseline.

## 0.1.0

- Bring the document workspace, projects, creation tasks, skills, Bot workspaces and shared UI from the reviewed develop source into the stable release.
- Unify material, skill and project-document selection, model/permission settings, panel typography and mobile viewport boundaries.
- Preserve draft ownership and workbench layout through menu navigation and browser history; ignore hidden input focus and superseded session reads.
- Offer SQLite or MySQL after first administrator creation. MySQL activation includes account identity, password hashes and application settings, with verified migration and restart recovery.
- Reuse the existing public dependency bases by default, and document complete local base-build and private-registry override commands.
- Package with compilation/startup checks while recording separately completed source and affected behavior verification; no fresh full-product regression is implied.

## 0.0.21

- Keep viewed image previews stable while conversation activity and history update.
- Preserve the decoded preview when reconnecting or refreshing the same session history.
- Continue loading thumbnails in the conversation and original image bytes when opening the viewer.
- Keep reserved attachment workspace instructions out of session previews and cached sidebar titles.

## 0.0.20

Composer uploads now use the selected working directory. File processing and generated deliverables use separate per-session directories under that workspace, with a stable marker to detect mismatched engine and web-service mounts. Existing attachment links and OSS storage remain compatible. This behavior is automatic; shared engines retain the existing requirement to mount workspaces at the same absolute path.

Source builds can optionally upload compiled static resources to an S3-compatible store and load them through an HTTPS CDN. Resources use content hashes, year/month paths and cross-build reuse. Storage credentials are supplied only during builds. The published default image uses local application resources and requires no CDN credentials. See [CDN configuration](cdn-build.md).

## 0.0.19

- Apply the red-flame panda identity to navigation, authentication, browser icons and the README banner.
- Refresh opaque Apple Home Screen icons, light/dark launch images and startup progress colors.
- Brand-only releases can select `VERIFICATION_PROFILE=brand`; build records identify the targeted checks and skipped suites.

## 0.0.18

- Conversation titles refresh when the engine updates a session preview through polling, including engines that do not emit a name notification.
- Native `threadName` notifications and older name notifications update the active heading and sidebar without reloading.
- Starting a session from a project page automatically selects that project and uses its managed directory, including the global New session button and the empty-project action.
- Project selection remains editable before sending. New-session navigation clears the previous active session before rendering its project controls.

## 0.0.17

- New conversations activate their session route before the inspector refreshes, so live usage appears without reloading.
- Configured provider models remain selectable, including custom catalogs.
- The model-provider guide covers Codex CLI setup for 智谱 GLM, Ollama and DeepSeek, with container configuration and troubleshooting.

## 0.0.16

- Paused goals appear when opening or reconnecting to a session, with explicit Resume goal controls in the status area and goal details.
- Resuming keeps the same goal, objective, budget and unsent message. Failed requests can be retried, and delayed responses cannot overwrite another session.
- Native goal changes outside a running turn are accepted at the engine adapter boundary; newer notifications take precedence over an older status read.
- The required browser checks cover desktop Chromium and mobile WebKit.

## 0.0.15

- Home Screen installation includes dedicated opaque PandaForce icons, light/dark iPhone launch images, a standalone web app manifest and immediate startup feedback before JavaScript, localization and authentication finish. Authentication and language loading run concurrently.

- New projects own persistent folders named by their code. New project sessions use the server-bound folder; linking historical sessions preserves their original directories.
- Configure `PANDA_FORCE_PROJECTS_ROOT` for Docker, Compose or Kubernetes. Shared host engines need the same absolute persistent path in both environments.
- `PANDA_FORCE_ALLOW_EXTERNAL_DIRECTORIES` defaults to `true`. Setting `false` limits web directory and session browsing, filters external history and notifications, and isolates browser caches. This visibility setting is separate from engine permissions.
- Project creation is retryable without creating duplicates. Existing unknown folders and symbolic links are preserved; bound project codes remain fixed while names and descriptions stay editable.
- File mention search remains available before the first project folder is created.
- Working-folder controls use the available row width on phones instead of truncating short names. Loaded conversation images retain their decoded nodes across live updates and history resynchronization.

## 0.0.3

Host-connected sessions now preserve asynchronous question tools as interactive cards. Choose an option or enter a custom answer, select **Add answer to message**, then send the message. Answer preparation preserves existing drafts; later replies collapse previous questionnaires into history.

## 0.0.4

Question cards now send answers directly when you select **Submit answer**. Selecting an option alone does not send anything. Existing composer drafts and attachments stay untouched. Failed submissions can be retried; unconfirmed delivery is shown separately to avoid duplicate sends.

Shared sessions now subscribe to live events and approval requests even when history uses native pagination. Metadata-only rejoin is limited to already loaded threads, preserving their permissions and avoiding a full-history response.

## 0.0.5

Approval actions appear together in one row: allow once, allow similar commands (or this conversation when supported), then deny. Buttons share their available width and touch-target height. Deny uses danger styling in Light and Dark themes.

Session status now follows native activity and the newest turn, including a turn with no visible items yet. Older completion events cannot mark a newer task complete. Status-only history updates refresh both the conversation and sidebar, and live thread status updates invalidate cached activity metadata.

## 0.0.6

- Rejected HTTP and WebSocket requests keep the normal PandaForce sign-in flow without triggering the browser's native Basic authentication dialog. Existing valid sessions remain usable after reconnecting.

The frontend is organized into bounded feature modules with explicit service interfaces. Domain state has scoped read and write capabilities, and view updates use a closed projection channel. Conversation state stays independent of its rendered DOM.

Folder browsing preserves the latest request and typed path. Session renames update the conversation and sidebar together. Explicit project visibility persists independently of working folders. Dark-theme denial actions have clearer contrast, and the composer fits the keyboard viewport in mobile landscape mode.

Maintainers can run `bun run verify` for build checks, unit and integration tests, and the isolated browser suite. Results include per-suite logs, timeouts, and explicit exclusions for live-service diagnostics.

Sending remains reliable when background updates arrive during a pointer press, and hovered send controls keep readable colors. Answered asynchronous questions restore as collapsed history after a refresh or session switch.

## 0.0.7

The interface now uses shared language negotiation and message catalogs across
sign-in pages and the workspace. Choose English or Simplified Chinese in
**Settings → Appearance → Language**. Unset preferences follow the order of your
browser languages, with English as the final fallback. Language packs load on
demand, and supported languages are validated for matching keys and ICU parameters.

Changing language preserves composer drafts, focus, text selection, attachments,
and pending question choices. Native CLI responses, visible reasoning summaries,
commands, logs, diagnostics, question text, options, filenames, and project names
keep their original text.

PandaForce confirmation dialogs now handle session deletion and model-account
sign-out. Notification permission is requested only after an explicit action.
Approvals and questionnaires retain their existing single-submission behavior.

Maintainers can validate message IDs, required arguments, catalogs, generated
indexes, and parameter types with `bun run check:i18n`. The release retains the
shared verification entry point and adds coverage for language negotiation,
plugin resource isolation, native-content preservation, and Git-status tooltips.

## 0.0.8

Mobile navigation keeps labels readable. Permissions and model settings use compact
icon buttons with popovers beside the queue and send controls; desktop keeps the
full dropdowns. The composer remains accessible with the software keyboard open.

Pending asynchronous questionnaires remain interactive when older messages are
loaded or reconciled. Touch selection and **Submit answer** work directly without
sending the composer draft. Command approvals retain separate allow-once, scoped
allow, and danger-styled deny actions; choosing an answer does not grant execution
permission.

Existing-session preparation and input share one browser request, removing an
extra browser round trip. Loaded sessions avoid an unnecessary full resume.
Conversation history continues to use native pagination and bounded questionnaire
supplementation. An uncertain send acknowledgment is never automatically replayed.

Unassigned conversations show the ten most recent sessions and support folder
browsing. Project session association supports search and folder filtering.

Maintainer checks now enforce TypeScript contracts, dependency boundaries, scoped
state access, linting, formatting and sanitized message rendering. The image build
runs the complete verification plan and records its source identity in
`/app/verification.json`. Development tools remain outside the runtime image.

The conversation-engine boundary separates native events, capabilities and approval
decisions from application code. Codex remains the registered engine; this release
does not add a Claude or Spark CLI adapter. An [optional gateway cluster](./cluster.md)
adds authenticated owner routing, event replay and durable command identities.
Default single-instance installations continue to use SQLite without PostgreSQL.

## 0.0.9

The session workspace now keeps usage, execution status, project context, model and
permission settings, and tools in a dedicated side panel. The conversation and
composer share one centered reading column as panels open or close. On phones,
compact controls and bottom sheets leave more room for the conversation.

Model, permission, usage and tool dialogs are centered on desktop, with visible
headers and action bars when their content scrolls. Session usage is restored from
native history after opening or refreshing a conversation, then updated by live
reports. Missing values remain explicitly unavailable.

The sidebar uses consistent typography and distinct connection and settings icons.
**Recent** shows the latest ten unassigned sessions; **Folders** expands working
folders in place, with readable paths, counts and keyboard navigation. Background
list updates preserve an open session menu and its focus.

Workspace preparation now displays the bundled Panda logo and a themed brand
banner above the real loading steps. The logo loads before sign-in and supports
small screens, Light and Dark themes. The build verifies all 76 required steps,
including 68 isolated browser suites.

## 0.0.10

Global language, appearance, reading width, focus mode and browser full screen now
live in the top navigation. Session titles stay with the conversation. Comfortable,
Wide and Fill layouts align the title, messages and composer between the side panels;
phones use compact preference buttons and bottom sheets.

Light, Graphite, Silk and Aurora appearances share the same preference with Settings.
Changing appearance, language or layout preserves drafts and focus. Language follows
the browser until explicitly selected, with English as fallback; native engine output
keeps its original wording.

Mobile home height recovers after keyboard, page activation and orientation changes.
Upgraded pages replace incomplete shared translation catalogs, use a versioned locale
module and retain live translation bindings, preventing raw translation keys in menus.

Submitting a new message returns to the latest conversation content. Delayed image,
font and layout growth continues to follow the bottom; scrolling up to read history
pauses that behavior. Answered questionnaires are reconciled with native history so
completed questions do not remain as pending requests.

The image build runs all 80 required checks, including 72 isolated browser suites.
Runtime containers exclude development dependencies. Images are published for Linux
amd64 and retain the existing persistent-volume layout.

## 0.0.11

Loading earlier messages now immediately shows a spinner and translated status text.
The feedback covers both network requests and expanding cached messages. Duplicate
requests are blocked while loading; background refreshes retain the busy state, and
a failed request can be retried. Reduced-motion preferences stop the animation while
keeping the status text visible.

Reading older messages keeps the same visible paragraph when conversation snapshots,
older pages or delayed images arrive. If you scroll while a history request is pending,
your current reading position is retained. At the bottom, new content continues to
scroll into view.

The Panda logo and wordmark are vertically aligned in desktop and mobile navigation.
The release also retains the versioned English workspace screenshot in the README.

The image build requires all 80 verification steps. Focused Chromium and WebKit
regressions cover history feedback, retries, cached expansion and reading position.
Images remain available for Linux amd64, with the same persistent-volume layout.

## 0.0.12

Conversation rendering now uses explicit, typed renderers for text, images, questions
and tool activity. New bundled controls have a shared update and disposal contract;
streaming text and history use the same rendering path. Gesture detection, reading
anchors and scroll ownership are separate from message presentation.

Mobile reading remains stable through small upward movements, touch momentum and
background history refreshes. Returning to the bottom resumes following new output.
Full history updates wait for an active gesture to settle, including when streamed
content replaces the original touch target.

Questionnaire selections, text, focus and in-flight submissions survive background
refreshes. Approval controls retain their request state across redraws. Completed
activity no longer leaves a stale processing indicator below the conversation.

Loading earlier messages stays busy until both the request and the visible history
update complete, preventing duplicate page loads while a touch gesture is active.

The image build runs all 80 required verification steps. Focused Chromium and WebKit
checks cover reading position, touch gestures, questionnaires and paged history.
Images remain available for Linux amd64, with unchanged persistent-volume paths.
