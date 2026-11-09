---
title: 模型服务配置
---

PandaForce 通过服务端的 Codex CLI 执行模型请求。请先配置实际运行的命令行，再在网页中选择模型。网页账号登录与模型服务的密钥认证相互独立。本文介绍智谱 GLM、Ollama 和 DeepSeek。请在实际执行环境中使用 `codex --version` 查看命令行版本。

## 配置目录

`CODEX_HOME` 是保存 Codex 配置、凭据和会话状态的目录绝对路径。标准容器使用以下路径：

```text
CODEX_HOME=/home/codex/.codex
配置文件：/home/codex/.codex/config.toml
模型目录文件：/home/codex/.codex/models-glm.json
```

将 `config.toml` 直接保存在该目录中。未设置 `CODEX_HOME` 时，Codex 使用实际运行用户的 `~/.codex`；Windows 对应 `%USERPROFILE%\.codex`。服务和容器部署建议显式指定绝对路径。

| 配置项                       | 作用                                                      |
| ---------------------------- | --------------------------------------------------------- |
| 命令行程序及 `PATH`          | 决定执行哪个命令行程序。                                  |
| `PANDA_FORCE_CWD` 和会话目录 | 决定任务在哪里读取和修改项目文件。                        |
| `PANDA_FORCE_PROJECTS_ROOT`  | 决定新项目目录创建在哪里。                                |
| `HOME`                       | 独立运行的命令行继承的用户主目录，也影响包含 `~` 的路径。 |
| `CODEX_HOME`                 | 决定配置、凭据、模型目录文件和会话状态的存储目录。        |

工作目录与 Codex 状态目录分别配置。修改前先备份原文件；TOML 顶层配置写在服务商配置表之前，同名配置表不要重复创建。模型目录文件建议使用命令行进程可见的绝对路径。

## 选择部署方式

### 本机运行命令行

使用与 PandaForce 启动进程相同的账号和环境运行 Codex。将配置保存在该账号的 Codex 状态目录，项目工作目录单独设置。例如，服务账号可以使用 `CODEX_HOME=/home/alex/.codex`，项目则保存在 `/srv/projects`。

执行账号需要能够读取配置与模型目录文件，并能写入会话状态。项目子目录复用这份用户级配置。

### 容器内独立运行命令行

标准 Compose 安装将持久化模型状态卷挂载到 `/home/codex/.codex`，并将 `CODEX_HOME` 设为该路径。在卷内准备 `config.toml` 及其引用的模型目录文件，再通过对应服务商的环境变量或命令行登录流程提供认证。

状态目录所有者应匹配容器运行用户的 UID；目录通常使用 `0700` 权限，含凭据文件使用 `0600` 权限。状态目录需要可写，以便 Codex 持久化会话。

### 为容器提供持久化配置

为容器选择以下一种配置来源：

- **复用宿主机目录**：将 Docker 服务所在主机上的绝对路径显式挂载到容器。`CODEX_HOME` 指容器内的目标路径，不是宿主机源路径。
- **独立的模型状态**：使用标准命名卷或 Kubernetes 持久化卷。创建会话前，在卷中初始化配置和认证。
- **复用宿主机引擎**：认证留在宿主机服务中，容器连接其套接字，并提供对应工作区。

复用已有配置时，可使用以下 Compose 覆盖片段：

```yaml
services:
  panda-force:
    environment:
      CODEX_HOME: /home/codex/.codex
    volumes:
      - type: bind
        source: /srv/codex-state
        target: /home/codex/.codex
        bind:
          create_host_path: false
```

`source` 是 Docker 服务所在主机的绝对目录，`target` 是容器内的挂载路径。启动服务前，请在 `/srv/codex-state` 中准备所需的 `config.toml`、模型目录文件和认证材料，并允许容器运行 UID 写入会话状态。使用远程 Docker 服务时，请在远程主机上准备源目录。

Kubernetes 部署可以挂载持久化状态卷，并从 Secret 注入服务商密钥：

```yaml
spec:
  securityContext:
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
  containers:
    - name: panda-force
      image: hiforceai/panda-force:0.0.17
      env:
        - name: CODEX_HOME
          value: /home/codex/.codex
        - name: ZHIPU_API_KEY
          valueFrom:
            secretKeyRef:
              name: model-provider
              key: zhipu-api-key
      volumeMounts:
        - name: codex-state
          mountPath: /home/codex/.codex
  volumes:
    - name: codex-state
      persistentVolumeClaim:
        claimName: codex-state
```

将上述片段加入 Pod 配置；使用 Deployment 时放在 `spec.template` 下。发布前创建引用的持久化卷声明和密钥对象，并按镜像及集群策略调整 UID。可以通过受控的初始化任务向卷中写入 `config.toml` 和引用的模型目录，也可将无密钥文件从 ConfigMap 逐个挂载，接口密钥由 Secret 提供。`CODEX_HOME` 使用可写存储，只读配置文件可以逐个挂载，凭据在运行时提供。使用 `hostPath` 时，请在选定的集群节点上准备目录，并配置匹配的节点调度和权限。

### 连接宿主机共享服务

模型配置和密钥由宿主机的 Codex 后台服务读取，网页容器通过套接字连接该服务。只改网页容器的 `HOME` 或 `CODEX_HOME`，不会改变已经启动的后台服务。还需确保套接字可访问、任务工作区路径在两端对应。部署步骤见[安装指南中的共享服务说明](installation.md#use-codex-already-installed-on-the-host)。

保存配置后，在合适的维护时间重启实际执行模型的进程，再创建新会话验证。仅重启网页应用不会重新加载外部后台服务的配置。切换服务商时保留认证文件和会话状态；旧会话可能仍关联原服务商。

## 智谱 GLM

请使用对应编程套餐的密钥；个人套餐、团队套餐和标准接口的密钥不能混用。模型权限及当前元数据以[智谱官方 Codex 接入说明](https://docs.bigmodel.cn/cn/coding-plan/tool/codex)为准。Codex 需要专用的 Responses 协议端点，不能直接套用普通聊天补全接口。

1. 获取编程套餐的接口密钥。
2. 在 `CODEX_HOME` 目录内直接保存 `models-glm.json`，内容如下：

```json
{
  "models": [
    {
      "slug": "glm-5.3",
      "display_name": "GLM-5.3",
      "description": "GLM 编程模型",
      "default_reasoning_level": "max",
      "supported_reasoning_levels": [
        { "effort": "low", "description": "低强度推理" },
        { "effort": "high", "description": "高强度推理" },
        { "effort": "max", "description": "最高强度推理" }
      ],
      "shell_type": "shell_command",
      "visibility": "list",
      "supported_in_api": true,
      "priority": 0,
      "base_instructions": "",
      "supports_reasoning_summaries": true,
      "default_reasoning_summary": "none",
      "support_verbosity": false,
      "apply_patch_tool_type": "freeform",
      "truncation_policy": { "mode": "bytes", "limit": 10000 },
      "context_window": 1048576,
      "max_context_window": 1048576,
      "effective_context_window_percent": 95,
      "supports_parallel_tool_calls": true,
      "experimental_supported_tools": [],
      "input_modalities": ["text"]
    }
  ]
}
```

3. 将以下配置合入 `config.toml`。示例模型目录路径适用于标准容器，其他布局请修改。`env_key` 填写环境变量名称，不是密钥内容。

```toml
model_provider = "zhipu"
model = "glm-5.3"
model_reasoning_effort = "max"
model_catalog_json = "/home/codex/.codex/models-glm.json"
web_search = "disabled"

[model_providers.zhipu]
name = "Zhipu GLM"
base_url = "https://open.bigmodel.cn/api/v1"
wire_api = "responses"
env_key = "ZHIPU_API_KEY"
requires_openai_auth = false
```

4. 将 `ZHIPU_API_KEY` 私密传给实际运行命令行的进程。启动 `codex`，确认服务商和模型，在临时项目目录执行一个小任务；再到 PandaForce 新建会话，选择 GLM 验证。

完成端点、密钥和模型目录配置后，再选择模型。通用字段见 [OpenAI 官方自定义服务商配置说明](https://learn.chatgpt.com/docs/config-file/config-advanced)。本文使用 `wire_api = "responses"`，仅兼容聊天补全接口还不够。

## Ollama

安装并启动 Ollama，拉取硬件可承载且支持工具调用的模型。[官方 Codex 接入说明](https://docs.ollama.com/integrations/codex)建议至少使用 64K 上下文。

```bash
ollama pull gpt-oss:20b
codex --oss --local-provider ollama -m gpt-oss:20b
```

服务端长期使用时，可以配置：

```toml
model_provider = "local_ollama"
model = "gpt-oss:20b"
web_search = "disabled"

[model_providers.local_ollama]
name = "Local Ollama"
base_url = "http://127.0.0.1:11434/v1"
wire_api = "responses"
requires_openai_auth = false
```

确认 Ollama 提供 Responses 协议端点，并在 Ollama 中调整模型上下文大小。可用内存和显存会限制模型及上下文容量。包含 `ollama launch codex` 命令的版本也可以自动配置；用于服务端前应先检查它生成的配置。

容器里的 `127.0.0.1` 指容器本身。连接宿主机 Ollama 时，请使用容器可访问的宿主机地址。Docker Desktop 可使用 `host.docker.internal`，Linux Compose 可能需要配置 `host-gateway` 映射；也可将两个服务放在同一容器网络。不要把无认证的 Ollama 端口直接暴露到公网。

## DeepSeek

准备 DeepSeek 接口密钥，核对[官方 Codex 接入说明](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)中的模型目录，将其保存为 `CODEX_HOME` 下的 `models-deepseek.json`，然后配置：

```toml
model_provider = "deepseek"
model = "deepseek-flash"
model_reasoning_effort = "high"
model_catalog_json = "/home/codex/.codex/models-deepseek.json"
web_search = "disabled"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com"
wire_api = "responses"
env_key = "DEEPSEEK_API_KEY"
requires_openai_auth = false
```

将 `DEEPSEEK_API_KEY` 传入命令行进程，确认模型与账号权限、目录元数据匹配。这里的基础地址不追加 `/v1/chat/completions`。具体模型或网关的工具调用能力需要单独验证，协议说明见[官方 Responses 接口文档](https://api-docs.deepseek.com/guides/responses_api/)。

## 将密钥传入容器

Compose 不会自动把任意宿主机环境变量传进容器。以下智谱示例保存为 `compose.provider.yml`：

```yaml
services:
  panda-force:
    environment:
      ZHIPU_API_KEY: ${ZHIPU_API_KEY:?请私密设置 ZHIPU_API_KEY}
```

通过密钥管理系统获取密钥，或者使用以下 Bash 交互输入方式，再重新创建服务：

```bash
read -r -s -p '智谱接口密钥：' ZHIPU_API_KEY
printf '\n'
export ZHIPU_API_KEY
docker compose -f docker-compose.yml -f compose.provider.yml up -d --no-build
```

PowerShell 应使用对应的安全输入流程。配置 DeepSeek 时，将变量名替换为 `DEEPSEEK_API_KEY`。不要记录包含密钥的 Compose 展开配置或容器环境。共享后台服务需要在其自身环境中获得密钥，仅传给网页容器没有作用。

## 验证与排错

| 现象                             | 检查内容                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------ |
| 模型列表仍是旧内容               | 运行用户、`CODEX_HOME`、模型目录绝对路径和权限；重启实际执行进程并创建新会话。 |
| 缺少密钥或返回 401               | 密钥是否传入命令行或后台服务进程、密钥产品类型和账号权限。                     |
| 返回 404 或协议不支持            | 是否使用 Responses 基础地址、命令行与服务商版本是否兼容。                      |
| 能列出模型，但发送或工具调用失败 | 列表只证明元数据可读；用小任务验证流式响应、工具调用和上下文支持。             |
| 无法连接 Ollama                  | 从命令行所在容器检查网络地址、监听地址和防火墙。                               |
| 切换服务商后看不到旧会话         | 恢复原配置查看相应会话，不要删除持久化模型状态卷。                             |

先从工作区根目录和项目子目录验证命令行，再检查 PandaForce 新会话的首轮回复、工具调用、右侧统计更新和重启后配置保留。部分模型不会返回全部用量字段，“未报告”不等于用量为零。
