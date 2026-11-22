---
title: Bot API 快速接入
---

# 创建 Bot 并接入任务

本文对应 **PandaForce 0.1.5**，示例采用虚构商品，不配置外部回调。在你自己的安装中操作，从仓库根目录运行 Bash 命令，需安装 `curl`、`jq`。远程接入使用 HTTPS。

## 1. 创建与配置

最直接的方式是进入 **设置 → 助理管理**：创建 `catalog-panda`，选择 Harness Runtime、Model、Reasoning Effort、头像、人格，再签发只限这个 Bot 的到期密钥。[英文 Bot 配置](https://github.com/hiforce/panda-force-free/blob/main/examples/bots/quickstart/bot.json)和[中文配置](https://github.com/hiforce/panda-force-free/blob/main/examples/bots/quickstart/bot.zh-CN.json)也可作为管理 API 请求体。

需要自动化时，使用已配置的本地账号登录，将会话 Cookie 保存在临时文件，然后创建 Bot、签发 Key：

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
  --data-binary @examples/bots/quickstart/bot.zh-CN.json | jq -er '.bot.id')

jq -n --arg id "$BOT_ID" \
  '{name:"Catalog integration",botIds:[$id],days:30}' | \
  curl --fail-with-body --silent --show-error \
    "$PANDA_URL/api/bots/keys" \
    --cookie "$PANDA_COOKIE_JAR" \
    -H "Origin: $PANDA_URL" -H "Content-Type: application/json" \
    --data-binary @-
```

最后的响应包含 `{key, secret}`。将只显示一次的 `secret` 保存到后端凭据管理中，不放进前端、日志或 Git。密钥只允许访问所选 `botIds` 的任务，不是管理凭据，也没有独立的逐动作权限范围。通过管理页面轮换或撤销密钥。

创建返回 `201` 和 `{bot}`。Bot 编号在所属账号内唯一且保持稳定：2–64 个小写字母、数字、下划线或连字符，以字母开头。重复编号会冲突。修改使用 `PATCH /api/bots/:id`；例如 `{"active":false}` 暂停队列执行，`{"active":true}` 恢复。模型可以省略，沿用引擎配置。头像和人格字段 `persona` 包含 `role`、`traits`、`voice`、`motto`。

`POST /api/bots` 创建 Bot，`GET /api/bots/catalog` 查询配置列表且不加载任务历史。创建与查询由 HTTP 方法区分，`create` 是功能说明，不是 URL 的一部分。`GET /api/bots` 仍可使用，返回 Bot、任务及密钥元数据。

| 管理操作                  | 请求                                             |
| ------------------------- | ------------------------------------------------ |
| 读取 Bot 配置与密钥元数据 | `GET /api/bots/catalog`                          |
| 创建 Bot                  | `POST /api/bots`，使用配置 JSON                  |
| 修改 Bot                  | `PATCH /api/bots/:id`                            |
| 签发 Key                  | `POST /api/bots/keys`，传 `{name, botIds, days}` |
| 撤销 Key                  | `DELETE /api/bots/keys/:keyId`                   |
| 查看该 Bot 的任务队列     | `GET /api/bots/queue?bot=:botId`                 |

管理接口要求应用登录会话，修改操作还校验请求 Origin。上述本地密码登录不是 OAuth/client-credentials 流程；使用其他身份服务的安装应沿用其登录方式，不把 Bot Key 当管理员凭据。

## 2. 提交任务

用已签发的密钥设置 `BOT_KEY`。[中文任务 JSON](https://github.com/hiforce/panda-force-free/blob/main/examples/bots/quickstart/task.zh-CN.json)声明了一个不带回调的 `draft_ready` 业务结果，不调用外部业务服务。

```bash
export BOT_CODE="catalog-panda"
TASK_ID=$(curl --fail-with-body --silent --show-error \
  "$PANDA_URL/api/v1/bots/$BOT_CODE/tasks" \
  -H "Authorization: Bearer $BOT_KEY" \
  -H "Idempotency-Key: ITEM-001-v1" \
  -H "Content-Type: application/json" \
  --data-binary @examples/bots/quickstart/task.zh-CN.json | jq -er '.task.id')
```

新任务返回 `202` 和 `{task, duplicate:false}`。相同 Bot、相同幂等标识及相同内容返回 `200`、原任务和 `duplicate:true`；同一幂等键改了内容则返回 `409`。幂等键由调用方通过 `Idempotency-Key` 提供，与 Bearer 密钥不是一回事。先保存 `task.id`，提交结果不明确时复用原幂等键重试，只有确实要重新发起一次任务才换新键。

输入必须包含正文，最多附带两个 HTTPS 图片地址，不直接上传 ZIP。提供已核实事实和业务结果的判断条件。`externalTaskId` 是你的业务引用，响应 `task.id` 是 Panda 内部任务编号。

## 3. 查询与使用结果

```bash
curl --fail-with-body --silent --show-error \
  "$PANDA_URL/api/v1/bots/$BOT_CODE/tasks/$TASK_ID" \
  -H "Authorization: Bearer $BOT_KEY"
```

分别读取 `task.state` 执行状态、`task.decision` 业务判断、`task.reason` 依据/文案，以及 `task.callbackStatus` 投递状态。`reason` 是字符串，不保证是固定 JSON 产物结构。使用适当间隔与退避轮询，不因等待而重复提交。执行状态包括 `created`、`running`、`suspended`、`finished`、`canceled`、`error`。待人工复核时，任务为暂停状态并携带问题/选项，通过管理界面或管理 API 回答。

本场景先向人展示草稿，由商品系统执行后续保存或发布。选择一个不带回调的动作不会自动完成外部发布。以后要接回调时，先声明允许的动作，并在 Bot 中配置目标域名白名单。[完整业务案例](./bot-product-publishing.md)提供审核、回调及回执核验流程。

## 4. 取消不再需要的任务

```bash
curl --fail-with-body --silent --show-error \
  "$PANDA_URL/api/v1/bots/$BOT_CODE/tasks/$TASK_ID/cancel" \
  -H "Authorization: Bearer $BOT_KEY" \
  -H "Content-Type: application/json" --data '{}'
```

请求体必须是空 JSON 对象。返回 `200`、`{task}` 与 `state:"canceled"`，重复取消安全。排队或运行中的任务先隔离执行租约，再中断引擎，迟到结果不能恢复任务。用原幂等键再次提交仍返回该已取消任务，不会悄悄新建一个。

已完成返回 `409 invalidState`；外部回调正在执行或结果不确定时返回 `409 callbackInFlight`，应先核实外部回执。取消不能撤销已送达的回调。无效、撤销或过期 Key 返回 `401`，超出 Key 的 Bot 范围返回 `403`，超出所属账号/Bot 的任务返回 `404`。

取消会保留任务记录，与保留时长及删除记录是独立操作。创建/配置 Bot 和密钥使用管理登录会话，提交/查询/取消任务使用受限 Bot Key。
