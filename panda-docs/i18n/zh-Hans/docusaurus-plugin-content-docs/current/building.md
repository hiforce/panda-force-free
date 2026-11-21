---
title: 编译源码与基础镜像
---

0.1.2 默认使用已公开、配套的 **Rocky 创作构建/运行基础镜像**，平台为 Linux amd64。两种镜像均包含 Codex CLI、Grok Build 与完整的 Office/PDF/OCR、字体、图像、研究、写作、浏览器和视频工具；构建镜像增加应用开发/原生编译依赖，运行镜像保留生产依赖。[基础镜像内容与用途](base-images.md)说明清单、目的和锁定输入。

## Development container

需要定制应用时，自行指定开发镜像标签，再构建当前源码。下面的构建命令在你的机器上生成该标签，不会将其发布到仓库：

```bash
export PANDA_FORCE_IMAGE=panda-force:source
docker compose -f docker-compose.yml -f docker-compose.build.yml build panda-force
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --no-build
```

后续命令保持同一 `PANDA_FORCE_IMAGE`。为自建镜像加入 Grok 账户续期时，使用全部三个 Compose 文件，使应用及账户辅助服务使用同一镜像：

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml \
  -f deploy/harness/docker-compose.grok.yml up -d --no-build
docker compose -f docker-compose.yml -f docker-compose.build.yml \
  -f deploy/harness/docker-compose.grok.yml \
  run --rm grok-auth grok --no-auto-update login --device-auth
```

重建时保留账户与工作区卷。镜像打包默认执行编译及启动检查，源码及受影响行为检查独立运行。直接在主机运行源码的工具前提与命令见[英文开发指南](https://github.com/hiforce/panda-force-free/blob/main/panda-docs/docs/building.md#run-from-source)。

Dockerfile、Compose 构建叠加文件与 `scripts/build/base-images.json` 固定实际公开的配套摘要。首次下载较大，之后复用已安装层。自有仓库请同时覆盖 `PANDA_FORCE_BUILD_BASE` 与 `PANDA_FORCE_RUNTIME_BASE`；直接 Docker 构建分别使用 `BUILD_BASE`、`RUNTIME_BASE`。仓库凭据与拉取策略独立管理，普通安装无需 CDN，启用 CDN 时使用自己的存储配置。

## 自行构建基础镜像

在同版干净源码中使用 [Rocky 创作构建器](base-images.md#构建并选用-rocky-基础镜像)。它按 profile、Node/Python 锁和校验值构建两种基础镜像，验证实际清单，支持明确的拉取策略和可信源覆盖。插件或依赖变化后先重建验证配套镜像，再选用新摘要；仅应用版本号变化可复用兼容基础层。

旧版 Debian 配方保留为明确选择的兼容环境，并提供 Rocky 配方使用的 Debian Harness seed。它不包含完整创作工具。[旧环境的完整构建顺序](https://github.com/hiforce/panda-force-free/blob/v0.1.2/panda-docs/docs/building.md#build-your-own-base-images)是 **核心依赖 → 媒体层 → Harness 引擎层**；单独的核心/媒体层不能满足本版引擎锁。

Rocky 的 seed 阶段通过 apt 准备可移植字体，所以 `--seed-image` 使用已验证的 **Debian 引擎构建镜像**，而非新的 Rocky 默认镜像；最终 Rocky 阶段自行安装 RPM 并重新编译原生模块。

## 每月更新 Harness 引擎

两种标准基础镜像都包含 Codex CLI 和 Grok Build；引擎层使用 `scripts/build/Dockerfile.engine-bases`，版本、二进制校验和许可由 `scripts/build/harness-engines.lock.json` 维护。认证与可变账户目录保存在镜像之外。

```bash
node scripts/build/harness-engines.mjs refresh
node scripts/build/harness-engines.mjs prepare --output .artifacts/harness-engine-inputs

docker build -f scripts/build/Dockerfile.engine-bases --platform linux/amd64 \
  --target build-base -t my-registry/panda-force-build-base:NEW_FIXED_TAG \
  .artifacts/harness-engine-inputs
docker build -f scripts/build/Dockerfile.engine-bases --platform linux/amd64 \
  --target runtime-base -t my-registry/panda-force-runtime-base:NEW_FIXED_TAG \
  .artifacts/harness-engine-inputs
```

审核版本和校验值后，在隔离容器中验证两种 CLI 与协议初始化、依赖兼容和应用启动，再发布新的不可变配套镜像。默认镜像需要同步更新 `scripts/build/base-images.json`、Dockerfile 与 Compose 的配套引用及引擎 recipe/lock 哈希。构建 Rocky 创作镜像时，以审核后的新 seed 摘要传入 `--seed-image`，并按[创作工具链维护流程](base-images.md#每月刷新)重建验证。

账户目录按运维配置持久化；Grok 账户目录只读挂载时，需要完整目录来跟随原子令牌更新。引擎清单在 `/opt/panda-harness/engines.json`，Grok 许可在 `/opt/panda-harness/licenses/grok-LICENSE`。普通应用构建和启动不会自动更新引擎；每月维护由运维手动执行。

## 源码与文档检查

本地应用工具链使用 Bun 1.4.2、Node.js 22 和 Codex CLI 0.171.0。运行 `bun install --frozen-lockfile`、`npm rebuild node-pty --build-from-source` 后，使用 `bun run check`、相关单元/集成/浏览器用例。完整验证可独立使用 `bun run verify`，不把它默认附加到每次镜像打包。浏览器检查需要 Playwright Chromium 和 WebKit。

帮助站独立构建：进入 `panda-docs`，运行 `bun install --frozen-lockfile` 和 `bun run build`，使用 Node.js 22 或更新版本。原生/远程诊断、真实模型账号和生产凭据不属于普通安装要求。
