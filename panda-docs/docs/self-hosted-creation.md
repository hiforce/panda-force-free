---
title: Creation on a self-hosted instance
---

Administrators configure Harness access and rendering once for the instance. Users choose an available Harness, model and output type in **Create**. They can use the same setup from desktop and mobile.

## 1. Connect a Harness for Creation

Use a matching PandaForce image and Compose files from the same version. Start with [Installation](installation.md) and [Harness runtimes](harness-runtimes.md). A Harness that works in a conversation also needs to appear in the Creation picker before it can run a creation task.

<div className="base-image-table">

| Harness                    | Setup for Creation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Image generation                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Built-in Codex**         | Use the standard Compose service and complete the native login or configure a [Codex model provider](model-providers.md). You can also use the main [shared host Codex daemon](installation.md#use-codex-already-installed-on-the-host).                                                                                                                                                                                                                                                                    | Uses the selected Codex model with native image generation by default. You can set a dedicated `media.model`. |
| **Additional named Codex** | Set `PANDA_FORCE_CODEX_HARNESS_PROFILES` to register the daemon socket, or register a Codex socket with `PANDA_FORCE_HOST_HARNESS_PROFILES`. The application must be able to reach the socket and see the same absolute workspace paths.                                                                                                                                                                                                                                                                    | Use native image generation exposed by that runtime.                                                          |
| **Grok Build**             | Use `deploy/harness/docker-compose.grok.yml` and complete device login in `grok-auth`. If PandaForce launches the CLI directly, use `PANDA_FORCE_HARNESS_PROFILES` with the executable, private account home and optional credential socket.                                                                                                                                                                                                                                                                | Uses Grok Build’s native Imagine tool with an eligible signed-in account.                                                          |
| **ZCode**                  | Use `deploy/harness/docker-compose.zcode.yml` and set `PANDA_FORCE_ZCODE_PROVIDER_FILE` to your private provider JSON. For a local CLI launched by PandaForce, set `PANDA_FORCE_ZCODE_HARNESS_PROFILES` with `command`, `builtinConfig`, `providerConfig`, `providerId` and `model`. The provider and model IDs must match the provider file.                                                                                                                                                               | Configure the official ZCode image plugin on this profile. See the steps below.         |
| **Antigravity CLI**        | Use an image with `agy`, the `deploy/harness/docker-compose.antigravity.yml` overlay, and a dedicated Google account home at `PANDA_FORCE_ANTIGRAVITY_ACCOUNT_HOME_HOST`. Complete the native login in that home. If PandaForce launches the CLI locally, use `PANDA_FORCE_ANTIGRAVITY_HARNESS_PROFILES` with the signed-in `accountHome` and the CLI path if it differs from `/usr/local/bin/agy`.                                                                                                         | Use native image generation exposed by that runtime.                                                          |
| **Claude Code**            | Use `deploy/harness/docker-compose.claude-code.yml`, set `PANDA_FORCE_CLAUDE_CODE_TOOLS_HOST` to the CLI and ACP adapter directory, and set `PANDA_FORCE_CLAUDE_CODE_ACCOUNT_HOME_HOST` to the private signed-in account home. A local CLI launched by PandaForce uses `PANDA_FORCE_CLAUDE_CODE_HARNESS_PROFILES` with `command` (ACP adapter), `claudeCommand` and `accountHome`. A named Claude Code host socket can also serve Creation if its bridge and the application share an accessible workspace. | Use native image generation exposed by that runtime.                                                          |

</div>

Grok Build, ZCode and Antigravity profiles registered through the **host socket** setting `PANDA_FORCE_HOST_HARNESS_PROFILES` are conversation-only. For Creation, choose their Compose or application-launched CLI setup from the table. The checkout's `deploy/harness/README.md` contains complete profile examples and the CLI setup for your version.

For Compose, include your chosen overlay after the base file. This command starts ZCode after you set its provider path.

```bash
docker compose -f docker-compose.yml -f deploy/harness/docker-compose.zcode.yml up -d --no-build
```

Keep any overlays you already use. For a source installation, add a distinct `id` and `name` to each JSON profile and use executable and account paths visible to the service. For Antigravity, run `agy acp --login` under the configured account home. For Claude Code, run `claude auth login` with `HOME` set to `accountHome` and `CLAUDE_CONFIG_DIR` set to its `.claude` subdirectory. Run these sign-in commands as the service user.

In **Settings → Harness Runtimes**, add the installed profile if it does not already appear, enable it, check the connection and choose who can use it. Then go to **Create** and confirm that the intended runtime and model appear. For a member account, check the picker while signed in as that member.

## 2. Check requirements by output type

<div className="base-image-table">

| Output in Create | Requirements on the PandaForce instance                                                                                                                                                                                                                                                                        | Verify the saved work                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Document**     | A connected Creation Harness and writable application document storage. The model can create a PandaForce document without an image renderer.                                                                                                                                                                  | Open the saved editable document. PDF export and uploaded files are separate workflows. |
| **Image**        | The selected Harness must expose image generation in Creation. For the built-in Codex renderer, its provider and account must support native image generation.                                                                                                                                                 | Open the saved raster image and download the original file.                             |
| **Presentation** | Text slides use the built-in PowerPoint generator. To generate new illustrations for picture slides, also enable image generation for the selected runtime.                                                                                                                                                    | Download the editable `.pptx` and open it in a presentation editor.                     |
| **Video**        | The PandaForce service needs FFmpeg with the H.264 `libx264` encoder and `zoompan`, `concat` and `fade` filters, plus FFprobe and Fontconfig. The default font family is `Noto Sans CJK SC`. To generate new illustrations for scenes, also enable image generation for the selected runtime.                  | Play the saved silent motion-graphics `.mp4`.                                           |
| **Web page**     | The built-in HTML generator can save a self-contained page without an external website service. To add new AI-generated illustrations, also enable image generation for the selected runtime. The isolated online preview displays the page without running its scripts. The downloaded original retains them. | Open the saved preview and download the HTML original.                                  |

</div>

The standard runtime image supplies rendering dependencies. Check them where PandaForce runs, for example with `docker compose exec panda-force panda-tools doctor` and `docker compose exec panda-force panda-tools fonts`. For custom images, see [creative runtime bases](base-images.md). If your video tools are in a different location, set `PANDA_FORCE_CREATION_FFMPEG` and `PANDA_FORCE_CREATION_FFPROBE` to the absolute paths seen by the application, and set `PANDA_FORCE_CREATION_VIDEO_FONT_FAMILY` to an installed family if you use a different font.

## 3. Configure the built-in Codex image renderer

The optional `media.model` setting selects the renderer model on the built-in Codex connection. Creation uses this setting only for a task running on that built-in Harness. A named Codex connection or another Harness needs its own image capability.

First verify that your instance's **primary Codex connection** can actually generate an image with the intended model. A successful connection check or text reply confirms access to a model, while image generation needs a separate test. A custom provider used for coding may have different image support from its text API. In shared mode, the primary Codex daemon uses its own provider settings and account.

PandaForce has a built-in creation profile. To override its image model, put `creation-engines.json` in the application's persistent `$PANDA_FORCE_HOME/config/` directory. The standard Compose service uses `/var/lib/panda-force/config/creation-engines.json` **inside the container**. The file can also be mounted read-only at a different path and selected with `PANDA_FORCE_CREATION_CONFIG_FILE`.

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

Replace the placeholder with a model ID available to the primary Codex connection. The value selects the model that calls the native image tool. Use a model from the primary Codex catalog when the user selects the built-in Codex Harness. If you already have a creation profile file, add `media` to its default profile and keep the other entries. Keep provider keys in their existing private files, login stores or deployment secrets.

For a Compose-managed file, save the JSON in `./private/creation-engines.json` in your deployment directory and add this override. Make the file readable by the PandaForce service user.

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

Apply the override with `docker compose up -d --no-build`, including your original `-f` files and the new override in the command. If you edited the file in the persistent state directory directly, restart PandaForce so it reads the change. On Kubernetes, mount the file from a ConfigMap at a path readable by the container and roll the application pods. Keep provider credentials in a Secret or the engine's usual credential store.

## 4. Configure native Grok Build image generation

An application-launched Grok Build profile uses its signed-in account for the official Imagine tool. Finish the device login described above and grant users access to that runtime. In **Create**, select **Grok Build**, choose **Image**, and request an image from text. For a vertical illustration, specify `9:16`. After saving, open the work and download the original. This integration currently generates from text. [Grok Build Imagine command](https://docs.x.ai/build/modes-and-commands#core-tui-commands).

## 5. Configure native ZCode image generation

For an application-launched ZCode entry, the administrator installs the official `image-generation` plugin and signs in with the individual BigModel account that owns the eligible Coding Plan. Use the same account when Z.ai prompts you to sign in. Once ZCode returns a successful browser authorization, leave the CLI running until it completes. The Coding Plan API key in the provider file continues to serve model requests. [ZCode FAQ](https://zcode.z.ai/en/docs/qa) · [ZCode release notes](https://zcode.z.ai/en/changelog).

On the installation machine, run these commands as the service user. Replace the example home with a private persistent directory you control. For a container installation, run the preparation where the matching ZCode CLI is available, and mount the prepared directory in the application container. Use Node.js 20 or later, already supplied in the standard runtime.

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

This PandaForce integration accepts the reviewed plugin version `0.1.2` and the individual BigModel browser session. If the account session expires, repeat the native login in the same private directory. Keep the directory and its encrypted credential files private. In Compose, mount it read-only in the application and use the container-visible path. The login command needs a writable view of the same directory.

Add `"creationImageHome": "/absolute/path/visible/to/panda-force"` to the existing ZCode entry in `PANDA_FORCE_ZCODE_HARNESS_PROFILES`. Retain that entry's ID, command, provider and model settings. With Compose, set the full JSON array in an override after the ZCode overlay. Restart the application to load the updated profile, then choose the configured ZCode in **Create** and verify that a saved image can be downloaded. One optional reference image up to 10 MiB is supported per generation request.

## 6. Run a smoke test

Start new tests after a configuration change.

1. For each configured Harness, select it in **Create**, choose **Document** and ask for a short titled note. Open the saved work to verify that the task can write an output.
2. Choose **Image** and ask for a simple illustration, such as a blue circle on a white background. Verify the displayed image and download it. Repeat with each configured Harness that exposes its own image tool in Creation.
3. For the other types you plan to offer, save and open a two-slide deck, a short caption video and a one-section HTML page. Test generated illustrations separately if those workflows need them.

If the runtime is missing, check its profile, the selected deployment mode, its enabled status and your account's access. If text documents work and images are unavailable, check image support and account eligibility for the selected Harness. If video is missing, check FFmpeg, FFprobe and the configured font in the application runtime. If the configured file is missing or invalid, correct the path or JSON and restart the application before retrying.
