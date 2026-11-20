---
title: Bot conversations, tasks and integrations
---

# Bots: conversations, tasks and integrations

Open **Assistant** to create or manage Bots and see retained task counts. Each compact row offers **Tasks**, **Integrations** and configuration. Created Bots also appear by avatar and name below Assistant in the sidebar. Choose one to open its ongoing conversation.

Each Bot has one human conversation. Background tasks use separate context; their inputs and results do not become chat messages. **Clear conversation** removes all human messages and resets that context, including a reply in progress. Generation checks reject late replies. The Bot’s personality, tasks, channels and saved creations remain. If engine-history removal needs another attempt, the conversation displays its cleanup state and retry action. The old engine history cannot be reused for new replies.

Use the **+** button in a Bot conversation to add a camera photo, images, files, installed skills or a project document. Project documents are attached as a copy of the selected saved version after checking your read access. The original document is preserved. Uploads are private to the signed-in owner; failed uploads can be retried from the attachment card or the compact attachment manager. Wait for uploads to finish before sending.

Skills use the same picker and immutable installed versions as ordinary conversations. They guide the current message without granting project-write or external-action tools. A document produced in Bot chat stays in that conversation: preview it, view its Markdown source, copy it or download it as a `.md` file. It is not automatically archived into a project. Draft inputs and selections survive navigation between that Bot’s chat and tasks within the workspace.

The general conversation information panel starts closed. Use its top toolbar button to open it.

## Recurring research example

Create a curious research Bot, then open **Integrations → Add integration**:

1. Select **RSS / Atom** and provide the feed URL.
2. Ask for a concise digest with source links and a distinction between facts and uncertainty.
3. Choose an interval of at least five minutes, or a daily time and IANA time zone.
4. Keep **Private channel** enabled. Results default to 30 days; choose 1–365 days.
5. Save, then use **Preview source** to check the source without consuming its cursor, starting model tasks or sending anything. **Run now** uses the saved delivery settings after confirmation.

The scheduler is durable across process restarts and shared database peers. It coalesces missed slots rather than replaying a backlog of sends. Each run shows source collection, Bot processing and delivery separately. Open the Bot’s **Tasks** to review or retry model work; cancel the integration run to stop its pending work. Already dispatched network operations can still finish, and their receipts remain visible.

Source reads are bounded. Feeds accept at most 1 MB and the first 100 entries; large sources should use a narrower feed. Mail collection pages through at most 100 candidates per run, retaining its continuation. Preview indicates when a batch is limited. New feed content is deduplicated by identity and content; mailbox messages by their immutable source ID.

## Reusable connections

Connections belong to the signed-in application owner and can be reused by that owner’s Bots. Credentials are encrypted at rest and never returned to the browser. Save a connection and select **Test connection** before enabling its integrations. Editing metadata with all credential fields empty keeps the existing secret. Replacing credentials requires another account verification.

- **Slack:** create a Slack app with a Bot token and `chat:write`, install it in the intended workspace, and invite the Bot to the target channel. Add the token in **Connections**, test it, then select that connection and the channel ID in the integration’s delivery options. The app does not create or modify Slack channels.
- **Gmail:** enable the Gmail API in your Google Cloud project, create an OAuth client and authorize the intended mailbox with offline access and the `https://www.googleapis.com/auth/gmail.readonly` and `https://www.googleapis.com/auth/gmail.send` scopes. Add the client ID, client secret and refresh token in **Connections**, then verify the account. Provider authorization and any required Google app verification remain administrator responsibilities.

Disable unused connections to prevent new work. The API can remove a disabled connection only after all integration and retained delivery references are gone. Export and protect the encryption key with database backups. Docker/Compose installations retain it under the application state volume at `config/bot-connection-key`; administrators may set an absolute `PANDA_FORCE_BOT_CONNECTION_KEY_FILE`. A missing key is reported, never silently replaced when encrypted connections already exist.

## Mail drafts and controlled sending

Mailbox integrations read new inbox messages received after setup. They do not delete original messages or fetch attachments. The default produces a private reply draft; **Review and send** shows the fixed source sender and lets you edit the reply before confirming. The Bot cannot choose another recipient or mailbox. Messages from other tasks or Bots cannot substitute for the saved source.

Automatic replies are optional. Enabling or changing that policy requires explicit confirmation, an exact sender allowlist and a per-mailbox UTC daily limit (1–50). Truncated input, list/automated mail, self-mail, no-reply senders, ambiguous evidence and invalid model output do not trigger automatic replies. A shared source reservation prevents another integration from replying to the same message again. Quota reservations remain conservative after a rejected or uncertain attempt.

The application writes a dispatch record before sending. A timeout, connection loss or ambiguous provider response becomes **Outcome unknown**. It is not automatically resent. For Gmail, **Check Sent mailbox** searches the deterministic Message-ID; no match does not prove that sending failed. Slack unknown outcomes require checking the selected Slack channel. Only a delivery known to have been rejected offers a retry. Source collection and model work can continue while an older receipt needs attention.

An internal channel is private to its owner and Bot. Expired results disappear from reads and a durable cleanup pass removes retained source captures and delivery payloads. A shorter retention setting applies to old results; extending it cannot recover deleted data. Hash-only deduplication markers may remain longer (up to 365 days) to prevent repeat replies; daily counters expire after two days. Saved creations, ordinary task retention, engine history and original provider data follow their separate policies. This retention setting does not delete messages already delivered to Slack or Gmail.

## Application management API

These endpoints use the signed-in application session, owner authorization and same-origin mutation checks. They are not anonymous endpoints and do not use external Bot task keys.

| Action                                     | Endpoint                                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Bot configurations / navigation summary    | `GET /api/bots/catalog`, `GET /api/bots/navigation`                                                              |
| Compact overview / sidebar names           | `GET /api/bots/workspace`, `GET /api/bots/navigation`                                                            |
| Create / inspect / edit Bot                | `POST /api/bots`, `GET /api/bots/:botId`, `PATCH /api/bots/:botId`                                               |
| Read human conversation                    | `GET /api/bots/:botId/chat?before=sequence&since=cursor`                                                         |
| Send / clear human conversation            | `POST /api/bots/:botId/chat`, `POST /api/bots/:botId/chat/clear`                                                 |
| Retry engine-history cleanup               | `POST /api/bots/:botId/chat/cleanup/retry`                                                                       |
| List / save reusable connection            | `GET /api/bots/connections`, `POST /api/bots/connections`                                                        |
| Verify / remove unused disabled connection | `POST /api/bots/connections/:id/test`, `DELETE /api/bots/connections/:id`                                        |
| List / save Bot integrations               | `GET /api/bots/:botId/integrations`, `POST /api/bots/:botId/integrations`                                        |
| List / start runs                          | `GET`, `POST /api/bots/:botId/integrations/:id/runs`                                                             |
| Inspect / cancel run                       | `GET …/runs/:runId`, `POST …/runs/:runId/cancel`                                                                 |
| Read private channel / approve reply       | `GET …/:id/channel`, `POST …/:id/channel/:messageId/send`                                                        |
| Read receipts / recover delivery           | `GET …/:id/deliveries`, `POST …/:id/deliveries/:deliveryId/retry`, `POST …/:id/deliveries/:deliveryId/reconcile` |

Encode run/message/delivery IDs as URL path components. List responses include a `next` cursor, accepted as `before`. Human chat polling returns an opaque `cursor`; send it as `since` to avoid retransmitting unchanged history. An unchanged response is `{ "unchanged": true, "cursor": "…" }`; a changed generation requires replacing the local message set.

Upload a chat material with `POST /api/chat-materials?name=filename`, using the file bytes as `application/octet-stream`. The response includes `attachment.materialId` and an owner-protected original URL. To send it, use `{requestId, generation, text, attachments: [{materialId}], selections: []}` with `POST /api/bots/:botId/chat`. Optional `selections` contain installed `{packageId, version, digest, id, parameters}` references. The server resolves both materials and skills; client-supplied file paths, URLs, instructions or capabilities are not accepted. An identical request ID and body returns the original acceptance; changed materials or selections under that ID are rejected.

Sending human messages and clearing uses a UUID `requestId` and the current `generation`. Starting a run uses `{ "requestId": "<UUID>", "revision": 1, "preview": true }` with the current integration revision. An approved reply uses `{ "requestId": "<UUID>", "text": "Reviewed reply", "confirm": true }`. Reuse the original request ID after an uncertain HTTP response. A changed payload under the same ID is rejected. Configurations/connections use `revision: 0` for creation and the returned revision for updates; stale writes preserve the current server record.

External systems should instead use the dedicated Bot task API and scoped keys described in [Bot task API quickstart](bot-api-quickstart.md), including task lookup and cancellation. Human chat, channels and integration credentials are not accessible with those task keys.
