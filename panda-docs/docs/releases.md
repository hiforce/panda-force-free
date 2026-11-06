---
title: Package and publish manually
---

Maintainers build a tested source export and push versioned images to the selected registry. End users should pull a published image; local builds are a separate source-development path. The current public release is `hiforceai/panda-force:0.0.9`. Verify a release digest after pushing and test a pristine container before announcing it.

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
