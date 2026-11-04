# PandaForce Free

免费、采用 MIT 许可的 AI 工作台；尽力维护，不承诺 SLA、响应时间或修复期限。允许个人与商业使用、修改和 fork。

[English](./README.md) · [许可证](./LICENSE) · [使用说明](./USAGE.md) · [安全说明](./SECURITY.md) · [更新流程](./UPDATES.md)

## 启动

准备 Bun 1.4.2、Node.js 22、Git 和 Codex CLI。已验证 CLI 0.166.0，后续版本可能改变协议。Windows 尚未完整验证。

```bash
git clone https://github.com/hiforce/panda-force-free.git
cd panda-force-free
bun install --frozen-lockfile
npm rebuild node-pty --build-from-source
npm install -g @openai/codex@0.166.0
codex
bun run start
```

完成 Codex 登录后打开 http://127.0.0.1:8899，首次在浏览器创建管理员，无需预设密码或复杂配置。PandaForce 管理员与模型账号独立。构建终端模块需 Python 3、Make 和 C++ 编译器；Debian/Ubuntu 安装 `python3 build-essential`，macOS 使用 Xcode Command Line Tools。更换 Node 版本后需重新构建 node-pty。依赖安装使用 Bun，以应用版本库中的兼容补丁。

也可使用公共基础镜像构建：

```bash
docker compose up --build -d
docker compose logs codex-webui
docker compose exec -it codex-webui codex
```

Docker 首次设置若要求安装码，从日志读取。默认仅监听宿主机本地，使用持久化卷；不要随意使用 `docker compose down --volumes`，该选项会删除卷中数据。默认 UID/GID 1000，挂载宿主机目录需预先配置权限。共享宿主机 CLI 另需匹配用户、socket 权限和绝对路径。

## 能力与边界

支持原生会话、项目与历史会话关联、审批、逐题单选/允许的文字问卷、图片与剪贴板附件、文件预览、终端、真实加载进度，以及中英文和手机/深色模式。当前只对接 Codex，未对接 Claude；问卷暂不支持同题多选。只显示引擎实际公开提供的推理摘要。

默认本地附件，不含维护者的 OSS 或模型凭据。模型/API、存储、云服务费用由使用者自行承担。所有准入用户共享工作目录、模型状态和命令执行能力，不能视为多租户隔离产品；远程访问需 HTTPS 和认证。

源码安装的应用状态在 `$HOME/.panda-force`，容器默认 `/var/lib/panda-force`；模型状态独立存储。日志同时输出到控制台和 logs，默认 10 MiB × 10 段。项目数据库为 data/projects.sqlite，应使用 SQLite 在线备份或停止应用后备份整个 data 目录。默认附件在 `$CODEX_HOME/codex-webui-uploads`，可用 `CODEX_WEBUI_ATTACHMENT_ROOT` 配置持久化目录。

## 维护与许可

这是尽力维护，不是停止维护，也不是承诺持续更新。没有 SLA、限时响应、限时修复或安全回补保证。指定人员、定制和有时限的服务另行约定；它们不影响本版 MIT 使用权。

本版没有按项目金额收取的 PandaForce 使用费。别人按 MIT 使用、商用、修改或维护 fork 均不收费。其他版本的商业政策不撤回本快照已有权利。

感谢上游 [lezi-fun/codex-webui](https://github.com/lezi-fun/codex-webui) 及贡献者。原作者 MIT 声明完整保留，第三方组件遵循各自许可，见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。本快照不包含提取的专有桌面图片/动画，不含内部提交历史、代理配置或私人部署资料。文件内容校验见 SNAPSHOT.json；本公开仓库可以独立积累后续更新记录。
