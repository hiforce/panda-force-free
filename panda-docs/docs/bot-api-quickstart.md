---
title: Bot API quickstart
---

# Create a Bot and integrate its tasks

This guide targets **PandaForce 0.2.2**. It uses fictional product data and no external callback. Run examples from the repository root in Bash with `curl` and `jq` installed, against your own installation. Use HTTPS for remote access.

## 1. Create and configure

The easiest route is **Settings → Bot settings**: create `catalog-panda`, choose its Harness Runtime, model and reasoning level, set an avatar/personality and issue an expiring key scoped to that Bot. The [English Bot definition](https://github.com/hiforce/panda-force-free/blob/main/examples/bots/quickstart/bot.json) and [Chinese definition](https://github.com/hiforce/panda-force-free/blob/main/examples/bots/quickstart/bot.zh-CN.json) are also valid management API request bodies.

For automation, sign in with a configured local account, keep its cookie in a temporary file, then create the Bot and issue a key:

```bash
export PANDA_URL="http://localhost:8899"
PANDA_COOKIE_JAR=$(mktemp)
chmod 600 "$PANDA_COOKIE_JAR"
trap 'rm -f "$PANDA_COOKIE_JAR"' EXIT
read -r -p "PandaForce username: " PANDA_USERNAME
read -r -s -p "PandaForce password: " PANDA_PASSWORD
printf '\n'

jq -n --arg username "$PANDA_USERNAME" --arg password "$PANDA_PASSWORD" \
  '{username:$username,password:$password}' | \
  curl --fail-with-body --silent --show-error \
    "$PANDA_URL/api/auth/login" \
    -H "Origin: $PANDA_URL" -H "Content-Type: application/json" \
    --cookie-jar "$PANDA_COOKIE_JAR" --data-binary @-
unset PANDA_PASSWORD

BOT_ID=$(curl --fail-with-body --silent --show-error \
  "$PANDA_URL/api/bots" \
  --cookie "$PANDA_COOKIE_JAR" \
  -H "Origin: $PANDA_URL" -H "Content-Type: application/json" \
  --data-binary @examples/bots/quickstart/bot.json | jq -er '.bot.id')

jq -n --arg id "$BOT_ID" \
  '{name:"Catalog integration",botIds:[$id],days:30}' | \
  curl --fail-with-body --silent --show-error \
    "$PANDA_URL/api/bots/keys" \
    --cookie "$PANDA_COOKIE_JAR" \
    -H "Origin: $PANDA_URL" -H "Content-Type: application/json" \
    --data-binary @-
```

The final response contains `{key, secret}`. Copy `secret` into your backend's secret manager; it is shown only once. Do not put it in client code, logs or Git. The key grants task access only to the selected `botIds`. It is not a management credential and has no separate per-action scopes. Rotate/revoke keys from the management UI.

Creation returns `{bot}` and `201`. Bot codes are stable and unique per owner: lowercase letters, digits, `_` and `-`, beginning with a letter, 2–64 characters. Reusing a code conflicts. Edit using `PATCH /api/bots/:id`; for example `{"active":false}` pauses queue execution and `{"active":true}` resumes it. The model field is optional and defaults to the engine configuration. A Bot may be created with an avatar and `persona` (`role`, `traits`, `voice`, `motto`).

`POST /api/bots` creates a Bot; `GET /api/bots/catalog` lists configurations without loading the task history. The HTTP method distinguishes creation from reads; `create` is a description, not part of the URL. `GET /api/bots` remains available and returns Bots, tasks and key metadata.

| Management operation                     | Request                                           |
| ---------------------------------------- | ------------------------------------------------- |
| List Bot configurations and key metadata | `GET /api/bots/catalog`                           |
| Create a Bot                             | `POST /api/bots` with `bot.json`                  |
| Edit a Bot                               | `PATCH /api/bots/:id`                             |
| Issue a key                              | `POST /api/bots/keys` with `{name, botIds, days}` |
| Revoke a key                             | `DELETE /api/bots/keys/:keyId`                    |
| Inspect this Bot's queue                 | `GET /api/bots/queue?bot=:botId`                  |

These management endpoints require a signed-in application session; mutations also validate the request Origin. This local-password bootstrap is not an OAuth/client-credentials flow. Installations using another identity provider should use their configured login flow rather than treating a Bot key as an administrator key.

## 2. Submit

Set `BOT_KEY` from the issued secret. The sample [task.json](https://github.com/hiforce/panda-force-free/blob/main/examples/bots/quickstart/task.json) declares a `draft_ready` business result without a callback, so no external service is invoked.

```bash
export BOT_CODE="catalog-panda"
TASK_ID=$(curl --fail-with-body --silent --show-error \
  "$PANDA_URL/api/v1/bots/$BOT_CODE/tasks" \
  -H "Authorization: Bearer $BOT_KEY" \
  -H "Idempotency-Key: ITEM-001-v1" \
  -H "Content-Type: application/json" \
  --data-binary @examples/bots/quickstart/task.json | jq -er '.task.id')
```

A new task returns `202` and `{task, duplicate:false}`. The same Bot, idempotency key and unchanged payload return the same task with `200` and `duplicate:true`; changing the payload under that idempotency key returns `409`. The key is an application-defined `Idempotency-Key`, not the bearer secret. Persist `task.id` before further work. Retrying an ambiguous submission must reuse the same idempotency key. A new intentional attempt uses a new key.

The input accepts required text and up to two HTTPS image URLs. The API does not accept a ZIP upload. Supply verified facts and the desired action conditions. `externalTaskId` is your business reference; the returned `task.id` identifies the Panda task.

## 3. Query and use the result

```bash
curl --fail-with-body --silent --show-error \
  "$PANDA_URL/api/v1/bots/$BOT_CODE/tasks/$TASK_ID" \
  -H "Authorization: Bearer $BOT_KEY"
```

Inspect `task.state` for execution, `task.decision` for the business result, `task.reason` for the explanation/content and `task.callbackStatus` for result delivery. `reason` is a string, not a guaranteed structured artifact schema. Poll with a bounded interval/backoff; do not resubmit on every poll. Available states include `created`, `running`, `suspended`, `finished`, `canceled` and `error`. Human review is represented by a suspended task plus its review question/options; answer it in the management UI/API.

For this example, show the draft to a person before saving or publishing through your product system. A selected action without a callback does not perform external publication. If you later add callbacks, explicitly declare actions and permit only your destination host in the Bot configuration. See the [complete product workflow](./bot-product-publishing.md) for approvals, callbacks and receipt verification.

## 4. Cancel work that is no longer needed

```bash
curl --fail-with-body --silent --show-error \
  "$PANDA_URL/api/v1/bots/$BOT_CODE/tasks/$TASK_ID/cancel" \
  -H "Authorization: Bearer $BOT_KEY" \
  -H "Content-Type: application/json" --data '{}'
```

The body must be an empty JSON object. Cancellation returns `200` with `{task}` and `state:"canceled"`; repeating it is safe. Queued or running execution is fenced before interruption, so late model output cannot revive it. Replaying its original submission still returns the canceled task, rather than creating another one.

Completed work returns `409 invalidState`. A callback in flight or with an unknown external outcome returns `409 callbackInFlight`; reconcile the external receipt before another action. Cancellation does not undo a callback already delivered. An unauthorized/revoked/expired key returns `401`; a Bot outside the key's scope returns `403`, and a task outside its owner/Bot returns `404`.

Cancellation keeps the task record; it is not deletion. Existing task retention and manual record deletion are separate operations. Creating/configuring Bots and keys requires the management session, while submit/query/cancel use the scoped Bot key.
