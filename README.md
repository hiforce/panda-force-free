# PandaForce Free

**A free, MIT-licensed snapshot of PandaForce with best-effort community maintenance and no SLA commitments. Free to use, modify, and fork, including commercially.**

[License](./LICENSE) · [Upstream project](https://github.com/lezi-fun/codex-webui)

> **Repository status:** Initial setup. This repository currently contains the license and this README; the application source snapshot has not yet been published. There is no installable release or release tag yet. The maintenance policy below applies to the free snapshot when it is published.

## About

PandaForce is a browser-based AI workspace that brings projects, conversations, CLI sessions, approvals, and workspace tools together. Its current implementation connects to the Codex app-server. Claude CLI and other execution engines are not currently integrated.

PandaForce Free is intended to preserve a fixed historical version of that workspace. It is a community snapshot with best-effort maintenance, without a guaranteed update schedule or SLA.

The planned snapshot is based on a codebase that includes:

- Projects with names, unique codes, and optional descriptions; native conversations can be associated with projects independently of working folders.
- Shared Codex CLI sessions, streaming responses, model settings, and tool activity.
- Command and file-change approvals, native question forms, and change review.
- Image and file attachments, including clipboard image uploads.
- Workspace file browsing, source previews, and a terminal.
- First-run administrator setup, workspace preparation progress, and responsive layouts with English and Simplified Chinese support.

The exact snapshot commit, included features, verified dependencies, and installation instructions will be recorded with the source release. This list is not a claim that runnable application files are already present in this repository.

## Free to use, including commercially

The applicable MIT license permits use, modification, distribution, and commercial use, subject to its conditions. Retain the required copyright and license notices when redistributing the software or substantial portions of it.

For this free snapshot:

- There is no PandaForce usage fee or project-value threshold.
- Commercial projects may use it without purchasing PandaForce support.
- You may fork it, modify it, and maintain your own version under the applicable license terms.
- Your own changes or continued maintenance of a fork do not create a PandaForce fee.
- You do not need a paid license for another PandaForce edition merely to exercise this snapshot's MIT rights.

Third-party components and assets retain their own applicable terms. MIT does not grant rights to third-party trademarks or materials outside its scope. Original upstream notices and the applicable third-party notices must accompany the published source snapshot.

Free software does not mean free model access, API usage, cloud storage, hosting, or other third-party services. Those may require your own accounts and incur their own charges.

## Maintenance policy

**Maintenance is best effort, with no SLA, guaranteed response time, or fix deadline.**

The maintainer may review issues, publish updates, or accept fixes as time and priorities allow. This is not a declaration that maintenance has stopped, and it is not a promise of ongoing or scheduled maintenance.

There is no commitment to provide:

- New features or dependency updates.
- Compatibility fixes for future CLI, model-provider, browser, or operating-system changes.
- Security monitoring, vulnerability fixes, or backports.
- Issue responses, personal troubleshooting, or resolution deadlines.
- Deployment assistance, a service-level agreement, or continuing technical support.

Others are welcome to maintain their own forks in accordance with the applicable licenses. A separately maintained fork must not imply official maintenance or endorsement by the PandaForce maintainer.

Review the code, dependencies, and operational risks before deploying a historical version, particularly on a public network. Do not assume a reported vulnerability will receive a response or a fix.

Any separately commissioned engineering or support work requires its own agreement. It is a service purchase, not a fee for rights already granted by this snapshot's MIT license.

## Installation and releases

Application source and installation instructions are not available in this repository yet. Please do not expect a working application from cloning it at this stage.

The source release will identify the exact snapshot commit and tag, tested tool versions, setup instructions, operational boundaries, and third-party notices. No release date or ongoing release schedule is promised.

## Origin and acknowledgements

PandaForce derives from **[lezi-fun/codex-webui](https://github.com/lezi-fun/codex-webui)**, an MIT-licensed community project. Thank you to **lezi-fun and the upstream contributors** for the foundation.

PandaForce development adds its own project/session model, installation and identity flows, workspace preparation, interface and protocol improvements, deployment integration, and refactoring. These additions do not erase the original authors' copyright or applicable licenses.

The original upstream copyright and MIT license text will be retained with the application source snapshot. Acknowledgements and links do not replace required license notices.

PandaForce is independent of OpenAI and Anthropic and is not an official product of either company. Product names and trademarks belong to their respective owners.

## License

See [LICENSE](./LICENSE) for the repository's current MIT license. The software is supplied without the warranties excluded by that license. Separately licensed third-party material remains subject to its own terms.
