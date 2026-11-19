<p align="center">
  <img src="./panda-docs/static/img/readme-hero-en.svg" width="1200" alt="PandaForce — Small panda. Big ideas. Create with skills. Put Bots to work." />
</p>
<p align="center"><a href="./README-zh.md">简体中文</a> · <a href="#create-something-fun">Try a creation</a> · <a href="#meet-your-bot">Build a Bot</a> · <a href="#run-this-branch-from-source">Get started</a> · <a href="./panda-docs/docs/features.md">All features</a></p>

PandaForce is a self-hosted AI workspace with a friendly kung-fu panda at its heart. Create illustrations, slides, web pages and documents with skills. Put repeatable work behind a Bot API, and teach your panda new moves through skills and plugins.

> This page showcases the **develop source**. [Build this branch to try it →](#run-this-branch-from-source)

## Create something fun

### “Introduce Greek history—as a comic.”

Choose **Knowledge Illustration Brief** (`science-illustration`) in **Create**, ask for an image, and give it a subject:

> Introduce Greek history as an eight-panel comic, with a date, heading and one-line explanation in each panel. Use English labels and dialogue.

<p align="center">
  <a href="./panda-docs/static/img/greek-history-comic-en.png"><img src="./panda-docs/static/img/greek-history-comic-en.png" width="600" alt="An AI-created eight-panel English comic about Greek history, from the Aegean civilizations to the modern republic" /></a>
</p>

_An original AI-generated illustration created for this README. Click for the original PNG. Generated educational content should be reviewed before reuse._

Open the saved image to see the original, or keep refining the same creation:

> Make the dialogue more playful. Keep the timeline and use larger text.

The skill helps organize the story and visual brief. The configured model and rendering tools produce the image. Ask for the finished artifact: you should receive the actual image, rather than just a document describing what to draw.

You can use the same flow for “explain computer history as an illustrated timeline,” “turn these notes into slides,” or “make a landing page for this idea.” Follow-up edits stay connected through the creation identity, with the conversation and versions available together.

| What you want               | What you keep                                      |
| --------------------------- | -------------------------------------------------- |
| Illustration or infographic | An image preview and the original image file       |
| Presentation                | An editable PPTX and its available preview         |
| Web page                    | HTML source and an isolated web preview            |
| Motion graphic              | A silent MP4 made from supported visual scenes     |
| Writing or research         | An editable document and its sources when supplied |

Available output depends on configured model/tool capabilities. Video currently means **silent motion graphics**, not a general text-to-film service. Project documents can preview supported file types and offer original downloads for others.

<details>
<summary><strong>Explore the skills library, document editor and mobile view</strong></summary>

Screenshots below are freshly captured from the current source with fictional demo data. The skill library shows the current illustrated covers.

**A skill for your next creative move**

![PandaForce skills library, rendered with fictional demo data](./panda-docs/static/img/skills-en.webp?v=readme-20261119)

**A focused space for your words**

![PandaForce project document editor, rendered with fictional demo data](./panda-docs/static/img/documents-en.webp?v=readme-20261119)

**Keep creating on your phone**

<img src="./panda-docs/static/img/mobile-en.webp?v=readme-20261119" width="320" alt="PandaForce document reading on mobile" />

</details>

### Bring your own storage

Save originals locally, or configure **your own S3-compatible bucket** and select which content types use it—for example, generated images and videos. Thumbnails work without setting up image-processing rules in your bucket.

Private S3 originals use authenticated application authorization followed by **direct browser delivery through a temporary signed URL**. The file bytes travel from object storage to the browser. “Get image link” provides a reusable link with an expiry notice, valid for up to 24 hours; someone you share that link with can use it until expiry. Trash remains recoverable; permanent deletion cleans up the owned remote originals. [Storage guide →](./panda-docs/docs/storage.md#s3-compatible-storage-for-saved-originals-develop-source)

## Meet your Bot

A Bot is your panda with a particular job and personality. Give it a name, avatar, role, voice and working rules. A careful product editor and a curious research assistant can use different instructions and models while keeping their task queues separate.

### Set one up

1. Go to **Settings → Bot settings**, create a Bot and choose its model, avatar and personality.
2. Set a stable code, such as `catalog-panda`, and the instructions it should follow.
3. Issue a **Bot access key**, scoped to that Bot, with an expiry date. Store the one-time secret in your integration's secret manager.
4. Submit work from your application. Inspect the queue, evidence and results in **Bots**; uncertain tasks can ask for human review.

![Bot configuration and personality in the real application, with fictional demo data](./panda-docs/static/img/bot-usecase-config-en.webp)

### Submit, query, cancel

Set `PANDA_URL`, `BOT_CODE` and `BOT_KEY` to your installation and scoped key. Run these commands from the repository root with `curl` and `jq` installed:

```bash
export PANDA_URL="http://localhost:8899"
export BOT_CODE="catalog-panda"
# Set BOT_KEY from your secret manager. Do not commit it.

TASK_ID=$(curl --fail-with-body --silent --show-error \
  "$PANDA_URL/api/v1/bots/$BOT_CODE/tasks" \
  -H "Authorization: Bearer $BOT_KEY" \
  -H "Idempotency-Key: ITEM-001-v1" \
  -H "Content-Type: application/json" \
  --data-binary @examples/bots/quickstart/task.json | jq -er '.task.id')

curl --fail-with-body --silent --show-error \
  "$PANDA_URL/api/v1/bots/$BOT_CODE/tasks/$TASK_ID" \
  -H "Authorization: Bearer $BOT_KEY"

# Cancel queued/running work when it is no longer needed.
curl --fail-with-body --silent --show-error \
  "$PANDA_URL/api/v1/bots/$BOT_CODE/tasks/$TASK_ID/cancel" \
  -H "Authorization: Bearer $BOT_KEY" \
  -H "Content-Type: application/json" --data '{}'
```

New submissions return `202`; the same idempotency key and payload return the existing task. Save `task.id` and poll the query endpoint. Cancellation is idempotent for a canceled task; finished tasks and callbacks with uncertain/in-flight external effects return `409`. Canceling a task cannot undo an external action that already happened.

| API                                                 | Authentication                         |
| --------------------------------------------------- | -------------------------------------- |
| `POST /api/bots` — create a Bot                     | Signed-in application session + Origin |
| `PATCH /api/bots/:id` — configure it                | Signed-in application session + Origin |
| `POST /api/bots/keys` — issue a scoped key          | Signed-in application session + Origin |
| `POST /api/v1/bots/:code/tasks` — submit            | Bot key + `Idempotency-Key`            |
| `GET /api/v1/bots/:code/tasks/:id` — query          | Bot key                                |
| `POST /api/v1/bots/:code/tasks/:id/cancel` — cancel | Bot key, empty JSON object             |

**[Management API bootstrap, runnable payloads, states and integration details →](./panda-docs/docs/bot-api-quickstart.md)**

### A practical scenario: product content review

Your product system sends verified facts for `ITEM-001`. Catalog Panda drafts a description and selects `draft_ready`, or requests review when evidence is missing. Your application reads the result, presents it for approval, and saves or publishes through its own workflow. If the source item is withdrawn while the Bot is working, it cancels the task using the endpoint above.

For a larger workflow—supplier assets, a theme brief, product details, human review and publication receipts—see the **[complete integration walkthrough](./panda-docs/docs/bot-product-publishing.md)**. Callbacks execute only actions declared by your application, with allowed destination hosts. A model decision alone is not proof of publication.

The Bot-card home, a single persistent human conversation per Bot, and RSS/Slack/mail automations are being designed separately; they are not current capabilities of the task API shown here.

## Teach your panda new moves

- **Skills** package a repeatable method: instructions, resources and parameters for writing, research or visual creation. Browse, install and combine compatible skills instead of starting from an empty prompt each time.
- **Plugins and tools** add capabilities through supported extension contracts, with versioning and explicit access. A skill describes how to work; a configured tool performs the action.
- **Bots** put a chosen personality and working rules behind an integration API, with durable tasks, human review and recovery.
- **Projects and knowledge** keep source material, conversations, documents and saved artifacts connected so you can keep refining the work.

“Learning kung fu” means adding and improving these reusable capabilities—not silently retraining a model. Bring your own model credentials and enable the tools your workflow needs. [Skills](./panda-docs/docs/features.md#skills-and-skill-packages) · [Plugins](./panda-docs/docs/features.md#templates-themes-and-extensions) · [Model configuration](./panda-docs/docs/model-providers.md)

PandaForce also includes streaming AI conversations and coding, a terminal for administrators, rich-text documents, publishing adapters, source-based knowledge workflows and search. Desktop and mobile layouts support English, Simplified Chinese, Hong Kong Traditional Chinese and Taiwan Traditional Chinese. **[Explore all features and prerequisites →](./panda-docs/docs/features.md)**

## Run this branch from source

The execution engine today is **Codex app-server**. Published images such as `hiforceai/panda-force:0.0.21` have their own feature baseline and do not automatically include develop changes.

Requires Git and Docker with Compose. The documented image platform is Linux amd64. Codex CLI is included in the build/runtime images; no host Codex installation or host authentication-file mount is required.

```bash
git clone --branch develop https://github.com/hiforce/panda-force-free.git
cd panda-force-free
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
docker compose logs panda-force
```

Open **http://localhost:8899** and create your PandaForce administrator. Email is optional at initialization. Choose a password with at least six characters, including uppercase and lowercase letters and a number. If an installation code is requested, find it in the startup logs.

Sign in to the model account separately:

```bash
docker compose exec -it panda-force codex login --device-auth
docker compose restart panda-force
```

Follow the terminal link, refresh PandaForce and start a conversation. API-key and other model-provider configuration is described in the [model-provider guide](./panda-docs/docs/model-providers.md). PandaForce accounts and provider credentials are separate; provider charges follow the provider's terms.

Configure SMTP in administration before binding an email, inviting members or using email recovery. Members set their own passwords. Administrators retain access to the shared host workspace and engine; ordinary members use their authorized business content. This shared-engine installation is not an untrusted multi-user coding sandbox.

Source packaging defaults to compilation and packaging checks. Run `bun run check` and the affected behavior checks independently during development; a completed image build is not a full product regression result.

## Use a published image

For the existing published release, clone the default branch and run `docker compose up -d`; its current template selects **`hiforceai/panda-force:0.0.21`**. Consult that release's documentation rather than assuming feature parity with develop.

State, model credentials, attachments and workspace files persist in Docker volumes across container restarts. `docker compose down` keeps those volumes. The default port is accessible only from the local machine. See [installation](./panda-docs/docs/installation.md) for remote access and [storage](./panda-docs/docs/storage.md) for mounts and backups.

## Optional services and configuration

| Need                                        | Where to start                                                                                                                                                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing Codex on the host                  | [Shared-mode installation](./panda-docs/docs/installation.md#use-codex-already-installed-on-the-host); mount the service socket and workspace, not just authentication files.                                                                      |
| Persistent project folders                  | [Storage](./panda-docs/docs/storage.md); `PANDA_FORCE_PROJECTS_ROOT` sets the root, and `PANDA_FORCE_ALLOW_EXTERNAL_DIRECTORIES=false` limits directory/session browsing to it.                                                                    |
| Website builds, document previews or search | Use the relevant `docker-compose.documents.yml`, `docker-compose.previews.yml` and `docker-compose.search.yml` overlays and configure the corresponding services.                                                                                  |
| Your own registry                           | Override images/pull policies; supply separately managed credentials with `docker-compose.documents.registry.yml` when required.                                                                                                                   |
| Your own S3-compatible CDN                  | [CDN build guide](./panda-docs/docs/cdn-build.md); preserve your bucket, prefix, region, optional endpoint, viewer URL and separate credential file. Static assets default to this application; APIs/authentication stay here when CDN is enabled. |
| Kubernetes or multiple instances            | [Kubernetes templates](./panda-docs/docs/kubernetes.md) and [cluster configuration](./panda-docs/docs/cluster.md). Kubernetes is optional.                                                                                                         |

## Support

[![Buy me a coffee](./panda-docs/static/img/buy-me-a-coffee.svg)](https://buymeacoffee.com/hiforce)

If PandaForce helps you, consider supporting Rocky's work. Contributions are voluntary and do not include an SLA, priority support, or a guaranteed response or fix deadline.

## License and acknowledgements

[MIT](./LICENSE), free for personal and commercial use, modifications and forks. Hosting, models, storage and external platforms may charge separately. Maintenance is best effort. [Third-party notices](./THIRD_PARTY_NOTICES.md).

PandaForce Free is derived from the MIT-licensed [lezi-fun/codex-webui](https://github.com/lezi-fun/codex-webui). Thank you to lezi-fun and all upstream contributors. The original copyright and MIT license are preserved in [LICENSE](./LICENSE) and [LICENSES/upstream-MIT.txt](./LICENSES/upstream-MIT.txt). PandaForce is developed independently; upstream attribution does not imply endorsement.
