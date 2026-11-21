---
title: 基础镜像的内容与用途
---

PandaForce 0.1.2 源码将可复用工具环境与应用代码分开。基础镜像提前安装经过审核、下载和安装耗时较长的依赖，应用更新时复用这些层，再编译当前源码、组装可运行的应用镜像。这样，创作任务可以直接使用 Office、字体、浏览器和语言工具库。

## 选择配套的基础镜像

<div className="base-image-table">

| 层                     | 内容                                                                                   | 目的及获取方式                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 标准构建基础镜像       | Debian 用户空间、Node.js、Bun、Codex CLI、Grok Build、原生编译工具及锁定的应用开发依赖 | 默认公开源码构建环境。已公开的 `hiforceai/panda-force-build-base:engines-20261120-b3302dd60ade` 在 Dockerfile 和 Compose 中按摘要固定。 |
| 标准运行基础镜像       | Node.js、Bun、两种 Harness CLI、应用生产依赖、FFmpeg/FFprobe 和 Noto CJK 字体          | 默认公开应用运行环境；配套的 `hiforceai/panda-force-runtime-base:engines-20261120-b3302dd60ade` 同样按摘要固定。                        |
| Rocky 创作构建基础镜像 | Rocky Linux 9、下表中的创作工具、两种 Harness CLI、原生编译工具及锁定的应用开发依赖    | 使用统一创作环境编译应用；通过 `scripts/build/Dockerfile.rocky-bases` 自行构建。                                                        |
| Rocky 创作运行基础镜像 | Rocky Linux 9、相同的创作工具和 Harness CLI，以及应用生产依赖                          | 提前准备 Office、图像、研究、写作、浏览器和视频能力；与同一套输入构建的 Rocky 构建基础镜像配套使用。                                    |
| 应用镜像               | 选定的运行基础镜像、应用源码、编译后的前端、CLI 与启动命令                             | 实际运行 Web 应用；基础镜像本身不含已配置的 PandaForce 安装。                                                                           |

</div>

本次 `develop` 更新发布 **0.1.2 源码**。现有公开应用镜像与发行标签仍为 `0.1.1`；本次源码发布没有宣称提供 `0.1.2` 应用镜像或可公开拉取的 Rocky 创作基础镜像。默认构建继续使用现有公开标准基础镜像，源码中提供完整 Rocky 配方与依赖输入，供自行构建或推送到管理员自有仓库。

容器用户空间独立于宿主机发行版。Rocky 宿主机可以运行两种配套环境；需要 Rocky 用户空间和完整创作工具时选择 Rocky 配方。当前配方面向 **Linux amd64**。

## Rocky 创作运行环境清单

<div className="base-image-table">

| 能力         | 预装内容                                                                                                                                        | 解决的问题                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 通用环境     | Node.js、Bun、Python 3.11 独立虚拟环境、Git、OpenSSH 客户端、curl、ZIP 工具和 fontconfig                                                        | 执行脚本、查找工具、读取已授权资源和处理压缩包。                         |
| Harness 引擎 | Codex CLI 与 Grok Build                                                                                                                         | 通过选定运行实例启动原生引擎会话；登录凭据和可变账户目录保存在镜像之外。 |
| 幻灯片       | PptxGenJS、python-pptx、LibreOffice Impress、Poppler 的 pdfinfo/pdftotext/pdftoppm、pdf2image                                                   | 创建可编辑 PPTX，转换 PDF，检查页数与文字，生成预览。                    |
| 图像         | Sharp、Pillow                                                                                                                                   | 缩放、合成、格式转换、图像检查与字体文字渲染。                           |
| 研究         | Tesseract 英文/简中/繁中 OCR、PyMuPDF、pypdf、MarkItDown Office/PDF 读取器、httpx、Beautiful Soup、lxml、trafilatura、NumPy、pandas、Matplotlib | 读取材料、提取文字、分析表格并生成图表。                                 |
| 写作与表格   | LibreOffice Writer/Calc、Pandoc、docx、python-docx、ExcelJS、openpyxl、ReportLab、markdown-it、KaTeX                                            | 创建和转换 DOCX/XLSX/Markdown/PDF，呈现数学内容。                        |
| 网页         | Playwright 及其版本匹配的 Chromium、Cheerio                                                                                                     | 检查 HTML、网页截图和导出 PDF；该工具箱独立于应用的测试运行器。          |
| 视频         | FFmpeg、FFprobe、H.264 支持、MoviePy                                                                                                            | 编码、合成、检查音视频及渲染文字叠加。                                   |
| 字体         | Noto Sans/Serif、区域 CJK SC/HK/TC/JP/KR、阿拉伯文/乌尔都文/希伯来文/印度文字/泰文、Noto Mono、Liberation、DejaVu、文泉驿                       | 在幻灯片、文档、图像和视频中保留多语言文字；镜像保留字体许可文件。       |

</div>

已验证构建的实际版本包括 Rocky Linux **9.9**、Node.js **22.23.4**、Python **3.11.13**、LibreOffice **26.8.3.1**、FFmpeg **7.1.5**、Codex CLI **0.171.0**、Grok Build **1.0.89** 和 PptxGenJS **4.0.1**。这些版本描述该次已验证构建；每次重建以安装后的 RPM 清单和 `panda-tools inventory` 为准，系统软件源更新可能改变 RPM 版本。

配方从审核后的 seed 复制可移植的 Node/Bun/Harness 二进制和字体数据，再安装 Rocky RPM，并在 Rocky 上重新编译应用原生模块。系统依赖来自 Rocky/EPEL/CRB，视频编码使用校验过摘要的 RPM Fusion free 仓库安装包，LibreOffice 使用校验过摘要的官方 RPM 归档。Debian 原生 `node_modules` 不会复制到 Rocky。

## 维护输入清单

<div className="base-image-table">

| 文件                                                                  | 维护职责                                                             |
| --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `scripts/build/creative-tools/manifest.json`                          | 能力 profile、已审核插件/profile 声明、区域字体及 Rocky 系统包映射。 |
| `scripts/build/creative-tools/package.json` 与 `bun.lock`             | 创作 Node 工具的准确版本和解析后的依赖图。                           |
| `scripts/build/creative-tools/requirements.in` 与 `requirements.lock` | 审核后的 Python 根依赖与带包哈希的完整依赖图。                       |
| `scripts/build/creative-tools/sources.lock.json`                      | 官方 Office 归档、RPM 仓库安装包的地址和校验值。                     |
| `scripts/build/harness-engines.lock.json`                             | Harness seed 中 Codex/Grok 的审核版本、校验值及许可输入。            |
| `scripts/build/Dockerfile.rocky-bases`                                | 共用创作层和分开的应用构建/生产依赖阶段。                            |

</div>

新增插件依赖可执行程序或语言库时，需要更新这些维护输入、对应 profile 和平台包映射，审查许可，刷新相应依赖锁，然后重建两种基础镜像。仅在运行容器或任务临时目录安装，不能维护下次镜像。未知 profile、缺失平台映射、Node/Python 声明不一致会阻止构建；插件输入不能选择任意执行镜像，也不能向构建器提供安装命令。

## 构建并选用 Rocky 基础镜像

在当前源码的干净目录中准备 Docker、Node.js 和 Bun：

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

离线探测实际生成可编辑幻灯片、转换 PDF 与预览、检查中文文字，验证文档/表格/图像/研究工具、网页截图和 H.264 视频。它不需要模型账户；真实引擎推理由另外明确配置的联调检查负责。

直接使用 `docker build` 时分别传入 `--build-arg BUILD_BASE=...` 和 `--build-arg RUNTIME_BASE=...`。应用会检查依赖兼容性及创作输入摘要是否配套。仅修改应用版本可以复用同一对已验证基础镜像。发布到自有仓库后选用不可变摘要，并保留上一对镜像用于回退。

构建器支持 `--rocky-image`、`--seed-image`、`--npm-registry` 覆盖，以及 `always`、`if-not-present`、`never` 拉取策略；`never` 要求上游镜像已存在于本地。Docker 登录与部署拉取凭据独立管理，凭据留在源码、构建参数和镜像层之外。普通安装从应用源站提供静态资源，可选 CDN 使用管理员自己的配置。

## 安装前先查找现有工具

在**实际执行任务的环境**中运行：

```bash
panda-tools doctor
panda-tools fonts
panda-tools inventory
panda-tools resolve pptxgenjs
```

Node 创作工具位于 `/opt/panda-creative/node/node_modules`，Python 虚拟环境位于 `/opt/panda-creative/python`。CommonJS 可使用已配置的 `NODE_PATH`；ESM 使用 `createRequire`，或导入 `panda-tools resolve` 返回的绝对入口。工作目录不同可能导致模块解析失败，此时包可能已经安装。并发 LibreOffice 转换分别使用独立、可写的 `-env:UserInstallation=file:///...` 目录。

容器镜像不会向外部 SSH 宿主机或共享 Codex 守护进程安装工具。先确认选定 Harness 的实际执行位置，再使用该清单；认证与账户目录继续使用运维管理的持久化存储。

## 每月刷新

1. 用 `harness-engines.mjs refresh` 解析并审核 Harness 更新，按[构建说明中的月度 Harness 流程](building.md#每月更新-harness-引擎)构建 seed，验证后按摘要选用。
2. 使用 `node scripts/build/refresh-creative-tools.mjs --uv /path/to/reviewed/uv` 刷新创作依赖锁。当前审核过的 Python 解析器为 **uv 0.13.9**；刷新工具解析 Node、带哈希的 Python 包和最新官方稳定 Office 归档，`--office-version` 可指定明确审核的 Office 版本。
3. 审查变更与许可，验证 profile，在上述构建命令中加入 `--refresh-system --pull-policy always`；seed 变化时传入审核后的 `--seed-image`。
4. 核对两种镜像的实际清单、CLI/协议兼容、离线创作输出、应用打包/启动及受影响流程，记录实际 RPM、校验值和镜像摘要。
5. 向选定仓库发布新的不可变配套镜像，更新应用选择参数，逐个发布应用。凭据与旧版回退镜像单独保留。

这是可维护的手动流程。应用启动和创作任务不会自动升级工具，源码也没有安装月度后台调度。标准 Debian 基础镜像配方见[源码构建](building.md)，可选静态资源分发见[CDN 构建](cdn-build.md)。
