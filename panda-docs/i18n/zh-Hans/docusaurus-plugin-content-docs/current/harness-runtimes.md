---
title: 容器中的 Codex 与 Grok Build
---

PandaForce 0.1.2 支持**多个 Harness Runtime**。运行实例决定原生引擎和账户连接，模型清单与推理强度来自该运行实例。会话、助理/Bot 和支持的创作设置统一按 **Harness Runtime → 模型 → 推理强度**选择。公开应用镜像同时包含 Codex 和本次新增集成的 **Grok Build**。

## 安装配套发行版

使用 `v0.1.2` 源码与 `hiforceai/panda-force:0.1.2` 镜像：

```bash
git clone --branch v0.1.2 --depth 1 https://github.com/hiforce/panda-force-free.git
cd panda-force-free
docker compose pull panda-force
docker compose up -d --no-build
```

打开 [http://localhost:8899](http://localhost:8899)，创建应用管理员，选择 SQLite 或配置 MySQL。应用账号登录与模型服务登录相互独立。镜像使用 **Rocky Linux 9**，已安装 Node.js、Bun、Codex CLI、Grok Build 和受维护的创作工具链。此安装方式只需 Docker/Compose，不要求宿主机 CLI 守护进程或 Kubernetes。

<div className="base-image-table">

| 组件                         | 用途                                                         | 持久化状态                            |
| ---------------------------- | ------------------------------------------------------------ | ------------------------------------- |
| `panda-force`                | 浏览器/API 服务、Codex app-server 和按需启动的 Grok ACP 进程 | 应用状态、Codex 账户/会话卷、工作区卷 |
| 可选 `grok-auth`             | 持有 Grok 账户，交给原生命令行续期凭据                       | 独立、私有的 Grok 账户卷              |
| 可选 `grok-auth-socket-init` | 按配置的 UID/GID 一次性准备 Grok 命名账户卷与 socket 卷      | 不执行模型；完成后才启动账户服务      |

</div>

应用镜像已包含两种 CLI。Grok 叠加配置补充账户持有和续期，不需要另装 Grok 二进制，也不替换 Codex。

## 启用 Codex

```bash
docker compose exec -it panda-force codex login --device-auth
docker compose restart panda-force
```

标准 Compose 持久化 `CODEX_HOME=/home/codex/.codex`。其他兼容模型服务的独立配置见[模型服务](model-providers.md)。宿主机已有 Codex 守护进程时，仍可选择[共享模式安装](installation.md#use-codex-already-installed-on-the-host)。

## 启用 Grok Build 与托管账户续期

在同一源码目录加入 Grok 叠加文件，三个服务默认使用相同的应用发行镜像：

```bash
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml pull
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml up -d
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml \
  run --rm grok-auth grok --no-auto-update login --device-auth
```

完成官方设备登录后，打开 **设置 → Harness Runtime → Grok Build**，检查连接；需要时用明确的 **hi** 测试发送一次真实的小型模型请求，查看回复与耗时。之后为任务选择该运行实例、模型和推理强度，模型服务权限来自你自己的账户。登录、连接检查与可选真实模型测试各自独立。

已有安装保存过运行实例清单但没有 Grok 时，在该设置页新增运行实例，选择已安装的 Grok Build profile 后保存；管理员/成员可见范围与默认运行实例由你设置。

PandaForce 按需启动 Grok ACP 进程。账户服务重新读取原生账户文件，使用原生 CLI 在访问凭据接近到期时续期。无需 SSH 后手动打开 Grok，也无需保持交互终端或 tmux 会话。续期失败会显示账户或连接错误；已发出的提示词不会自动重放。

账户服务持有刷新凭据，应用只挂载私有 socket，再给隔离引擎提供仅含访问凭据的副本。命名账户卷适用于 Linux 和 Docker Desktop。Linux 运维已有账户目录时可设置 `PANDA_FORCE_GROK_ACCOUNT_HOME_HOST`，该目录须事先具有正确 UID/GID 与私有权限；初始化器不会修改这个宿主机绑定目录的所有者。[账户服务指南](https://github.com/hiforce/panda-force-free/blob/v0.1.2/deploy/harness/README.md)说明完整生命周期及宿主机服务选项。

## 核对镜像并保留账户

```bash
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml config --images
docker compose exec panda-force codex --version
docker compose exec panda-force grok --no-auto-update --version
docker compose exec panda-force panda-tools doctor
```

0.1.2 发行版审核过的引擎为 Codex CLI **0.171.0** 和 Grok Build **1.0.89**。镜像已具备 Office、PDF/OCR、字体、浏览器、图像、写作、研究和视频工具；[内容与用途](base-images.md)说明配套构建/运行基础镜像。

`PANDA_FORCE_IMAGE` 可统一覆盖应用与 Grok 辅助服务镜像，支持自有仓库或摘要；请保持配套版本。`PANDA_FORCE_PULL_POLICY` 控制拉取，仓库凭据由独立仓库工具管理。升级前检查 `.env` 是否仍覆盖了旧镜像，保留原 Compose 项目名和卷名。`docker compose down` 保留命名卷；升级前备份应用、Codex、Grok 账户和工作区。socket 卷保存通信状态，不能代替账户备份。

已有会话在当前轮完成后切换 Harness。PandaForce 交接选定上下文，文件保留在工作目录，不会把整个 JSONL 归档塞给下一个模型；历史含时间戳，便于定向回溯。运行实例/账户访问范围与执行权限继续生效。

## 源码开发

需要定制应用的开发者请参阅[容器构建指南](building.md#development-container)，其中包含 Grok 叠加配置。本文的安装与账户命令使用已发布的 `hiforceai/panda-force:0.1.2` 镜像。
