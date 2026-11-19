---
title: Bot task deletion and idempotency
---

# Delete tasks and handle business revocation

Use the Bot task list's **Bulk delete** action to select tasks across pages or delete all tasks matching the current search, Bot and status filters. Check the confirmation count before deleting. A filtered operation takes a snapshot and supports up to 10,000 tasks, sent in batches of at most 500.

Queued tasks are removed from execution. Running inference is interrupted and its lease invalidated. Tasks with callbacks already in flight or an unknown callback result remain available for reconciliation and are reported as blocked. Deletion cannot undo an external action that has already happened.

## Backend deletion API

Use the same API key as task submission, scoped to the intended Bot:

```http
POST /api/v1/bots/BOT_CODE/tasks/delete
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json

{
  "idempotencyKeys": ["business-task:INSTANCE_ID"]
}
```

Supply the exact `Idempotency-Key` used to submit each task. The array must contain 1–500 unique, nonempty keys, each at most 256 characters. The operation is restricted to the key's owner and permitted Bot. It does not search task titles or business descriptions.

Example response:

```json
{
  "requested": 1,
  "deleted": 1,
  "alreadyDeleted": 0,
  "blocked": [],
  "interrupted": []
}
```

HTTP 200 can include blocked items. Treat delivery as complete only when `blocked` is empty and `deleted + alreadyDeleted == requested`. A blocked item identifies its submission key and a code such as `callbackInFlight`. Retrying an identical request is safe, including after a lost response.

A deletion arriving before submission creates a hidden deduplication marker. Reusing that submission key returns HTTP 409 (`taskDeleted`), preventing delayed delivery from recreating a revoked task. Deleted payloads and event records are removed; the small identity marker remains.

## Regenerate a business task

Use a new submission key for each actual business task instance. Keep `externalTaskId` as a business correlation reference if needed; it is not the deduplication key.

| Event             | Submission key           | Result                                            |
| ----------------- | ------------------------ | ------------------------------------------------- |
| Create instance A | `business-task:A`        | New Bot task                                      |
| Revoke A          | Delete `business-task:A` | A removed or reported blocked                     |
| Late retry of A   | `business-task:A`        | Rejected after deletion                           |
| Regenerate as B   | `business-task:B`        | New Bot task, even with the same `externalTaskId` |

Persist a revocation notification after the business backend confirms its state transition. Retry from a durable outbox; do not rely only on a browser action. Retain the original Bot destination and submission key so retries target the correct instance. Report blocked callbacks for reconciliation rather than treating an uncertain external action as successful deletion.

## Upgrade order

Upgrade Panda first, then the calling backend and its business lifecycle integration. The endpoint uses existing API keys and storage; it requires no new Panda environment variables or database migration. Existing integrations continue to submit tasks as before until they adopt the deletion API.
