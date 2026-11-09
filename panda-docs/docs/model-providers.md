---
title: Model providers
---

PandaForce executes models through Codex CLI on the server. Configure that CLI before choosing a model in the browser. Website sign-in and model-provider authentication are separate. This guide covers Zhipu GLM, Ollama and DeepSeek. Provider documentation was reviewed on 2026-11-09; the released image includes Codex CLI 0.166.0. Check the actual runtime with `codex --version`.

The examples were checked for configuration syntax. Paid model requests have not been verified with a live account key.

## Configuration directory

**`CODEX_HOME` points directly to the Codex state directory, conventionally named `.codex`. It is not its parent directory.** For example:

```text
CODEX_HOME=/home/panda/.codex
Configuration file: /home/panda/.codex/config.toml
Model catalog: /home/panda/.codex/models-glm.json
```

Do not create `/home/panda/.codex/.codex/config.toml`. If `CODEX_HOME` is unset, Codex defaults to the running user's `~/.codex` (`%USERPROFILE%\.codex` on Windows). The spelling is `CODEX_HOME`, not `CODEX_HOMO`. An explicit `CODEX_HOME` can name another directory; `.codex` is the convention, not a required literal directory name.

| Setting                              | Purpose                                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| CLI executable and `PATH`            | Select the program that runs. Installing it as root does not select root's configuration for other users. |
| `PANDA_FORCE_CWD` and session folder | Select where tasks read and edit project files.                                                           |
| `PANDA_FORCE_PROJECTS_ROOT`          | Select where new project folders are created.                                                             |
| `HOME`                               | The user home inherited by an isolated CLI; relevant to paths containing `~`.                             |
| `CODEX_HOME`                         | Select the configuration, credentials, catalogs and session-state directory.                              |

Changing a working folder does not move or select Codex configuration. Back up existing configuration before editing. Put root TOML settings before provider tables; merge tables without duplicating their names. Prefer absolute catalog paths as seen by the CLI process.

## Choose your deployment arrangement

### Local CLI

Use the environment and account that actually start Codex. A host CLI running as root may use `HOME=/root`, `CODEX_HOME=/root/.codex` and a working folder of `/home/panda`; those paths do not have to share a parent. Another user may not be able to read root's directory. Verify from both the workspace root and a newly created project folder. Project subfolders should use the same user-level configuration without separate credential copies.

### Isolated CLI in a container

The standard Compose installation mounts a persistent model-state volume at `/home/codex/.codex`. Its `CODEX_HOME` points there. Edit the configuration in that volume. A host `/root/.codex` is not automatically present or readable in the container.

An alternative persistent layout mounts the workspace at `/home/panda` inside the container and uses:

```text
HOME=/home/panda
CODEX_HOME=/home/panda/.codex
PANDA_FORCE_CWD=/home/panda
PANDA_FORCE_PROJECTS_ROOT=/home/panda
```

Then provide `/home/panda/.codex/config.toml` and every file it references. For example, `model_catalog_json` must identify an existing catalog inside the container. Match ownership to the container UID; use directory mode `0700` and file mode `0600` for credential-bearing files. Do not weaken permissions on host root credentials to work around container isolation.

### Docker and Kubernetes do not discover host configuration

A container cannot discover or read the browser user's or host user's `~/.codex` automatically. Choose how an administrator supplies state:

- **Existing host directory:** explicitly bind-mount an absolute directory on the Docker daemon host. `CODEX_HOME` names the destination inside the container, not the host source.
- **Independent engine state:** use the standard named volume or a Kubernetes PVC, and initialize configuration and authentication inside that persistent state. An empty volume does not contain your host login.
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

`/srv/codex-state` is an example, not an auto-created copy of `~/.codex`. Prepare it on the Docker daemon host with the intended `config.toml`, catalogs and required authentication material. Ensure the container UID can write session state. With a remote Docker daemon, a path on your laptop is not a path on that host.

Kubernetes has no access to the operator's laptop home. A generic PVC arrangement is:

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

This is a Pod-spec fragment, not a full Deployment. Supply the PVC, Secret and initialization workflow yourself; adapt the UID and storage policy to the image and cluster. Put `config.toml` and referenced catalogs into the PVC using an administrator-controlled initialization Job or mount non-secret files individually from a ConfigMap. Supply provider keys from Secrets. Do not mount a read-only Secret over the entire writable `CODEX_HOME`. Do not bake credentials into images. A `hostPath` refers to a particular cluster node and requires matching node scheduling and permissions; it is not a portable way to access a user's home.

### Shared host daemon

The host daemon reads model configuration and credentials. The web container connects through its socket. Changing only the web container's `HOME` or `CODEX_HOME` does not reconfigure a running daemon. Ensure the socket is accessible and task workspace paths correspond on both sides. Follow the [shared-engine installation guide](installation.md#use-codex-already-installed-on-the-host).

After editing configuration, restart the actual engine during an appropriate maintenance window, then create a new session. Restarting the web application alone does not reload an external daemon. Do not delete `auth.json` or session directories to switch providers; existing sessions may remain associated with their original provider.

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

Selecting a model name alone does not configure its endpoint, key or catalog. See OpenAI's [custom-provider configuration](https://learn.chatgpt.com/docs/config-file/config-advanced) for provider settings. These examples use `wire_api = "responses"`; Chat Completions compatibility alone is insufficient.

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

First verify the CLI from the workspace root and a project subfolder. Then test a new PandaForce session: initial reply, tool call, live inspector update and configuration persistence after restart. Some models omit usage fields; “not reported” does not mean zero usage. This guide does not change your live configuration, credentials or daemon.
