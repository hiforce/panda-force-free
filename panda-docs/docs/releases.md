---
title: Package and publish manually
---

Maintainers build a tested source export and push versioned images to the selected registry. End users should pull a published image; local builds are a separate source-development path. The current public release is `hiforceai/panda-force:0.0.6`. Verify a release digest after pushing and test a pristine container before announcing it.

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
