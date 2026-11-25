---
title: 容器中的 Codex 与 Grok Build
---

PandaForce 0.1.11 支持**多个 Harness Runtime**。运行实例决定原生引擎和账户连接，模型清单与推理强度来自该运行实例。会话、助理/Bot 和支持的创作设置统一按 **Harness Runtime → 模型 → 推理强度**选择。公开应用镜像同时包含 Codex 和本次新增集成的 **Grok Build**。

已启用的运行实例默认可供 Bot 使用。如果要从 Bot 的下拉框移除某个实例，请到 **设置 → Harness Runtime** 编辑该实例，关闭 **允许 Bot 使用此运行实例**。

## 安装配套发行版

从 `main` 分支获取安装配置，运行已发布的 `hiforceai/panda-force:0.1.11` 镜像：

```bash
git clone --branch main --depth 1 https://github.com/hiforce/panda-force-free.git
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

公开镜像包含 Codex CLI、Grok Build 和 ZCode。Grok 的 Compose 叠加配置负责账户管理和续期。Antigravity 可以通过本地构建启用。

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

账户服务持有刷新凭据，应用只挂载私有 socket，再给隔离引擎提供仅含访问凭据的副本。命名账户卷适用于 Linux 和 Docker Desktop。Linux 运维已有账户目录时可设置 `PANDA_FORCE_GROK_ACCOUNT_HOME_HOST`，该目录须事先具有正确 UID/GID 与私有权限；初始化器不会修改这个宿主机绑定目录的所有者。[账户服务指南](https://github.com/hiforce/panda-force-free/blob/v0.1.11/deploy/harness/README.md)说明完整生命周期及宿主机服务选项。

## 核对镜像并保留账户

```bash
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.grok.yml config --images
docker compose exec panda-force codex --version
docker compose exec panda-force grok --no-auto-update --version
docker compose exec panda-force panda-tools doctor
```

0.1.11 发行版审核过的引擎为 Codex CLI **0.171.0**、Grok Build **1.0.89** 和 ZCode CLI **0.17.1**。镜像已具备 Office、PDF/OCR、字体、浏览器、图像、写作、研究和视频工具；[内容与用途](base-images.md)说明配套构建/运行基础镜像。

`PANDA_FORCE_IMAGE` 可统一覆盖应用与 Grok 辅助服务镜像，支持自有仓库或摘要；请保持配套版本。`PANDA_FORCE_PULL_POLICY` 控制拉取，仓库凭据由独立仓库工具管理。升级前检查 `.env` 是否仍覆盖了旧镜像，保留原 Compose 项目名和卷名。`docker compose down` 保留命名卷；升级前备份应用、Codex、Grok 账户和工作区。socket 卷保存通信状态，不能代替账户备份。

已有会话在当前轮完成后切换 Harness。PandaForce 交接选定上下文，文件保留在工作目录，不会把整个 JSONL 归档塞给下一个模型；历史含时间戳，便于定向回溯。运行实例/账户访问范围与执行权限继续生效。

## ZCode

0.1.11 镜像内置 ZCode CLI 0.17.1。ZCode 是实验性的会话 Harness，支持文字回复、可见的思考与工具进度、审批和会话续接。应用会根据上游返回的数据展示用量。ZCode 配置完成后在会话中使用，创作和 Bot 继续使用各自支持的 Harness。

1. 将 [Provider 示例](https://github.com/hiforce/panda-force-free/blob/v0.1.11/deploy/harness/zcode-provider.example.json) 复制到仓库外的私有位置，在副本中填入自己的 BigModel Coding Plan API Key。保留示例的 Provider ID 和模型 ID，或同时修改 Compose 配置与 Provider 文件。确保容器的运行用户能读取该文件。
2. 从发行版目录运行以下命令，将路径改为自己的配置文件。升级已有安装时沿用原来的 Compose 项目名和数据卷。

   ```sh
   export PANDA_FORCE_ZCODE_PROVIDER_FILE="$HOME/.config/panda-force/zcode-provider.json"
   docker compose -f docker-compose.yml -f deploy/harness/docker-compose.zcode.yml up -d --no-build
   ```

3. 打开 **设置 → Harness Runtime → 添加**，选择 ZCode 配置并保存。在会话中选择这个运行环境。明确发起测试时会使用你自己的账户。

已启用 Grok Build 的安装可同时保留 Grok 的 Compose 配置。运行时只读挂载 Provider JSON，密钥保存在你自己的文件中。套餐额度以 Provider 后台显示为准。


## 同时使用多个命名实例

配置档指定引擎、可执行文件和账户连接。会话输入区显示的是有名字的运行实例。打开**设置 → Harness Runtime → 添加**，选择已安装的配置档，用容易辨认的名字保存，例如「ZCode 工作」或「Grok 研究」。按需设置可访问的用户和默认模型，检查连接后，在输入区按名字选择。项目内的新建会话可以在首条消息前保存模型。

不同账户使用各自的连接。配置档 ID 在所有供应商之间都要唯一，升级期间请保留原来的 ID。修改实例显示名称时可以沿用其原有 ID。

| 引擎 | 独立账户配置 |
| --- | --- |
| Codex | 每个额外账户使用独立的 app-server Unix socket 和账户目录 |
| Grok Build | 每个账户使用独立的私有目录和续期服务 socket |
| ZCode | 每个账户挂载独立的只读 Provider JSON，模型必须在该文件中声明 |
| Antigravity | 每个 Google 登录使用独立的可写账户目录和管理员提供的 CLI |

在同一条 Compose 命令中保留所有已启用的叠加配置，升级时沿用 Compose 项目名。[两个 ZCode 实例的示例](https://github.com/hiforce/panda-force-free/blob/v0.1.11/deploy/harness/README.md#run-two-zcode-profiles-alongside-codex-and-grok)可与 Codex 和 Grok 一起运行。同一份指南也列出了各引擎的配置字段和容器挂载方式。

## Antigravity CLI

可选的 ACP 连接通过 Google 原生 `agy acp` 进程处理会话。按[本地构建与登录指南](https://github.com/hiforce/panda-force-free/blob/v0.1.11/deploy/harness/README.md#antigravity-cli-on-rocky-9)构建锁定版本的 CLI，挂载私有账户目录，再完成 Google 登录。请核对账户适用的 [Antigravity 条款](https://antigravity.google/terms)。模型与推理强度由该 Google 账户的可用能力决定。

Antigravity 默认会询问需要批准的工具操作。在会话设置中选择**自动批准工具**，即可对下一轮启用 Antigravity 原生的自动批准。进程可以访问的资源仍由应用容器和挂载配置决定。

## 选择宿主机模式或容器模式

以下配置适用于支持宿主机 Harness 配置档的 PandaForce 构建。独立安装可以用容器模式。Linux 宿主机上已经登录或配置好的 CLI 可以用宿主机模式，在原位置运行并复用原账户。两种模式可以同时启用，每个配置档使用独立 ID。

| Harness | 容器模式 | Linux 宿主机模式 |
| --- | --- | --- |
| Codex | 使用标准 Compose 服务，在容器里运行 `codex login --device-auth`，保留模型状态卷。 | 启动原生 Codex daemon，配置[共享模式](installation.md#use-codex-already-installed-on-the-host)，或添加命名 `codex` socket 配置档。 |
| Grok Build | 使用 `docker-compose.grok.yml`，在 `grok-auth` 服务中完成设备登录。 | 用宿主机已登录的用户运行 `grok agent stdio`，`GROK_HOME` 指向该账户的原生目录。 |
| ZCode | 使用 `docker-compose.zcode.yml`，挂载私有 Provider JSON。 | 用宿主机的 Provider 配置运行 `zcode app-server --stdio`，在配置档中填写对应的 `providerId` 和 `model`。 |
| Antigravity | 使用 `docker-compose.antigravity.yml`，在独立账户目录中用 `agy` 完成 Google 登录。 | 使用 Google 登录时的 `HOME` 运行 `agy acp`。 |
| Claude Code | 使用 `docker-compose.claude-code.yml`，提供原版 CLI、ACP 适配器和私有账户目录，在该目录下运行 `claude auth login`。 | 以已登录的 Linux 用户启动 ACP 适配器，`CLAUDE_CODE_EXECUTABLE` 指向原版 CLI，沿用既有的账户目录。 |

宿主机模式下，除 Codex 使用原生 socket 外，其他四种引擎用 `src/server/harness/host-cli.ts` 提供私有 Unix socket。`PANDA_FORCE_HOST_HARNESS_PROFILES` 是 JSON 数组，每条配置包括唯一的 `id`、显示用的 `name`、引擎 `kind` 和绝对 `socketPath`。`kind` 支持 `codex`、`grok-build`、`zcode`、`antigravity` 和 `claude-code`。用 `deploy/harness/docker-compose.host.yml` 只读挂载 socket 目录，并让宿主机与容器使用相同的工作区绝对路径。登录状态保存在原生 CLI 的宿主机环境里。请确保 PandaForce 的运行用户能连接该 socket。完整命令和配置示例在源码目录的 `deploy/harness/README.md` 中。

打开 **设置 → Harness Runtime**，添加配置档，先点**检查连接**，再到会话里选择对应实例。命名宿主机配置供管理员会话使用。宿主机 Antigravity 通过提示完成工具审批。收到登录提示时，在对应环境用原生 CLI 完成登录，再重试连接。

Claude Code 的权限菜单显示手动审批、自动接受编辑、规划、Auto、拒绝未批准的操作和完全访问。运行实例只会启用原生接口提供的模式。完全访问对应 `bypassPermissions`，保存前需要确认。以 root 身份在沙箱外运行的 Claude 桥接不会开放此模式。推理滑杆会按选中的模型显示实际可用档位。切换运行实例时，PandaForce 保留可见历史，并为不同实例保留各自的原生会话绑定。

## 源码开发

需要定制应用的开发者请参阅[容器构建指南](building.md#development-container)，其中包含 Grok 叠加配置。本文的安装与账户命令使用已发布的 `hiforceai/panda-force:0.1.11` 镜像。
