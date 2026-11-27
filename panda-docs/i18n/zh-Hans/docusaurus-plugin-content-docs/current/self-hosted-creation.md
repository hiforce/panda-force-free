---
title: 自建环境的创作配置
---

管理员在每套自建实例中统一配置 Harness 和渲染工具。使用者在「创作」中选择可用的 Harness、模型和成品类型，电脑端和手机端使用同一套配置。

## 1. 接入可用于创作的 Harness

镜像与 Compose 文件请使用同一版本。先完成[安装](installation.md)和 [Harness 接入](harness-runtimes.md)。每个 Harness 配置完成后，都要在「创作」的运行实例选择器中确认它可用。

<div className="base-image-table">

| Harness              | 创作所需配置                                                                                                                                                                                                                                                                                                                                                                                                                                        | 图片生成                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **内置 Codex**       | 使用标准 Compose 服务，完成 Codex 原生登录，或配置 [Codex 模型服务](model-providers.md)。也可以将[宿主机 Codex 守护进程](installation.md#use-codex-already-installed-on-the-host)接为应用主连接。                                                                                                                                                                                                                                                   | 默认由选中的 Codex 模型调用原生绘图工具。可以用 `media.model` 单独指定绘图模型。 |
| **额外命名的 Codex** | 用 `PANDA_FORCE_CODEX_HARNESS_PROFILES` 或 `PANDA_FORCE_HOST_HARNESS_PROFILES` 注册 Codex 的 socket。应用需要能连接该 socket，并和引擎访问相同的工作区绝对路径。                                                                                                                                                                                                                                                                                    | 使用该实例在创作中提供的原生绘图能力。                                           |
| **Grok Build**       | 加载 `deploy/harness/docker-compose.grok.yml`，在 `grok-auth` 服务内完成设备登录。如果由 PandaForce 直接启动本机 CLI，则用 `PANDA_FORCE_HARNESS_PROFILES` 指定可执行文件、私有账户目录和可选的凭据 socket。                                                                                                                                                                                                                                         | 使用已登录且有资格的 Grok Build 账号，通过原生 Imagine 生图。 |
| **ZCode**            | 加载 `deploy/harness/docker-compose.zcode.yml`，将 `PANDA_FORCE_ZCODE_PROVIDER_FILE` 指向私有供应商 JSON。由 PandaForce 直接启动本机 CLI 时，用 `PANDA_FORCE_ZCODE_HARNESS_PROFILES` 配置 `command`、`builtinConfig`、`providerConfig`、`providerId` 和 `model`。供应商和模型 ID 须与私有配置匹配。                                                                                                                                                 | 使用已接入创作会话的 ZCode 原生生图插件。条件见下文。                            |
| **Antigravity CLI**  | 选用含 `agy` 的镜像和 `deploy/harness/docker-compose.antigravity.yml`。将 `PANDA_FORCE_ANTIGRAVITY_ACCOUNT_HOME_HOST` 指向专用账户目录，并在该目录完成 Google 登录。由 PandaForce 直接启动本机 CLI 时，用 `PANDA_FORCE_ANTIGRAVITY_HARNESS_PROFILES` 设置已登录的 `accountHome`，CLI 不在 `/usr/local/bin/agy` 时再指定路径。                                                                                                                       | 使用该实例在创作中提供的原生绘图能力。                                           |
| **Claude Code**      | 加载 `deploy/harness/docker-compose.claude-code.yml`。用 `PANDA_FORCE_CLAUDE_CODE_TOOLS_HOST` 指定 CLI 和 ACP 适配器目录，用 `PANDA_FORCE_CLAUDE_CODE_ACCOUNT_HOME_HOST` 指定已完成登录的私有账户目录。由 PandaForce 直接启动本机 CLI 时，用 `PANDA_FORCE_CLAUDE_CODE_HARNESS_PROFILES` 配置 `command`（ACP 适配器）、`claudeCommand` 和 `accountHome`。使用命名的 Claude Code 宿主机 socket 时，桥接进程和应用须能访问同一个工作区，才可用于创作。 | 使用该实例在创作中提供的原生绘图能力。                                           |

</div>

通过宿主机 socket 设置 `PANDA_FORCE_HOST_HARNESS_PROFILES` 注册的 Grok Build、ZCode、Antigravity 目前仅用于会话。要用它们创作，请选表中的 Compose 或由 PandaForce 直接启动 CLI 的方式。各版本的完整配置示例和 CLI 安装步骤见代码目录中的 `deploy/harness/README.md`。

使用 Compose 时，在主配置之后加入所选 Harness 的覆盖文件。例如，设置好 ZCode 供应商配置路径后，可以这样启动。

```bash
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.zcode.yml up -d --no-build
```

保留这套实例已有的覆盖文件。源码安装时，为每个 JSON 配置指定独立的 `id` 和 `name`，路径以服务运行环境为准。Antigravity 在配置的账户目录运行 `agy acp --login`。Claude Code 将 `HOME` 设为 `accountHome`，将 `CLAUDE_CONFIG_DIR` 设为该目录下的 `.claude`，再运行 `claude auth login`。登录命令以 PandaForce 服务用户执行。

打开「设置 → Harness Runtime」，添加尚未出现的配置，启用并检查连接，再设置谁可以使用。进入「创作」，确认能选到相应的运行实例和模型。如果开放给普通成员，用成员账号再检查一次。

## 2. 按成品类型检查依赖

<div className="base-image-table">

| 创作类型     | PandaForce 实例需要什么                                                                                                                                                                                   | 怎样确认成品已保存                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **文档**     | 可用于创作的 Harness，以及可写的应用文档存储。模型可以直接生成 PandaForce 文档。                                                                                                                          | 打开已保存的可编辑文档。导出 PDF 和导入文件各自有独立入口。 |
| **图片**     | 所选 Harness 需要在创作会话中提供绘图能力。内置 Codex 的供应商和账号也须支持原生生图。                                                                                                                    | 打开已保存的图片，并下载原图验证。                          |
| **演示文稿** | 文字幻灯片使用内置 PowerPoint 生成器。要为图片页生成新插图，再为所选 Harness 启用绘图。                                                                                                                   | 下载可编辑的 `.pptx`，用演示文稿软件打开。                  |
| **视频**     | 应用运行环境须具备 FFmpeg 及其 H.264 `libx264` 编码器、`zoompan`、`concat` 和 `fade` 滤镜，以及 FFprobe 和 Fontconfig。默认字体为 `Noto Sans CJK SC`。需要生成新插图的场景同样要为所选 Harness 启用绘图。 | 播放已保存的无声动态图文 `.mp4`。                           |
| **网页**     | 内置 HTML 生成器可直接保存独立网页。需要生成新插图时，再为所选 Harness 启用绘图。在线预览是隔离的静态预览。要运行原件已有的脚本，可将原件下载到合适的环境中打开。                                         | 打开已保存的预览，并下载 HTML 原件。                        |

</div>

标准运行镜像已提供渲染依赖。请在 PandaForce 实际运行的环境里检查，例如运行 `docker compose exec panda-force panda-tools doctor` 和 `docker compose exec panda-force panda-tools fonts`。使用自定义镜像时，参见[创作工具基础镜像](base-images.md)。如果视频工具装在其他位置，可用 `PANDA_FORCE_CREATION_FFMPEG` 和 `PANDA_FORCE_CREATION_FFPROBE` 指定应用可见的绝对路径，并通过 `PANDA_FORCE_CREATION_VIDEO_FONT_FAMILY` 选择已安装的字体。

## 3. 配置内置 Codex 的绘图后端

`media.model` 是内置 Codex 的可选绘图模型设置，只用于选择了该内置 Harness 的任务。命名的 Codex 实例及其他 Harness 使用各自的绘图能力。

先用这套实例的**主 Codex 连接**实际生成一张图片，确认要用的模型能正常出图。连接检查或文字回复只验证对应的连接和文字能力，生成图片需要单独验证。自定义代码模型服务的文字接口与绘图能力可能不同。采用共享模式时，供应商设置和登录状态由主 Codex 守护进程管理。

PandaForce 自带创作默认配置。需要单独为内置 Codex 指定绘图模型时，在应用的持久化目录 `$PANDA_FORCE_HOME/config/` 下放置 `creation-engines.json`。标准 Compose 中，**容器内**的路径是 `/var/lib/panda-force/config/creation-engines.json`。也可以将文件只读挂载到其他位置，通过 `PANDA_FORCE_CREATION_CONFIG_FILE` 指定该路径。

```json
{
  "schema": 1,
  "defaultProfileId": "codex",
  "profiles": [
    {
      "id": "codex",
      "engineId": "codex",
      "media": {
        "model": "YOUR_CODEX_IMAGE_CAPABLE_MODEL_ID"
      }
    }
  ]
}
```

将占位值换成主 Codex 连接可用、且已验证可以调用原生绘图工具的模型 ID。用户选择的 Harness 仍使用自己的任务模型。已有配置文件时，在默认配置中补上 `media`，保留其余配置项。供应商密钥继续存放在私有文件、原生登录目录或部署密钥中。

如果通过 Compose 管理配置，在部署目录中保存 `./private/creation-engines.json`，并加入下面的覆盖配置。请确保 PandaForce 服务的运行用户能读取这个文件。

```yaml
services:
  panda-force:
    environment:
      PANDA_FORCE_CREATION_CONFIG_FILE: /run/panda-creation/creation-engines.json
    volumes:
      - type: bind
        source: ./private/creation-engines.json
        target: /run/panda-creation/creation-engines.json
        read_only: true
        bind:
          create_host_path: false
```

执行 `docker compose up -d --no-build`，保留所有已有的 `-f` 参数，并在命令中加入新的覆盖文件。如果直接修改持久化目录中的配置，则重启 PandaForce 让它重新读取。Kubernetes 可通过 ConfigMap 挂载配置文件，应用 Pod 滚动更新后生效。供应商凭据继续使用 Secret 或引擎原有的凭据存储。

## 4. 配置 Grok Build 原生生图

由 PandaForce 启动的 Grok Build 可以用已登录的账号调用官方 Imagine 工具。按上文完成设备登录并为用户开放该运行实例。在**创作**中选择 **Grok Build** 和**图片**，输入绘图需求。竖版插图可指定 `9:16`。保存后可打开作品并下载原图。目前接入支持文字生成图片。 [Grok Build Imagine 命令](https://docs.x.ai/build/modes-and-commands#core-tui-commands)。

## 5. 配置 ZCode 原生生图

对由 PandaForce 启动的 ZCode，管理员需要安装官方 `image-generation` 插件，并使用具备可用 Coding Plan 的智谱 BigModel 个人账号登录。如果 Z.ai 提示登录，请使用同一账号。浏览器显示授权成功后，等命令行完成登录。供应商文件中的套餐 Key 继续用于模型请求。 [ZCode 常见问题](https://zcode.z.ai/cn/docs/qa) · [ZCode 发行说明](https://zcode.z.ai/cn/changelog)。

在安装机器上用服务运行账号执行以下命令，把示例路径换成专用的私有持久目录。使用容器时，在有匹配 ZCode CLI 的环境里准备该目录，再挂载进应用容器。标准运行镜像已提供所需的 Node.js 20 或更高版本。

```bash
umask 077
export HOME=/absolute/path/to/private-zcode-image-home
export ZCODE_DATA_BASE_DIR="$HOME/zcode"
export ZCODE_CREDENTIAL_SECRET_FILE="$ZCODE_DATA_BASE_DIR/.zcode/v2/credential-secret"
mkdir -p "$ZCODE_DATA_BASE_DIR/.zcode/v2"
if [ ! -e "$ZCODE_CREDENTIAL_SECRET_FILE" ]; then
  head -c 32 /dev/urandom > "$ZCODE_CREDENTIAL_SECRET_FILE"
fi
chmod 700 "$HOME"
zcode plugins install image-generation@zcode-plugins-official --scope user
zcode plugins enable image-generation@zcode-plugins-official --scope user
zcode plugins list --json
zcode login bigmodel --no-browser
```

当前接入已核对官方插件 `0.1.2` 和 BigModel 个人浏览器登录流程。如果账号登录失效，在同一私有目录重新运行原生登录。请妥善保管目录和其中的加密凭据文件。使用 Compose 时，应用容器应以只读方式挂载该目录，登录命令则需要同一目录的写权限。

在 `PANDA_FORCE_ZCODE_HARNESS_PROFILES` 对应的 ZCode 配置项中添加 `"creationImageHome": "/应用可见的绝对路径"`，保留原来的 ID、命令、供应商和模型。Compose 可在 ZCode 覆盖文件后面再加一份覆盖文件，设置完整 JSON 数组。重启应用加载配置，进入**创作**选择对应的 ZCode，再检查图片能保存并下载原图。每次生成可选一张参考图，最大 10 MiB。

## 6. 验证创作与保存

修改配置后新建创作任务进行验证。

1. 逐个选择已配置的 Harness，选「文档」，请它写一份带标题的短说明。打开已保存的作品，确认该 Harness 可以完成交付。
2. 选「图片」，请它生成一张白底蓝色圆形的简图，打开图片并下载原图。先测试内置 Codex，确认绘图后端能出图，再逐个测试提供原生绘图工具的 Harness。
3. 按你要开放的成品类型，再生成并打开两页演示文稿、一段简短的字幕视频和一个单区块 HTML 页面。需要新插图的工作流，另外验证插图能生成并保存在成品中。

找不到 Harness 时，检查接入方式、启用状态和账号访问范围。文档能保存而图片失败时，检查所选 Harness 的绘图能力和账号权限。找不到视频选项时，在应用运行环境里检查 FFmpeg、FFprobe 和所选字体。配置文件路径或 JSON 有误时，修正后重启应用再试。
