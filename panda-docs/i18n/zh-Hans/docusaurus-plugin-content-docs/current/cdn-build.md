---
title: 通过 CDN 加载应用静态资源
---

本指南说明如何构建使用自有 CDN 的 PandaForce 镜像，让 JavaScript、CSS、图片、字体和语言包通过 CDN 加载。此功能为可选部署配置；未启用 CDN 构建的镜像使用本地资源。

CDN 配置在**构建镜像时生效**。向运行中的容器添加这些变量，不会改变已经编译好的资源地址。不同部署可以使用各自的存储账号和 CDN 域名。

## 准备条件

开始之前，请准备：

- PandaForce 源码，以及支持 BuildKit 的 Docker。
- 私有 S3 存储桶，或兼容 S3 的对象存储服务。
- 已连接到该存储桶的 HTTPS CDN 域名。
- 对指定对象前缀具有读取和写入权限的构建身份。

保持存储桶的公共访问阻止设置开启。使用 CloudFront 时，通过源访问控制允许分配读取存储桶，并在对应缓存行为中选择托管响应标头策略 **CORS-With-Preflight**。免费固定费率计划也可选择此策略。公开的应用资源必须返回 `Access-Control-Allow-Origin: *` 和正确的内容类型。

构建身份需要配置前缀内的 `s3:GetObject`、`s3:PutObject` 权限，包括 `_index/` 目录。同时授予带匹配前缀条件的 `s3:ListBucket`，以便区分“对象不存在”和“无权访问”。不需要删除权限，也不需要公开读取 ACL。

## 构建参数

| 参数                          | 是否必填           | 说明                                                                        |
| ----------------------------- | ------------------ | --------------------------------------------------------------------------- |
| `PANDA_FORCE_CDN_BASE_URL`    | 启用 CDN 时必填    | 公开的 HTTPS CDN 根地址，例如 `https://cdn.example.com`，不要附加对象前缀。 |
| `PANDA_FORCE_CDN_BUCKET`      | 是                 | 目标存储桶名称，不是域名或 ARN。                                            |
| `AWS_REGION`                  | 是                 | 存储桶所在区域，例如 `ap-southeast-1`。                                     |
| `PANDA_FORCE_CDN_PREFIX`      | 否                 | 对象前缀，默认 `pandaforce/static`。不同部署可使用独立前缀。                |
| `PANDA_FORCE_CDN_S3_ENDPOINT` | 否                 | 兼容 S3 服务的存储接口地址；使用 Amazon S3 时留空。                         |
| `AWS_ACCESS_KEY_ID`           | 是                 | 构建身份的访问密钥 ID，通过构建密钥文件提供。                               |
| `AWS_SECRET_ACCESS_KEY`       | 是                 | 构建身份的访问密钥，通过构建密钥文件提供。                                  |
| `AWS_SESSION_TOKEN`           | 使用临时凭证时必填 | 会话令牌，放在同一个构建密钥文件中。                                        |

CDN 域名用于浏览器下载，S3 服务端点用于上传，两者用途不同，不要互换。CDN 根地址应映射到存储桶根目录，其下的资源路径由构建程序生成。

## 第一步：准备构建密钥

在源码目录和 Docker 构建上下文之外创建文件，限制目录仅所有者可访问，并将文件权限设为 `600`。按以下格式填写自己的凭证：

```bash
AWS_ACCESS_KEY_ID='YOUR_ACCESS_KEY_ID'
AWS_SECRET_ACCESS_KEY='YOUR_SECRET_ACCESS_KEY'
# 使用临时凭证时，另加 AWS_SESSION_TOKEN='YOUR_SESSION_TOKEN'。
```

以下示例使用 `/secure/panda-cdn.env`。不要将该文件提交到 Git，也不要把访问密钥作为 Docker 构建参数传入。构建时临时挂载此文件，生成的镜像不需要携带这些凭证。

## 第二步：构建镜像

在源码根目录执行以下命令，将示例域名、存储桶、区域及密钥文件路径替换为自己的配置：

```bash
docker build \
  --build-arg VERIFICATION_PROFILE=cdn \
  --build-arg PANDA_FORCE_CDN_BASE_URL=https://cdn.example.com \
  --build-arg PANDA_FORCE_CDN_BUCKET=example-static-bucket \
  --build-arg PANDA_FORCE_CDN_PREFIX=pandaforce/static \
  --build-arg AWS_REGION=ap-southeast-1 \
  --secret id=cdn_credentials,src=/secure/panda-cdn.env \
  -t panda-force:cdn .
```

`cdn` 验证配置检查相关静态资源行为，包括 Chromium 和 WebKit 页面加载、依赖引用替换、哈希、去重及失败处理，验证结果会明确标注为定向验证。如果同次发布还修改了其他应用行为，应选择相应的检查范围；`VERIFICATION_PROFILE=full` 运行完整验证，也是默认值。

构建程序会发布全部编译静态资源，包括额外特性模块和懒加载模块，再分别通过对象存储和实际 CDN 读取资源，校验内容、内容类型和跨域响应头。上传或验证失败时，构建立即停止。

接入 CI 时，将凭证文件保存到构建系统的密钥存储中，以 `cdn_credentials` 挂载，其他参数通过构建参数传入。构建器必须支持 BuildKit 密钥挂载。Kaniko 等不支持此方式的构建器不能直接执行该命令；应先使用兼容的构建器完成构建与验证，再通过发布流水线部署生成的镜像。

## 第三步：部署并检查

使用标准 Compose 部署时，选择刚构建的镜像：

```bash
PANDA_FORCE_IMAGE=panda-force:cdn docker compose up -d
```

部署到其他主机或 Kubernetes 时，先将镜像推送到自己的镜像仓库，再在部署配置中选用该镜像。运行中的应用不需要配置 S3 上传凭证。

打开 PandaForce，在浏览器网络面板中检查：JavaScript、CSS、图片、字体和语言包应从 CDN 域名加载；页面导航、登录、接口请求和用户文件仍访问应用服务。

镜像内的 `/app/public/cdn-manifest.json` 记录各资源的地址、对象键、SHA-256、大小以及上传和复用数量，不包含访问密钥。镜像中的编译资源与已验证的 CDN 对象具有相同内容。

## 目录组织与资源复用

新资源按以下结构存放：

```text
pandaforce/static/2026/11/<sha256>.js
pandaforce/static/2026/11/<sha256>.css
pandaforce/static/2026/11/<sha256>.png
pandaforce/static/_index/<内容索引>.json
```

年月按构建时的 UTC 时间计算。哈希对应最终发布内容，包括替换后的依赖地址。如果相同内容已经存在，构建会复用此前的资源地址，即使进入新的月份也不会再次上传。依赖发生变化时，引用该依赖且最终内容改变的资源也会更新。

资源地址不可变，缓存有效期为一年。请保留旧对象及其内容索引，以便回滚。正常发布时不要清空存储桶或旧月份目录。

HTML 和网页应用清单保留在应用域名，以保持正确的导航和主屏幕安装范围；清单中的图标使用 CDN。源码映射文件和隐藏文件不参与发布。会话附件、生成图片、缩略图、预览和导出继续使用现有存储及访问控制，此设置仅针对应用编译资源。

## 修改或停用 CDN

修改域名、存储桶或前缀后，需要重新构建、验证并部署镜像。已构建镜像保留原有地址。

恢复本地资源时，不传入 `PANDA_FORCE_CDN_BASE_URL`，重新构建并部署：

```bash
docker build --build-arg VERIFICATION_PROFILE=cdn -t panda-force:local .
PANDA_FORCE_IMAGE=panda-force:local docker compose up -d
```

此操作不会删除已有 CDN 对象，也不会删除应用持久化数据。

## 常见问题

| 现象                     | 检查内容                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| S3 返回 403              | 构建身份、区域、存储桶及前缀权限；包括 `_index/` 目录和带前缀条件的列举权限。            |
| CDN 返回 403 或 404      | 源域名、源路径、源访问控制和存储桶策略。                                                 |
| 浏览器提示跨域错误       | 资源所属缓存行为的响应标头策略。应使用实际模块请求验证，普通下载成功不足以说明配置正确。 |
| 构建提示内容类型不匹配   | CDN 应保留上传时设置的内容类型，尤其是 JavaScript、CSS、字体和 WebAssembly。             |
| 相同资源仍使用旧月份目录 | 属于正常复用，已有内容保留原有地址。                                                     |
| 页面仍访问旧 CDN 域名    | 确认运行的是新构建的镜像；仅修改运行时环境变量不会更新编译地址。                         |
| 提示依赖缺失或循环引用   | 使用完整构建产物；扩展模块若输出相互循环引用的独立文件，应先将其合并打包再发布。         |

## 不使用 Docker 构建

将私有凭证加载到构建进程的环境变量中，设置参数表中的非敏感配置，然后执行 `bun run build:client`。验证后的产物写入 `dist/cdn-public`；生产模式启动时，若该目录存在，就会使用它。源码中的 HTML 和 CSS 保持原样。后续不带 CDN 配置重新构建，会移除之前的 CDN 产物并恢复本地资源加载。
