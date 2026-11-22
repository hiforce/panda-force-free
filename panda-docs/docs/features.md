---
title: Feature catalog
---

# Feature catalog

This catalog describes PandaForce 0.1.4. Use the matching release image and configuration files. Screenshots use fictional demonstration content.

[简体中文](https://github.com/hiforce/panda-force-free/blob/main/panda-docs/i18n/zh-Hans/docusaurus-plugin-content-docs/current/features.md) · [README](https://github.com/hiforce/panda-force-free/tree/main#readme) · [Installation](./installation.md)

Most workspace/document capabilities are built in. AI operations need a configured Harness Runtime and its model account; email needs SMTP; website builds, screenshots and optional search need the corresponding services. Sections below explicitly call out partial or unimplemented coverage.

## Workspace and navigation

- One workspace for conversations, projects, creation, skills, publishing and Bots.
- Start from a natural-language prompt; attach files and images or choose a project before submitting.
- Search and filter conversations by status, project and working directory; pin frequently used projects.
- Resize the desktop sidebar with the pointer or keyboard; remember navigation, drafts and reading-width preferences.
- Use responsive desktop and mobile layouts, mobile drawers, keyboard navigation, light/dark appearance and selectable themes.
- Switch among English, Simplified Chinese, Hong Kong Traditional Chinese and Taiwan Traditional Chinese; user and engine content keeps its original language.

## Customizable home and Gadgets

- Customize the home board with built-in creation, recent-work, project and skill Gadgets.
- Add/remove Gadgets, change their configuration, resize/reorder the layout and save the board.
- Keep a composer draft while changing the layout; recover from unsaved changes and supported layout conflicts.
- Use supported Gadget extensions with declared capabilities and isolated frames; extension content does not gain arbitrary host access.
- Use the supplied Gadget SDK/build inputs for compatible extensions; this is separate from the unfinished general publishing-channel SDK.

## AI conversations and coding

- Use Codex app-server through an instance-owned isolated process or an explicitly connected shared host service.
- Select models and supported reasoning settings from the configured engine; keep model authentication separate from PandaForce accounts.
- Stream replies and inspect reasoning summaries, tool activity, command output, file changes and execution status when supplied by the engine.
- Review command/file approvals and answer structured questions without leaving the conversation.
- Queue messages, stop work, resume supported sessions, manage concurrent conversations and inspect usage.
- Load older conversation history in pages. Shared-mode polling coalesces reads and reuses unchanged pages instead of scanning whole journals.
- Use goal and token-budget controls when supported by the connected Codex engine. Automatic extra continuation is restricted and disabled by default.
- Use native command/skill autocomplete, attachment paste and conversation-specific composer history where the engine supports them.
- Browse files/changes, open a terminal or connected browser panel, and inspect side tasks through session tools.
- Search session tools and pin/reorder up to three shortcuts; keep session notes and checklists locally in the browser.
- Switch reading width/focus mode, inspect precise token usage and keep pending approvals visible while navigating.

## Projects and workspace files

- Create real persistent workspace folders from project codes; new project conversations use the project folder.
- Associate existing conversations with a project without silently moving their original working directories.
- Keep project documents, creative assets, conversation history, source connections and publication work together.
- Browse permitted directories and preview text/code, images and supported document formats; download generated files and attachments.
- Use the integrated terminal and engine working-directory controls where the signed-in account is authorized.
- Administrators can restrict directory browsing to a configured project root and configure persistent workspace/document/attachment storage.

## Personal creation and reusable assets

- Keep personal documents, images, videos, editable PPTX presentations, web pages and imported files in the creation center, separate from independent project copies.
- Create a blank document directly or request an AI draft with selected skills and source context.
- Inspect durable creation-job progress, questions, errors and actual result links; reopen results for further editing.
- Copy a personal work into selected projects as independent content; edit one copy without silently overwriting others.
- Generate actual images through the configured Codex native image capability, editable PPTX presentations, self-contained HTML pages and silent motion-graphics MP4 video. Missing capabilities report an error instead of substituting a planning document.
- Continue supported edits from the authorized saved original. Videos combine captions and permitted images; generated footage, narration and music are not provided by this renderer. PPTX has a text preview and an editable original download; it is not a full browser Office editor.
- Open images, video, audio, PDF and text in supported native viewers, inspect isolated static HTML previews and download other original formats from the project document directory.

## Document organization and editing

- Organize documents as a hierarchy; create child documents, reorder or move nodes, search the tree and follow breadcrumbs.
- Read first, then enter a focused editor; mobile reading and editing have separate layouts.
- Edit rich text with headings, emphasis, lists, links, quotations, images, tables and code blocks.
- Use floating selection formatting, block actions, an insertion menu and language-aware code-block controls.
- Autosave drafts, show save state, preserve local recovery state and detect conflicting edits.
- Inspect revisions/checkpoints, restore saved content and use the project file/Git-backed document path where configured.
- Trash and restore documents/subtrees while keeping document and asset ownership boundaries.
- Store document images separately, reuse historical references and import supported source assets.

## AI editing and language variants

- Continue AI work on an existing document instead of creating an unrelated replacement.
- Request proofreading, formatting, rewriting, summaries and translation as distinct operations.
- Choose processing scope and review suggested changes individually before applying them to the source.
- Keep the original protected while processing; show job progress, actionable failure and retry controls.
- Link language variants and reuse project source context for supported generation and review workflows.

## Skills and skill packages

- Browse built-in and installed skills by category, search, cover, publisher, version and license.
- Install supported JSON/ZIP packages or select packages discovered from a GitHub source; inspect provenance and requested capabilities before approval.
- Select exports from a multi-skill package, grant explicit capabilities and independently enable/disable installed exports.
- Choose only currently usable skills in conversation and creation pickers; inactive, removed, disabled, unapproved or unsupported entitled versions are omitted.
- Keep unavailable versions inspectable in management and version/history views without offering them as usable choices.
- Compose several skills in an explicit order, configure parameters and preserve selections when returning from details.
- Review upgrades, switch supported versions, roll back or uninstall packages; installed package content is not rewritten for localization.

## Templates, themes and extensions

- Manage available document, slide, web and site-theme template types from a common template interface.
- Inspect template metadata, source, license, versions and cover previews before use.
- Import/export supported template JSON or ZIP bundles and discover compatible packages from repositories.
- Generate site-theme sample home/article/mobile previews through the configured build and preview services; retain cached results.
- Use supported native themes/slide imports and extension permissions. A universal third-party channel-plugin SDK and a skill marketplace are not finished.

## Source connections and content ingestion

- Connect supported existing Markdown/Hexo/Docusaurus content with source inspection and import profiles.
- Keep connected originals read-only during import; bring selected content and images into managed document workflows.
- Inspect source files and their provenance before using them as AI context.
- Use local/SFTP and supported account connections where implemented; credentials and publishing destinations are administrator-configured.

## Search and knowledge workflows

- Search accessible project documents/content and distinguish keyword, semantic or combined modes when a backend supports them.
- Start without an external search service; optionally configure Elasticsearch and vector-search services using the supplied deployment options.
- Inspect search/indexing status, rebuild supported indexes and follow meaningful progress or errors.
- Configure project knowledge rules over selected source content; generate drafts with source evidence and an independent review step.
- Track durable knowledge jobs, review claims/uncertainties and retain source-version references instead of treating generated claims as original facts.

## Website building and publishing

- Associate a document/source space with more than one website target without rewriting its saved original.
- Build supported Hexo/Docusaurus sites through separately configured executors; inspect build progress, logs, artifacts and previews.
- Configure themes and content mappings; inspect supported format conversions and warnings before publication.
- Publish to configured local destinations with owned-artifact/atomic-update controls; supported SFTP flows require trust/fingerprint verification.
- Inspect previous runs, cancel supported work and use rollback/retention controls where the target adapter provides them.
- Export supported source, HTML, plain text and asset bundles when direct publishing is unnecessary.

## Social publishing and handoff

- Keep X Post, a thread composed of Posts, and X Article as distinct content/publication types.
- Prepare supported channel variants and previews; review losses or unsupported formatting rather than silently changing the source.
- Use implemented X OAuth/account and publication flows only after configuring the application and satisfying provider permissions/eligibility. Coverage is partial.
- Keep callback/unknown-outcome handling and manual handoff visible; unsupported channels can use exported content.
- Automatic scheduling with timezone/DST recovery, a general channel SDK, and complete WeChat/Toutiao direct publishing are not included in this branch.

## Bots and external task automation

Explore the [anonymous product-publishing use case](https://github.com/hiforce/panda-force-free/blob/main/panda-docs/docs/bot-product-publishing.md), including Bot configuration, scoped caller keys and enterprise-system integration.

- Create Bots with instructions, name/code, avatar and persona; enable or pause them independently.
- Issue and revoke Bot access keys for external callers; keep Bot sessions distinct from interactive conversations.
- Accept idempotent external task submissions into a durable queue and inspect queued/running/review/completed/error states.
- Let task submissions declare business actions and callbacks; preserve compatibility with existing task callers.
- Review AI decisions and evidence, provide a manual response and retry failed callback delivery.
- Use task text first and request image evidence when necessary; failed required image reads lead to review rather than an unsupported final action.
- Inspect chronological task events, filter/search the queue and configure supported retention, model and callback-host settings.

## Local accounts and email recovery

- Initialize an administrator with a username and password; an email address is not required at installation.
- Configure SMTP first, then verify/bind an email address; SMTP credentials are managed by the administrator.
- Invite members by email. Recipients set their own passwords; administrators do not assign member passwords.
- Manage account roles/status. Ordinary members work with authorized business content; host terminals, host file browsing and shared Codex sessions remain administrator-only.
- Recover passwords with six-digit email codes and a 60-second server-enforced resend cooldown; then proceed to the new-password screen.
- Do not send recovery codes for nonexistent/inactive/disabled accounts. Successful reset invalidates old credentials and sessions.
- Dedicated legacy IDaaS login has been removed. Generic OIDC, Google/Slack login and organization-directory synchronization are not part of the local-account implementation.

## Storage, databases and administration

- Persist product state, engine state, workspaces and attachments in separately configurable locations/volumes.
- Choose SQLite or an external MySQL database for application-owned business records during setup; inspect selected database status in settings.
- Use registered module schema migrations, prerequisite checks, backups and controlled migration/cutover workflows. File assets and engine journals are separate from business database records.
- Administrators can select S3-compatible storage for new creative originals by file type, independently of static CDN settings. Originals remain behind application authentication; existing files keep their saved provider. Trash retains files for recovery, while permanent deletion queues exact-version cleanup and durable retries. See [original storage](./storage.md#s3-compatible-storage-for-saved-originals).
- Keep credentials, encrypted connection data, application logs and administrator settings out of public source snapshots.
- Configure supported optional search, preview, build, attachment-storage and cluster services without making Kubernetes a prerequisite for ordinary installation.

## Installation, builds and CDN

- Install with Docker/Compose using `hiforceai/panda-force:0.1.4`; the Rocky Linux 9 image includes Codex CLI, Grok Build, ZCode CLI and the creative toolchain. Linux amd64 is the documented image target.
- Use the matching release configuration. Source contributions and custom builds are covered in the [development guide](building.md).
- Use independently configured build/preview executors and optional Compose overlays for documents, search and previews.
- Override images, registry credentials and pull policies, including private registries, without placing credentials in application source.
- Load static assets from the application origin by default. Enable CDN builds only with your own S3-compatible bucket/prefix, region, optional endpoint, viewer URL and separate credential file.
- CDN mode covers shared HTTP helpers and lazy modules as well as entry bundles; APIs and authentication stay on the application origin.
- Application packaging defaults to compilation/packaging checks. Run source and affected behavior checks independently; do not treat a build as full regression proof.

## Security boundary and current limits

- A shared host execution engine is an administrative trust boundary, not an untrusted multi-user code sandbox. Path filtering alone does not isolate arbitrary code or hide a host API key.
- Ordinary members can use implemented authorized content workflows; unrestricted member coding in personal sandboxes with a credential-hiding model gateway is not implemented.
- Enterprise provider setup, member quotas, sandbox auto-provisioning, delegated access keys and metered billing remain design work, not shipped features.
- Provider/network/platform restrictions still apply. Optional connectors need the operator’s own accounts, credentials and services.
- MIT licensing permits commercial use; hosting/model/storage/platform charges are separate. Maintenance is best effort without an SLA.
