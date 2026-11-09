---
title: Model providers · 模型服务配置
---

PandaForce uses Codex CLI for model execution. Configure the CLI that runs on the **server**, not your browser. The model selector chooses models from that provider; selecting a model does not configure its endpoint or credentials. These instructions were checked against provider documentation on 2026-11-09. This release packages Codex CLI 0.166.0; check your actual runtime with `codex --version`.

PandaForce 的模型执行由服务端 Codex CLI 完成。先配置服务端 CLI，再选择网页里的模型。网页管理员登录、IDAAS/OIDC 登录与模型 API Key 是独立的。本文优先补充智谱 GLM，同时整理 Ollama 与 DeepSeek；示例经过配置语法检查，未使用用户密钥发起付费模型调用。

## Before configuring · 配置位置

Codex reads `config.toml` under its `CODEX_HOME`, normally `~/.codex` (`%USERPROFILE%\.codex` on Windows). Back up existing configuration; merge provider sections without duplicating TOML tables. Put root settings **before** `[model_providers.…]` tables. Use absolute catalog paths as seen by the CLI process.

- Local installation: use the account that starts PandaForce. A different terminal user has a different Codex home.
- Docker Compose: the bundled CLI uses `/home/codex/.codex`; its persistent model-state volume is mounted there. Use the same persisted volume when editing configuration. A host `~/.codex` is not automatically mounted.
- Shared app-server: configure and restart that daemon with its administrator. Restarting only the web application does not reload the shared daemon's configuration. An isolated CLI is recreated with the application.

这些是管理员操作，保存配置后在合适的维护时间重启实际 Codex 进程，再新建会话验证；不要为了切换模型删除 `auth.json` 或会话目录。现有会话可能仍绑定原来的 provider。设置变更不会自动迁移旧会话。

OpenAI's [custom provider configuration](https://learn.chatgpt.com/docs/config-file/config-advanced) describes `model_provider`, provider tables and `env_key`. The examples below use `wire_api = "responses"`; a Chat Completions-compatible URL alone is insufficient.

## 智谱 GLM Coding Plan

Use a key for the correct Coding Plan product; individual, team and standard API keys are not interchangeable. The Codex-specific endpoint differs from the usual Chat Completions endpoint. Follow the [official GLM Codex guide](https://docs.bigmodel.cn/cn/coding-plan/tool/codex) for current model availability and account eligibility.

1. Create an API Key in your 智谱编程套餐 account.
2. Write the following catalog to `models-glm.json` in the CLI's Codex home. It declares one GLM model and contains no credential.

```json
{
  "models": [
    {
      "slug": "glm-5.3",
      "display_name": "GLM-5.3",
      "description": "GLM coding model",
      "default_reasoning_level": "max",
      "supported_reasoning_levels": [
        { "effort": "low", "description": "Low" },
        { "effort": "high", "description": "High" },
        { "effort": "max", "description": "Max" }
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

3. Merge into `config.toml`. Replace the catalog path for a local installation; the example path is for our container. `env_key` refers to an environment variable, not the key itself.

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

4. Supply `ZHIPU_API_KEY` privately to the CLI process, then start `codex`. Confirm the selected provider/model and run a small coding task in a disposable folder. In PandaForce, create a new session and choose GLM from the model selector.

智谱需要同时配置端点、密钥和模型目录；只在模型选择框输入名称不等于完成接入。模型不可用或套餐不支持时，以智谱控制台和官方文档为准。

## Ollama

[Ollama's Codex guide](https://docs.ollama.com/integrations/codex) recommends tool-capable models and at least 64K context. Install Ollama, start its service, pull a model your hardware can run, then launch:

```bash
ollama pull gpt-oss:20b
codex --oss --local-provider ollama -m gpt-oss:20b
```

For a persistent PandaForce server configuration, use a custom provider ID:

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

Ollama must provide the Responses endpoint and the chosen model must support the required tools. Tune context using Ollama's model/server settings; sufficient RAM/VRAM is required. `ollama launch codex` is an alternative in Ollama versions that provide that command; inspect its generated configuration before using it with a server.

容器里的 `127.0.0.1` 是容器本身。Ollama 在宿主机时，改用可访问的宿主机地址；Docker Desktop 可用 `host.docker.internal`，Linux Compose 需要相应的 `host-gateway` 映射，或将两个服务放进同一网络。不要把无认证的 Ollama 端口直接暴露到公网。

## DeepSeek

DeepSeek now documents a native Responses API and [Codex integration](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/). Use a DeepSeek account API Key. Download/review the model catalog from that official guide, store it as `models-deepseek.json` in the runtime's Codex home, then use:

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

Pass `DEEPSEEK_API_KEY` to the CLI process. Select a model available to your account and matching your reviewed catalog. The endpoint here intentionally has no appended `/v1/chat/completions`. Do not assume every older DeepSeek model or compatible gateway supports Codex tools. See the [Responses API guide](https://api-docs.deepseek.com/guides/responses_api/) for protocol details.

## Pass secrets to Docker · 容器密钥传入

Compose does **not** pass arbitrary host environment variables into a container automatically. Add an override, for example for GLM:

```yaml
services:
  panda-force:
    environment:
      ZHIPU_API_KEY: ${ZHIPU_API_KEY:?Set ZHIPU_API_KEY privately}
```

Save this as `compose.provider.yml`, obtain the key via your secret manager or a private shell prompt, then recreate the service:

```bash
read -r -s -p 'Zhipu API key: ' ZHIPU_API_KEY
printf '\n'
export ZHIPU_API_KEY
docker compose -f docker-compose.yml -f compose.provider.yml up -d --no-build
```

This prompt is for Bash; Windows PowerShell needs its own secure-input/environment workflow. For DeepSeek replace the environment-variable name with `DEEPSEEK_API_KEY`. Avoid logging `docker compose config` or container environments containing secrets. Shared daemons need the secret in **their** environment, not just the web container's.

## Verify and troubleshoot · 验证与排错

| Symptom                                         | Check                                                                                                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model list still shows old models               | Confirm the CLI user, `CODEX_HOME`, absolute `model_catalog_json` path and file permissions; restart the actual app-server and create a new session. |
| Missing API key / 401                           | Confirm `env_key` is visible to the process, not just your interactive shell; check the provider account/key type.                                   |
| 404 / unsupported wire API                      | Use the provider's Responses base URL, not a Chat Completions URL; check CLI/provider versions.                                                      |
| Model is listed but tool calls fail             | Listing confirms metadata only. Verify Responses streaming, tool calls, model entitlement and context support with a small CLI task.                 |
| Ollama connection refused                       | Check container networking, service listen address and firewall from the CLI host/container.                                                         |
| Old sessions disappear after changing providers | Restore the previous config to inspect the previous provider's sessions. Do not delete the model-state volume.                                       |

CLI 验证成功后再测试 PandaForce 新会话，包括首轮回复、工具调用、右侧统计更新与重启后配置保留。不同模型可能不返回相同的用量字段，面板显示“未报告”不代表零用量。本文没有修改任何线上模型配置、密钥或共享 daemon。
