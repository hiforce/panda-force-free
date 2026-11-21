---
title: 编译源码与基础镜像
---

0.1.2 源码新增可自行构建的 Rocky 创作环境；[基础镜像的内容与用途](base-images.md)说明标准与创作镜像的区别、工具清单、构建命令和月度维护。

普通安装直接使用 `hiforceai/panda-force:0.1.1`。需要自己编译时，在 `v0.1.1` 源码目录运行：

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

应用 Dockerfile 默认使用 `scripts/build/base-images.json` 中固定摘要的 Linux amd64 基础镜像：

| 镜像                                                               | 内容                                                                  |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `hiforceai/panda-force-build-base:engines-20261120-b3302dd60ade`   | Node.js、Bun、Codex CLI、Grok Build、编译工具和锁定的开发依赖         |
| `hiforceai/panda-force-runtime-base:engines-20261120-b3302dd60ade` | 运行环境、两种 Harness CLI、生产依赖、FFmpeg/FFprobe 和 Noto CJK 字体 |

首次会下载基础层，之后复用 Docker 缓存，只编译应用更新。打包默认 `VERIFICATION_PROFILE=none`；源码和受影响行为应独立验证。两种基础镜像均允许通过 `PANDA_FORCE_BUILD_BASE` 和 `PANDA_FORCE_RUNTIME_BASE` 覆盖，使用自有仓库时通过 Docker 的独立凭据配置登录。

两套依赖阶段均先安装锁定的依赖，再使用 npm 的原生构建工具显式编译 `node-pty`，运行镜像不包含开发依赖。这项构建顺序修正保留原有锁定依赖清单，与已固定摘要的公开基础镜像兼容。

0.1.1 应用继续复用 0.1.0 使用的固定摘要基础镜像，依赖输入和基础配方未变。自行重建时使用对应版本的干净源码。

## 自行构建基础镜像

从同一版本的干净源码构建，准备支持 Linux amd64 的 Docker。首次构建核心层会下载并安装依赖、原生模块和浏览器工具，耗时比普通应用构建长。以下命令使用官方 Debian/npm 源；可按需覆盖为可信镜像源：

```bash
# 1. Build the two dependency cores.
docker build --platform linux/amd64 -f scripts/build/Dockerfile.bases --target build-base \
  --build-arg APT_MIRROR=http://deb.debian.org \
  --build-arg NPM_REGISTRY=https://registry.npmjs.org \
  -t panda-force-build-base:local-core .
docker build --platform linux/amd64 -f scripts/build/Dockerfile.bases --target runtime-base \
  --build-arg APT_MIRROR=http://deb.debian.org \
  --build-arg NPM_REGISTRY=https://registry.npmjs.org \
  -t panda-force-runtime-base:local-core .

# 2. Add the compiler label and runtime media tools.
docker build --platform linux/amd64 -f scripts/build/Dockerfile.media-bases --target build-base \
  --build-arg BUILD_BASE=panda-force-build-base:local-core \
  --build-arg RUNTIME_BASE=panda-force-runtime-base:local-core \
  -t panda-force-build-base:local .
docker build --platform linux/amd64 -f scripts/build/Dockerfile.media-bases --target runtime-base \
  --build-arg BUILD_BASE=panda-force-build-base:local-core \
  --build-arg RUNTIME_BASE=panda-force-runtime-base:local-core \
  -t panda-force-runtime-base:local .

# 3. Build and run the application with that pair.
export PANDA_FORCE_BUILD_BASE=panda-force-build-base:local
export PANDA_FORCE_RUNTIME_BASE=panda-force-runtime-base:local
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

前两步构建依赖核心和媒体层，第三步通过环境变量选择本地基础镜像并构建应用。若直接使用 `docker build`，传入 `--build-arg BUILD_BASE=panda-force-build-base:local` 和 `--build-arg RUNTIME_BASE=panda-force-runtime-base:local`。

在其他构建机器使用时，将两个本地基础镜像分别打标签并推送到自有仓库，再覆盖这两个引用。仓库凭据独立管理，不写入源码或构建参数。核心配方支持 `APT_MIRROR`、`NPM_REGISTRY`、`BUN_IMAGE` 和 `NODE_IMAGE`，可选择管理员管理的镜像源。

根包没有安装钩子时，普通发布版本号变化可以复用原基础镜像；依赖、锁文件、补丁、安装钩子或基础配方变化仍要求匹配的新基础镜像。确认新镜像兼容后，用 `node scripts/build/dependencies.mjs profile .` 计算兼容指纹，并审查 `scripts/build/base-images.json` 中的引用和媒体配方摘要，保留兼容检查。

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

审核版本和校验值后，在隔离容器中验证两种 CLI 与协议初始化、依赖兼容和应用启动，再发布新的不可变配套镜像。标准镜像需要同步更新 `scripts/build/base-images.json`、Dockerfile 与 Compose 的配套引用及引擎 recipe/lock 哈希。构建 Rocky 创作镜像时，以审核后的新 seed 摘要传入 `--seed-image`，并按[创作工具链维护流程](base-images.md#每月刷新)重建验证。

账户目录按运维配置持久化；Grok 账户目录只读挂载时，需要完整目录来跟随原子令牌更新。引擎清单在 `/opt/panda-harness/engines.json`，Grok 许可在 `/opt/panda-harness/licenses/grok-LICENSE`。普通应用构建和启动不会自动更新引擎；每月维护由运维手动执行。

## 源码与文档检查

本地应用工具链使用 Bun 1.4.2、Node.js 22 和 Codex CLI 0.166.0。运行 `bun install --frozen-lockfile`、`npm rebuild node-pty --build-from-source` 后，使用 `bun run check`、相关单元/集成/浏览器用例。完整验证可独立使用 `bun run verify`，不把它默认附加到每次镜像打包。浏览器检查需要 Playwright Chromium 和 WebKit。

帮助站独立构建：进入 `panda-docs`，运行 `bun install --frozen-lockfile` 和 `bun run build`，使用 Node.js 22 或更新版本。原生/远程诊断、真实模型账号和生产凭据不属于普通安装要求。
