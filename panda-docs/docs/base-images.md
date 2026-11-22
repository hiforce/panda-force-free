---
title: Base image contents and purpose
---

PandaForce 0.1.3 source separates the reusable toolchain from application code. A base image installs expensive, reviewed dependencies once. Later application builds reuse those layers, compile the checked-out source and package a runnable application. This avoids downloading Office, fonts, browser binaries and language packages during every creation task.

## Choose a base pair

<div className="base-image-table">

| Layer                               | Contents                                                                                                                         | Purpose and availability                                                                                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Default Rocky creative build base   | Rocky Linux 9, both Harness CLIs, native compilers, locked application development dependencies and the creative inventory below | Public `hiforceai/panda-force-build-base:rocky9-creative-20261121-14a4a23a90de`, selected by immutable digest in the source Dockerfile and Compose build overlay.                                                  |
| Default Rocky creative runtime base | Rocky Linux 9, both Harness CLIs, application production dependencies and the same creative inventory                            | Public `hiforceai/panda-force-runtime-base:rocky9-creative-20261121-14a4a23a90de`, paired by its own immutable digest. Runs tasks with expensive tools already installed.                                          |
| Application image                   | Selected runtime, application source, compiled browser assets, CLI and startup command                                           | Runnable `hiforceai/panda-force:0.1.3`; the normal installation pulls this image.                                                                                                                                  |
| Legacy Debian build/runtime bases   | The earlier locked application dependencies, Harness engines, FFmpeg and Noto CJK fonts                                          | The `engines-20261120-b3302dd60ade` pair remains available for explicitly selected compatible legacy builds and as the reviewed Debian Harness seed. It is not the 0.1.3 default or the complete creative toolset. |

</div>

The stable 0.1.3 application image and both default Rocky creative bases are public for **Linux amd64**. Use the matching `v0.1.3` source and installation files. The Dockerfile, Compose overlay and `scripts/build/base-images.json` pin the actual published build/runtime digests; the two roles use distinct image references. Their installed inventories match the reviewed creative inputs. [Codex and Grok container setup](harness-runtimes.md) covers account services and login.

The container userspace is independent of the host distribution. A Rocky host can run either pair; choose the Rocky pair when you want that userspace and the complete creative toolset. The current recipe targets **Linux amd64**.

## Rocky creative runtime inventory

<div className="base-image-table">

| Capability               | Preinstalled tools                                                                                                                                                                  | What they enable                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Common environment       | Node.js, Bun, Python 3.11 isolated virtual environment, Git, OpenSSH client, curl, ZIP tools and fontconfig                                                                         | Run scripts, locate tools, fetch authorized resources and handle archives without task-time setup.                                       |
| Harness engines          | Codex CLI and Grok Build                                                                                                                                                            | Start native engine sessions through the selected runtime. Login credentials and mutable account homes remain outside images.            |
| Slides                   | PptxGenJS, python-pptx, LibreOffice Impress, Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`), pdf2image                                                                                | Author editable PPTX files, render them to PDF, check page counts/text and generate previews.                                            |
| Images                   | Sharp and Pillow                                                                                                                                                                    | Resize, composite, convert and inspect images; render text with the installed fonts.                                                     |
| Research                 | Tesseract English/Simplified Chinese/Traditional Chinese OCR, PyMuPDF, pypdf, MarkItDown Office/PDF readers, httpx, Beautiful Soup, lxml, trafilatura, NumPy, pandas and Matplotlib | Read source material, extract searchable text, analyze tables and produce charts.                                                        |
| Writing and spreadsheets | LibreOffice Writer/Calc, Pandoc, docx, python-docx, ExcelJS, openpyxl, ReportLab, markdown-it and KaTeX                                                                             | Create and convert DOCX/XLSX/Markdown/PDF files and render mathematical content.                                                         |
| Web                      | Playwright with its matched Chromium binary and Cheerio                                                                                                                             | Inspect HTML and produce browser screenshots/PDF files. This is a creative runtime toolset, separate from the application's test runner. |
| Video                    | FFmpeg, FFprobe, H.264 support and MoviePy                                                                                                                                          | Encode, combine and inspect video/audio and render text overlays.                                                                        |
| Fonts                    | Noto Sans/Serif, regional CJK SC/HK/TC/JP/KR families, Arabic/Urdu/Hebrew/Indic/Thai families, Noto Mono, Liberation, DejaVu and WenQuanYi                                          | Preserve multilingual text in slides, documents, images and video. Font license files are retained in the image.                         |

</div>

The reviewed build verified Rocky Linux **9.9**, Node.js **22.23.4**, Python **3.11.13**, LibreOffice **26.8.3.1**, FFmpeg **7.1.5**, Codex CLI **0.171.0**, Grok Build **1.0.89** and PptxGenJS **4.0.1**. These describe that verified build. The installed RPM inventory and `panda-tools inventory` are authoritative for each rebuild; system repository updates can change RPM versions.

The recipe copies portable Node/Bun/Harness binaries and font data from the reviewed seed, then installs Rocky RPMs and rebuilds native application modules on Rocky. It uses Rocky/EPEL/CRB packages, a checksum-verified RPM Fusion free repository package, and a checksum-verified official LibreOffice RPM archive. It does not copy Debian native `node_modules` into Rocky.

## Maintained inputs

<div className="base-image-table">

| File                                                                   | Responsibility                                                                                       |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `scripts/build/creative-tools/manifest.json`                           | Capability profiles, reviewed plugin/profile declarations, regional fonts and Rocky package mapping. |
| `scripts/build/creative-tools/package.json` and `bun.lock`             | Exact Node creative-tool versions and their resolved dependency graph.                               |
| `scripts/build/creative-tools/requirements.in` and `requirements.lock` | Reviewed Python roots and the resolved dependency graph with package hashes.                         |
| `scripts/build/creative-tools/sources.lock.json`                       | Official Office archive and RPM repository package URLs/checksums.                                   |
| `scripts/build/harness-engines.lock.json`                              | Reviewed Codex/Grok versions, checksums and license inputs for the Harness seed.                     |
| `scripts/build/Dockerfile.rocky-bases`                                 | Common creative layer and separate application build/runtime dependency stages.                      |

</div>

When a plugin needs another executable or library, update these maintained inputs, its profile and platform mapping. Review licenses, refresh the corresponding lock and rebuild both bases. Installing a dependency only in a running container or a temporary task directory does not maintain the next image. Unknown profiles, missing package mappings and inconsistent Node/Python declarations fail validation. Plugin input cannot choose an arbitrary execution image or supply installation commands to this builder.

## Rebuild and select Rocky bases

Normal installations pull the application image, and normal source builds automatically pull the public base pair. Rebuild the bases only after changing reviewed tool inputs. From a clean matching checkout, with Docker, Node.js and Bun available:

```bash
node scripts/build/creative-tools.mjs validate
node scripts/build/creative-tools.mjs build \
  --work .artifacts/rocky-creative-build \
  --build-tag panda-force-build-base:rocky-local \
  --runtime-tag panda-force-runtime-base:rocky-local \
  --pull-policy if-not-present

docker run --rm --network none --entrypoint panda-tools \
  panda-force-runtime-base:rocky-local doctor
docker run --rm --network none --entrypoint node \
  -v "$PWD/scripts/build/creative-smoke.mjs:/tmp/creative-smoke.mjs:ro" \
  panda-force-runtime-base:rocky-local /tmp/creative-smoke.mjs

export PANDA_FORCE_BUILD_BASE=panda-force-build-base:rocky-local
export PANDA_FORCE_RUNTIME_BASE=panda-force-runtime-base:rocky-local
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

The offline smoke generates editable slides, renders a PDF and preview, checks Chinese text, exercises document/spreadsheet/image/research tools, captures a web page and encodes H.264 video. It needs no model account. Real engine inference is a separate, deliberately configured check.

For direct application builds, pass `--build-arg BUILD_BASE=...` and `--build-arg RUNTIME_BASE=...`. The application checks dependency compatibility and matching creative input digests. A version-only application update can reuse the same verified bases. After publishing your own pair, select immutable digests and retain the previous pair for rollback.

The base builder accepts `--rocky-image`, `--seed-image` and `--npm-registry` overrides. Pull policies are `always`, `if-not-present` and `never`; `never` requires the selected upstream images to exist locally. Docker registry login and deployment pull credentials are managed separately. Keep them outside source, build arguments and image layers. Ordinary application assets use the application origin; optional CDN settings remain administrator-owned.

## Find installed tools before installing again

Run these commands in the **actual execution environment**:

```bash
panda-tools doctor
panda-tools fonts
panda-tools inventory
panda-tools resolve pptxgenjs
```

Creative Node packages are under `/opt/panda-creative/node/node_modules`, and the Python virtual environment is under `/opt/panda-creative/python`. CommonJS can use the configured `NODE_PATH`. For ESM use `createRequire` or import the absolute entry returned by `panda-tools resolve`. A different working directory can cause module lookup failures even when the package is installed. Give each concurrent LibreOffice conversion a separate writable `-env:UserInstallation=file:///...` directory.

A container image does not install tools into an external SSH host or shared Codex daemon. Check the runtime where the selected Harness actually executes before relying on this inventory. Keep authentication/account directories on operator-managed persistent storage.

## Monthly refresh

1. Resolve and review the Harness update with `harness-engines.mjs refresh`; follow the [Harness seed build procedure](building.md#monthly-harness-engine-refresh), then select the verified seed by digest.
2. Refresh the creative locks with `node scripts/build/refresh-creative-tools.mjs --uv /path/to/reviewed/uv`. The current Python resolver is **uv 0.13.9**; the refresh resolves Node packages, hashed Python packages and the latest official stable Office archive. `--office-version` selects an explicitly reviewed Office version.
3. Review changes and licenses, validate the profiles, then run the base build above with `--refresh-system --pull-policy always` and the reviewed `--seed-image` when it changes.
4. Verify both installed inventories, CLI/protocol compatibility, offline creative output, application packaging/startup and the affected workflows. Record the actual RPM inventories, checksums and image digests.
5. Publish a new immutable pair to your selected registry, update the application selectors and release each application independently. Keep credentials and old rollback images separate from these artifacts.

This is a maintained manual workflow. Application startup and creation tasks do not automatically upgrade tools, and the source does not install a monthly background scheduler. See [source builds](building.md) for the optional legacy Debian base recipes and [CDN builds](cdn-build.md) for optional static resource delivery.
