---
title: Package and publish manually
---

Maintainers build a tested source export and push versioned images to the selected registry. End users should pull a published image; local builds are a separate source-development path. The current public release is `hiforceai/panda-force:0.0.21`. Verify a release digest after pushing and test a pristine container before announcing it.

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
