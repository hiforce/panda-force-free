---
title: 安装、登录与数据库选择
---

PandaForce 支持多个 Harness Runtime，先选运行实例，再选该实例的模型和推理强度。应用管理员与模型账户分别登录；[Codex/Grok 容器配置](harness-runtimes.md)说明两种引擎、账户持久化和原生续期。下方宿主机共享模式专门针对 Codex。

## 运行方式与引擎位置 {#understand-what-runs-where}

Codex 可使用容器内独立服务，或通过共享模式连接指定宿主机上的已有服务。Grok Build 使用所选 Harness Runtime 及其账户配置，详见上方的容器配置指南。应用账号与模型服务账号分开管理，选择 SQLite 或 MySQL 管理应用数据不改变模型账号的存放位置。

## 安装公开镜像

`develop` 分支使用 `hiforceai/panda-force:0.2.4`，平台为 Linux amd64。Rocky Linux 9 镜像包含 Bun、Node.js、Codex CLI 0.171.0、Grok Build 1.0.89 和创作工具链，宿主机只需 Docker、Compose 和 Git。其他架构需要 amd64 模拟或自行构建兼容镜像。

```bash
git clone --branch develop --depth 1 https://github.com/hiforce/panda-force-free.git
cd panda-force-free
docker compose pull panda-force
docker compose up -d --no-build
docker compose logs panda-force
```

打开 http://localhost:8899 创建管理员。密码至少六位，包含大小写字母和数字；若要求安装验证码，在容器启动日志中读取。应用账号与模型服务账号分开管理，镜像不内置你的账号或云服务凭据。

```bash
docker compose exec -it panda-force codex login --device-auth
docker compose restart panda-force
```

按终端提示完成模型登录。API Key 等方式见[模型服务商](./model-providers.md)。默认端口仅监听宿主机的本地地址，远程使用时配置 SSH 隧道或 HTTPS 反向代理。应用、模型账号和工作区使用独立持久卷；升级前备份，`docker compose down` 保留数据卷。

## 首次选择数据库

首次创建管理员后，弹出数据库选择窗口：

- **使用 SQLite**：直接在应用状态卷内保存数据，无需额外数据库服务器。选择结果会跨重启保留，以后仍可在“设置 → 存储与日志”配置 MySQL。
- **配置 MySQL**：准备专用空数据库和有建表/读写权限的用户，填写应用容器可访问的地址、端口、数据库及凭据。同一 Compose 网络内使用数据库服务名；容器中的 `localhost` 指向容器自身。

默认验证数据库服务器的 TLS 证书，可在高级设置填写已挂载到应用容器的 CA 文件。按“测试连接 → 审阅迁移 → 迁移到 MySQL”操作。连接失败时，原数据库保持选中，可修正后重试；源数据会先备份，再暂停写入、复制和校验，最后重启切换。保留状态卷与恢复记录，等待界面确认完成。

管理员在本地引导阶段创建，其身份、密码哈希、账号设置及会话撤销记录会随账号域迁入 MySQL。切换成功后的账号认证使用 MySQL。模型服务认证、附件与项目文件仍有各自的持久位置，因此备份要同时覆盖数据库和应用/模型/工作区卷。

## 源码开发

直接运行源码或构建自有应用镜像，请参阅[开发指南](building.md#development-container)。普通容器安装使用已发布的 `hiforceai/panda-force:0.2.4` 与上面的安装命令。

## 使用宿主机已有 Codex {#use-codex-already-installed-on-the-host}

共享模式需要挂载实际 Unix socket 目录，并让工作区在宿主机和容器中使用相同绝对路径。它共享服务连接，模型凭据继续由宿主机管理。详细 Linux 命令和 UID/GID、socket 重建及额外工作区要求见[完整共享模式说明](https://github.com/hiforce/panda-force-free/blob/v0.2.3/panda-docs/docs/installation.md#use-codex-already-installed-on-the-host)。Docker 默认安装使用独立的容器内引擎，无需宿主机已有 Codex。

## 手机访问

使用自己部署的 HTTPS 地址。iPhone Safari 通过“分享 → 添加到主屏幕”，Android 使用浏览器的“安装应用”或“添加到主屏幕”。独立窗口与浏览器标签页可能需要分别登录；主屏幕安装仍需要连接服务器。

## 添加 Grok Build

使用同一发行源码中的 [Grok 账户服务叠加配置](harness-runtimes.md#启用-grok-build-与托管账户续期)，再完成设备登录。应用与辅助服务默认使用相同的 0.2.4 镜像；Codex 继续可用。账户卷和 socket 卷各自持久化，无需保留宿主机终端会话。已有 `.env` 请检查旧镜像覆盖项，并保留原 Compose 项目和卷名。

[按需启用 ZCode 会话运行环境](harness-runtimes.md#zcode)。
