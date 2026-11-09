---
title: Model providers
---

PandaForce executes models through Codex CLI on the server. Configure that CLI before choosing a model in the browser. Website sign-in and model-provider authentication are separate. This guide covers Zhipu GLM, Ollama and DeepSeek. Run `codex --version` in the execution environment to check its CLI version.

## Configuration directory

`CODEX_HOME` is the absolute path to the directory containing Codex configuration, credentials and session state. The standard container uses:

```text
CODEX_HOME=/home/codex/.codex
Configuration file: /home/codex/.codex/config.toml
Model catalog: /home/codex/.codex/models-glm.json
```

Save `config.toml` directly in this directory. If `CODEX_HOME` is unset, Codex uses the running user's `~/.codex` (`%USERPROFILE%\.codex` on Windows). Use an explicit absolute path for services and containers.

| Setting                              | Purpose                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| CLI executable and `PATH`            | Select the CLI program that runs.                                             |
| `PANDA_FORCE_CWD` and session folder | Select where tasks read and edit project files.                               |
| `PANDA_FORCE_PROJECTS_ROOT`          | Select where new project folders are created.                                 |
| `HOME`                               | The user home inherited by an isolated CLI; relevant to paths containing `~`. |
| `CODEX_HOME`                         | Select the configuration, credentials, catalogs and session-state directory.  |

Configure the working folder and Codex state directory independently. Back up existing configuration before editing. Put root TOML settings before provider tables; merge tables without duplicating their names. Prefer absolute catalog paths as seen by the CLI process.

## Choose your deployment arrangement

### Local CLI

Run Codex under the same account and environment used to start PandaForce. Store configuration in that account's Codex state directory and set the project working folder separately. For example, a service account can use `CODEX_HOME=/home/alex/.codex` while projects live under `/srv/projects`.

Give the execution account read access to configuration and catalogs, and write access to its session state. Project subfolders reuse this user-level configuration.

### Isolated CLI in a container

The standard Compose installation mounts a persistent model-state volume at `/home/codex/.codex` and sets `CODEX_HOME` to that path. Create `config.toml` and the referenced catalogs in this volume. Supply authentication through the selected provider's environment variables or the CLI login process.

Match state-directory ownership to the container UID. Use directory mode `0700` and mode `0600` for credential-bearing files. Keep the state directory writable so Codex can persist sessions.

### Provide persistent configuration to containers

Choose one configuration source for the container:

- **Existing host directory:** explicitly bind-mount an absolute directory on the Docker daemon host. `CODEX_HOME` names the destination inside the container, not the host source.
- **Independent engine state:** use the standard named volume or a Kubernetes PVC. Initialize configuration and authentication in that storage before creating a conversation.
- **Shared host engine:** leave provider credentials with that engine; mount/connect its socket and matching workspace instead.

For an existing configuration, a Compose override can use:

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

`source` is the absolute directory on the Docker daemon host; `target` is its path inside the container. Prepare `/srv/codex-state` with the intended `config.toml`, catalogs and required authentication material before starting the service. Ensure the container UID can write session state. For a remote Docker daemon, prepare the source directory on the remote host.

For Kubernetes, mount persistent state and inject provider credentials from a Secret:

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

Add this fragment to your Pod specification, or under `spec.template` in a Deployment. Create the referenced PVC and Secret before rollout; adapt the UID and storage policy to the image and cluster. Put `config.toml` and referenced catalogs into the PVC using an administrator-controlled initialization Job or mount non-secret files individually from a ConfigMap. Supply provider keys from Secrets. Keep `CODEX_HOME` on writable storage; mount read-only configuration files individually and supply credentials at runtime. If using `hostPath`, prepare the directory on the selected cluster node and configure matching node scheduling and permissions.

### Shared host daemon

The host daemon reads model configuration and credentials. The web container connects through its socket. Changing only the web container's `HOME` or `CODEX_HOME` does not reconfigure a running daemon. Ensure the socket is accessible and task workspace paths correspond on both sides. Follow the [shared-engine installation guide](installation.md#use-codex-already-installed-on-the-host).

After editing configuration, restart the actual engine during an appropriate maintenance window, then create a new session. Restarting the web application alone does not reload an external daemon. Preserve authentication files and session state when switching providers. Existing sessions may remain associated with their original provider.

## Zhipu GLM

Use the API Key for your Coding Plan product; individual, team and standard API keys are separate. Check model entitlement and current metadata in the [official GLM Codex guide](https://docs.bigmodel.cn/cn/coding-plan/tool/codex). Codex uses the dedicated Responses endpoint rather than the usual Chat Completions URL.

1. Obtain your Coding Plan key.
2. Save this catalog as `models-glm.json` directly inside `CODEX_HOME`:

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

3. Merge these settings into `config.toml`. The example catalog path is for the standard container; replace it for another layout. `env_key` names an environment variable, not the key value.

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

4. Pass `ZHIPU_API_KEY` privately to the actual CLI process. Start `codex`, check the provider and model, and run a small task in a disposable folder. Then create a PandaForce session and select GLM.

Complete the endpoint, key and catalog configuration before selecting the model. See OpenAI's [custom-provider configuration](https://learn.chatgpt.com/docs/config-file/config-advanced) for provider settings. These examples use `wire_api = "responses"`; Chat Completions compatibility alone is insufficient.

## Ollama

Install and start Ollama, then pull a tool-capable model that fits your hardware. The [official Codex guide](https://docs.ollama.com/integrations/codex) recommends at least 64K context.

```bash
ollama pull gpt-oss:20b
codex --oss --local-provider ollama -m gpt-oss:20b
```

For a persistent server configuration:

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

Ensure Ollama supports the Responses endpoint and tune the model's context in Ollama. Available RAM/VRAM limits model and context size. `ollama launch codex` is another option on versions that include that command; review its generated configuration before applying it to a server.

Inside a container, `127.0.0.1` refers to that container. To reach a host service, use an accessible host address. Docker Desktop provides `host.docker.internal`; Linux Compose may require a `host-gateway` mapping. Alternatively, put both services on one container network. Keep an unauthenticated Ollama port off the public internet.

## DeepSeek

Use a DeepSeek API Key. Review the catalog in the [official Codex integration guide](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/), save it as `models-deepseek.json` inside `CODEX_HOME`, and configure:

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

Pass `DEEPSEEK_API_KEY` to the CLI process. Match the model to your account and catalog. The base URL intentionally has no `/v1/chat/completions` suffix. Verify tool support for the selected model or gateway; see the [Responses API guide](https://api-docs.deepseek.com/guides/responses_api/).

## Pass keys to containers

Compose does not automatically forward arbitrary host variables. Save this override as `compose.provider.yml`:

```yaml
services:
  panda-force:
    environment:
      ZHIPU_API_KEY: ${ZHIPU_API_KEY:?Set ZHIPU_API_KEY privately}
```

Obtain the key from your secret manager or use this Bash prompt, then recreate the service:

```bash
read -r -s -p 'Zhipu API key: ' ZHIPU_API_KEY
printf '\n'
export ZHIPU_API_KEY
docker compose -f docker-compose.yml -f compose.provider.yml up -d --no-build
```

PowerShell needs its own secure-input workflow. For DeepSeek, substitute `DEEPSEEK_API_KEY`. Do not log rendered Compose configuration or container environments containing secrets. A shared daemon needs the key in its own environment, not merely in the web container.

## Verification and troubleshooting

| Symptom                                            | Check                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Old model list                                     | Runtime user, `CODEX_HOME`, absolute catalog path and permissions; restart the actual engine and create a session. |
| Missing key or 401                                 | The environment of the CLI/daemon, provider key type and entitlement.                                              |
| 404 or unsupported protocol                        | The Responses base URL and supported CLI/provider versions.                                                        |
| Listed model cannot send or call tools             | Listing confirms metadata only. Test streaming, tools and context with a small CLI task.                           |
| Ollama connection refused                          | Network address from the CLI container, listen address and firewall.                                               |
| Older sessions disappear after switching providers | Restore the previous configuration to inspect its sessions; keep the persistent model-state volume.                |

First verify the CLI from the workspace root and a project subfolder. Then test a new PandaForce session: initial reply, tool call, live inspector update and configuration persistence after restart. Some models omit usage fields; “not reported” does not mean zero usage.
