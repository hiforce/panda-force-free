---
title: 编译期静态资源 CDN
---

PandaForce 支持在编译阶段将浏览器静态资源上传到 Amazon S3 或兼容 S3 的存储服务，通过独立的 HTTPS CDN 域名加载。未设置 `PANDA_FORCE_CDN_BASE_URL` 时，构建保持本地资源模式，不访问对象存储。

上传范围包括构建输出到 `public` 的全部静态文件：各特性的独立模块、懒加载模块、CSS、图片、语言包、Worker、WebAssembly 和第三方字体。先替换资源引用，再计算最终内容的 SHA-256。新对象存放于 `<前缀>/YYYY/MM/<sha256>.<扩展名>`；`<前缀>/_index/` 中的持久化内容索引让后续构建可以跨月份复用相同资源。复用时仍会核对存储中的实际内容。独立产物之间出现循环引用时，需要将其合并打包；循环引用或缺失依赖会使构建失败。

HTML、登录、接口请求以及网页应用清单保留在应用域名。清单中的图标使用 CDN，但安装范围和启动路径仍指向应用。运行时拼接的静态资源路径应调用 `src/client/static-assets.js` 中的 `staticAssetUrl()`，通过页面内嵌的已验证资源映射获取 CDN 地址。接口路径和用户内容不要调用此方法。

## 存储与 CDN

存储桶保持私有，通过 CloudFront 源访问控制读取。构建身份需要配置前缀内的 `s3:GetObject` 和 `s3:PutObject` 权限，包括 `_index/*`。同时配置带适当前缀条件的 `s3:ListBucket`，使不存在的对象返回 404，而不是含义不明确的权限错误。不需要修改 ACL，也不需要删除权限。

CDN 必须为这些公开的应用资源返回正确的 MIME 类型和 `Access-Control-Allow-Origin: *`，包括浏览器携带优先级请求头的情况。CloudFront 可选择托管响应标头策略 `CORS-With-Preflight`，免费固定费率计划也可以选用。构建程序上传到 S3，浏览器访问 CDN 分配域名。CDN 基础地址应对应存储桶根目录，不包含对象前缀。

构建会分别通过 S3 和实际 CDN 验证上传或复用的资源，核对最终内容哈希、MIME 类型和跨域响应头。任一步失败即停止 CDN 构建。对象内容不可变，缓存有效期为一年。保留旧对象及其索引，以便回滚；发布时不要清空旧月份目录。

## 本地构建

通过构建环境或不纳入版本管理的私有环境文件提供密钥：

```bash
export PANDA_FORCE_CDN_BASE_URL=https://cdn.example.com
export PANDA_FORCE_CDN_BUCKET=example-static-bucket
export PANDA_FORCE_CDN_PREFIX=pandaforce/static
export AWS_REGION=ap-southeast-1
# 通过密钥管理工具设置 AWS_ACCESS_KEY_ID 和 AWS_SECRET_ACCESS_KEY。
# 使用临时凭证时，同时设置 AWS_SESSION_TOKEN。
bun run build:client
```

可选变量 `PANDA_FORCE_CDN_S3_ENDPOINT` 用于指定兼容 S3 的服务端点。成功后生成 `dist/cdn-public/index.html`、保留在本地的网页应用清单和 `cdn-manifest.json`。资源记录只包含地址、对象键、哈希和验证计数，不包含密钥。生产模式从源码启动时，会优先使用已生成的 CDN 目录。后续不带 CDN 配置重新构建，会删除之前的 CDN 产物并恢复本地资源模式。源码中的 HTML 和 CSS 不会被原地覆盖。

## 容器构建

在构建上下文之外创建仅文件所有者可读的私有文件，使用 Shell 兼容格式设置 `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`，必要时设置 `AWS_SESSION_TOKEN`。通过 BuildKit 密钥挂载提供：

```bash
docker build \
  --build-arg VERIFICATION_PROFILE=cdn \
  --build-arg PANDA_FORCE_CDN_BASE_URL=https://cdn.example.com \
  --build-arg PANDA_FORCE_CDN_BUCKET=example-static-bucket \
  --build-arg PANDA_FORCE_CDN_PREFIX=pandaforce/static \
  --build-arg AWS_REGION=ap-southeast-1 \
  --secret id=cdn_credentials,src=/secure/build-cdn.env \
  -t panda-force:cdn .
```

密钥仅在上传步骤挂载，不复制进镜像层，也不作为构建参数传入。最终镜像引用已验证的 CDN 资源，运行时不需要上传密钥。CDN 构建成功后再部署镜像。修改运行时环境变量不会改变镜像中已经编译好的地址，需要重新构建。

`cdn` 验证配置仅检查相关内容：依赖引用替换、最终哈希、去重、失败处理、静态资源传输，以及 Chromium 和 WebKit 中的完整页面加载。验证凭证会明确记录这是定向验证，并列出未运行的检查。需要完整验证时，使用 `VERIFICATION_PROFILE=full`。

此配置用于公开的应用编译资源。会话附件、生成图片、缩略图、预览和导出仍保留现有存储与访问控制；运行期存储配置独立处理。
