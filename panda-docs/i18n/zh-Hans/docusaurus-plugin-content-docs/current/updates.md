---
title: 升级 PandaForce
---

使用已发布的 `hiforceai/panda-force:0.1.3` 和配套发行配置。升级前查看[发行说明](releases.md#013)。首次安装请使用[安装指南](installation.md)。

0.1.3 在创作、普通会话和 Bot 对话的发送按钮内统一显示发送指示器。创作首次提交会确认 Harness 选择，发送结果无法确认时保留草稿并沿用原请求编号。创作任务的执行权限由服务端管理，设置中可调整模型和推理强度。

## 保留现有安装

- 按[存储指南](storage.md)备份应用状态、所选 SQLite/MySQL 数据库、模型账户、工作区与附件。Grok 账户通过现有持有者备份，避免让多份账户副本独立轮换凭据。
- 保留原 Compose 项目名、`.env`、卷名及管理员配置；审阅新版配置后，再合并到自己的文件。
- 检查 `.env` 和当前终端中的 `PANDA_FORCE_IMAGE`。将旧覆盖项更新为 `hiforceai/panda-force:0.1.3`，或使用配套的自有仓库镜像。仓库凭据继续由独立仓库工具管理。
- 保留前版镜像摘要与兼容备份。涉及数据库迁移时，回退可能需要恢复配套备份，不能仅启动旧镜像。

## 升级标准安装

在原安装目录和 Compose 项目中运行：

```bash
docker compose config --images
docker compose pull panda-force
docker compose up -d --no-build
docker compose logs --tail 100 panda-force
```

重建容器前确认所选镜像。保留应用和模型账户数据卷；不要通过删除卷修复登录或启动问题。启动日志属于私有信息，可能包含首次安装验证码。

## 升级使用 Grok 账户续期的安装

拉取和重启时使用相同的 Grok 叠加配置，使服务保持配套：

```bash
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml config --images
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml pull
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml up -d --no-build
```

应用与两个账户辅助服务默认选择同版镜像。保留原 Grok 账户卷与 socket 卷。模型服务需要重新登录，或旧 Runtime 列表缺少 Grok 时，按 [Harness 配置指南](harness-runtimes.md)处理。

## 升级后检查

使用原管理员登录，检查项目列表、保存的文档和工作区文件，再进入**设置 → Harness Runtime**检查连接。可选的 **hi** 按钮会发送真实模型请求。启动或登录失败时先查看错误并保留状态，不自动重放尚未完成的用户任务。

维护自建镜像的开发者请参阅[开发指南](building.md#development-container)。源码快照发布流程单独放在[维护者指南](releases.md#maintainer-source-snapshots)。
