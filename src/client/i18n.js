export const LOCALE_STORAGE_KEY = "panda-force-locale";
export const LOCALE_PREFERENCES = Object.freeze(["system", "zh-CN", "en"]);

const ZH_CN = Object.create(null);

Object.assign(ZH_CN, {
  "Answer submitted": "回答已提交",
  "Your answer has been sent to the conversation.": "回答已直接发送到对话。",
  "Choose or write your answers, then submit them directly to the conversation.":
    "选择或填写答案，点击提交即可直接发送到对话。",
  "Check the message delivery status before sending again.": "请先检查消息发送状态，避免重复发送。",
  "Conversation changed; reopen the question before submitting.": "会话已切换，请重新打开问题后提交。",
  "A message is still being sent. Please wait and try again.": "消息正在发送，请稍后重试。",
  "Earlier question": "此前的提问",
  "Question for you": "需要你回答的问题",
  "Choose an answer": "选择或填写答案",
  "Add answer to message": "将回答加入消息",
  "Answer added to message": "回答已加入输入框",
  "Send the message to deliver your answer.": "发送消息后，回答才会提交。",
  "Choose or write an answer, add it to your message, then send it in the conversation.":
    "选择或填写答案，加入输入框后发送，即可在对话中回答。",
  "You continued the conversation. This question is kept as history.": "你已继续对话，此提问仅作为历史记录保留。",
  "Answered {answered} of {total} questions": "已回答 {answered} / {total} 题",
  "Choose one option for this question.": "请选择一个选项。",
  "Enter an answer for this question.": "请填写此题的答案。",
  "Please enter an answer before submitting.": "请填写答案后再提交。",
  Close: "关闭",
  Reason: "申请原因",
  "Allow once": "允许本次",
  Deny: "拒绝",
  "Allow this conversation": "允许此会话",
  "Allow similar commands": "允许类似命令",
  "Allow all edits": "允许全部修改",
  "Always allow": "始终允许",
  "Approval options": "审批选项",
  "Allow ChatGPT to run this command?": "允许执行此命令吗？",
  "Allow ChatGPT to edit the following file?": "允许修改以下文件吗？",
  "Allow ChatGPT to edit the following files?": "允许修改以下文件吗？",
  "Internet access": "网络访问",
  "Edit files": "修改文件",
  "Reload latest project details": "重新加载最新项目资料",
  "Files from your sessions": "会话中的文件",
  "Open a session to browse and preview files from its working folder.": "打开会话，浏览和预览该会话工作目录中的文件。",
  "Browse session files": "浏览会话文件",
  "Requests requiring your attention": "待你处理的请求",
  "Review requests ({count})": "处理待确认请求（{count}）",
  "Could not submit the decision. The request is still waiting; please retry.": "决定提交失败，审批仍在等待，请重试。",
  "Current workspace": "当前工作台",
  Sessions: "会话",
  Session: "会话",
  sessions: "个会话",
  "New session": "新建会话",
  Unassigned: "未关联项目",
  "Unassigned sessions": "未关联项目的会话",
  "Project name": "项目名称",
  "Project code": "项目 code",
  "Description (optional)": "项目描述（可选）",
  "Create project": "创建项目",
  "Edit project": "编辑项目",
  "Save project": "保存项目",
  "Change project": "更改关联项目",
  "Link existing sessions": "关联历史会话",
  "Project sessions": "项目会话",
  "Link selected sessions": "关联所选会话",
  "Save association": "保存关联",
  "Load older sessions": "加载更早的会话",
  "No matching sessions": "没有匹配的会话",
  "Search sessions": "搜索会话",
  "Search sessions…": "搜索会话…",
  "Search by session name or working folder…": "按会话名称或工作目录搜索…",
  "Currently in {project}": "当前项目：{project}",
  "Already linked": "已关联",
  "{count} sessions selected": "已选择 {count} 个会话",
  "Unique code, 2–64 characters: letters, numbers, hyphens or underscores.":
    "code 需唯一，2–64 位，支持英文字母、数字、连字符和下划线。",
  "Linking changes only the project association. Session contents and working folders are kept.":
    "这里只更改项目关联，会话内容和工作目录保持不变。",
  "Create projects and organize their sessions.": "创建独立项目，按项目组织会话。",
  "Create your first project. Existing sessions are available under Sessions.":
    "创建第一个项目。已有会话可以在“会话”中找到。",
  "No description": "暂无项目描述",
  "Choose a project to continue.": "请选择项目后继续。",
  "No sessions found": "没有找到会话",
  "Create a session or change your filters to get started.": "创建会话，或调整搜索和筛选条件。",
  "Untitled session": "未命名会话",
  "Recent sessions": "最近会话",
  "View all sessions": "查看全部会话",
  "Session status": "会话状态",
  "All sessions": "全部会话",
  "Browse sessions and their project associations.": "查看会话及其关联项目。",
  "Choose a project to organize sessions. Select a working folder separately when you need one.":
    "用项目组织会话，需要时单独选择会话的工作目录。",
  "Showing the first 100 matches. Refine your search to find another session.":
    "已显示前 100 个匹配会话，可继续搜索以缩小范围。",
  "Session unavailable": "会话暂不可用",
  "Return to sessions or retry this session.": "返回会话列表，或重试打开此会话。",
  "Retry session": "重试会话",
  "Loaded sessions": "已加载会话",
  "Ctrl/Cmd+K searches. Ctrl/Cmd+Shift+K creates a session.": "Ctrl/Cmd+K 搜索，Ctrl/Cmd+Shift+K 新建会话。",
  "Working folder": "工作目录",
  "Choose working folder": "选择工作目录",
  "Choose where new sessions should work.": "选择新会话执行操作时使用的目录。",
  "No working folder": "不指定工作目录",
  "Session files": "会话文件",
  "Working folder used for new sessions": "新会话使用的工作目录",
  "Project not found": "项目不存在",
  "Invalid project details": "项目资料格式不正确",
  "Project name must contain 1–100 characters.": "项目名称需为 1–100 个字符。",
  "Project code must contain 2–64 letters, numbers, hyphens or underscores.":
    "项目 code 需为 2–64 位英文字母、数字、连字符或下划线。",
  "Project description must be 2000 characters or fewer.": "项目描述最多 2000 个字符。",
  "A project with this code already exists.": "已有项目使用此 code，请更换。",
  "Projects changed in another window. Review the latest information and try again.":
    "项目资料已在其他窗口更新，请核对最新信息后重试。",
  "Select between 1 and 100 sessions.": "请选择 1–100 个会话。",
  "Invalid session selection": "会话选择无效",
  "Session not found. Refresh the session list and try again.": "会话不存在，请刷新会话列表后重试。",
  "Project information is temporarily unavailable. Please retry.": "项目资料暂不可用，请重试。",

  "Sent at {time}": "发送于 {time}",
  "Received at {time}": "接收于 {time}",
  Errors: "错误提示",
  Error: "错误",
  "Dismiss error": "关闭错误提示",
  "Waiting for your answer": "等待你的回答",
  "Write your own answer": "自行填写",
  "Write your answer…": "填写你的回答…",
  "Submit answer": "提交回答",
  "Submitting…": "正在提交…",
  "Could not submit answer": "无法提交回答",
  Preview: "预览",
  Source: "源码",
  Find: "查找",
  "Find in file": "在文件中查找",
  Wrap: "换行",
  Unwrap: "取消换行",
  "Enable word wrap": "启用自动换行",
  "Disable word wrap": "关闭自动换行",
  "Copy file": "复制文件内容",
  "Read only": "只读",
  "Syntax highlighting was disabled for this large file to keep the browser responsive.":
    "文件较大，已关闭语法高亮以保持浏览器响应。",
  "Copy failed": "复制失败",
  Download: "下载",
  "Close file preview": "关闭文件预览",
  "Loading file…": "正在加载文件…",
  "File unavailable": "文件不可用",
  "This file is too large to preview.": "文件过大，无法预览。",
  "Preview is not available for this file type.": "暂不支持预览此文件类型。",
  "PDF preview is not available in this browser.": "此浏览器暂不支持 PDF 预览。",
  "Only the first 20,000 lines are shown.": "仅显示前 20,000 行。",
  "Log in": "登录",
  "Welcome back": "欢迎回来",
  "Your sign-in has expired. Your page and draft are kept here. Sign in again to continue.":
    "登录已过期，当前页面和草稿已保留。请重新登录后继续。",
  "Sign-in verification is temporarily unavailable. Retrying in the background.":
    "登录状态暂时无法校验，正在后台重试。",
  "Sign in again": "重新登录",
  "Your workspace": "你的工作区",
  "First-time setup": "首次安装",
  "One last step": "即将完成",
  "Create your administrator": "创建管理员账号",
  "Create administrator": "创建管理员",
  "Creating administrator…": "正在创建管理员…",
  "Complete your administrator account": "完善管理员账号",
  "Administrator setup": "管理员初始化",
  "Complete administrator setup": "完善管理员信息",
  "Administrator username": "管理员账号",
  Username: "账号",
  "Installation code": "安装码",
  "Find this one-time code in the server startup log.": "请在服务启动日志中查看本次安装码。",
  "Set up your account to make this workspace yours.": "设置管理员账号，开始使用你的工作区。",
  "Your existing password is verified. Choose a username to finish setup.": "原密码验证成功，设置账号即可完成升级。",
  "Sign in with your existing password to complete administrator setup.": "请先使用原密码登录，再完善管理员账号。",
  "Sign in to continue to your workspace.": "登录后，继续你的工作。",
  "Use at least 6 characters, including uppercase and lowercase letters and a number.":
    "至少 6 位，须包含大写字母、小写字母和数字。",
  "Your PandaForce account is separate from your Codex account.":
    "此账号用于登录 PandaForce，与 Codex 模型账号相互独立。",
  "Your own workspace. Ready when you are.": "你的工作区，随时开始。",
  "Preparing your workspace": "正在准备工作台",
  "Your workspace is ready": "工作台已就绪",
  "Getting your projects, sessions and tools ready.": "正在为你准备项目、会话和工具。",
  "Everything is ready. You can get started.": "准备完成，可以开始使用。",
  "Some information could not be loaded. Reload to try again.": "部分信息暂时无法加载，请重新加载后重试。",
  "Still loading. Your workspace is taking a little longer to respond.": "仍在加载，工作台响应需要多一点时间。",
  "Preparing the interface": "准备工作台界面",
  "Connecting to your workspace": "连接工作台服务",
  "Loading workspace settings": "读取工作台设置",
  "Loading projects": "读取项目列表",
  "Loading recent sessions": "加载最近会话",
  "Loading available models": "加载可用模型",
  "Loading permissions": "读取权限设置",
  "{completed} of {total} steps ready": "已完成 {completed}/{total} 项准备",
  "Elapsed: {seconds}s": "已用时 {seconds} 秒",
  "Reload workspace": "重新加载工作台",
  "Continue to workspace": "先进入工作台",
  "Show password": "显示密码",
  "Hide password": "隐藏密码",
  "Save and continue": "保存并继续",
  "Saving…": "正在保存…",
  "Incorrect username or password": "账号或密码不正确",
  "Use 3–64 letters, numbers, dots, underscores, @ or hyphens for the username.":
    "账号需为 3–64 位，可使用英文字母、数字及 . _ @ -。",
  "Password must be 6–256 characters and include uppercase and lowercase letters and a number.":
    "密码需为 6–256 位，且包含大写字母、小写字母和数字。",
  "The installation code is incorrect. Check the server startup log.": "安装码不正确，请查看服务启动日志。",
  "An administrator account already exists. Log in to continue.": "管理员账号已创建，请登录后继续。",
  "Administrator setup is no longer available": "管理员初始化已关闭",
  "Verify your existing password before creating the administrator account.": "请先验证原密码，再完善管理员账号。",
  "Unable to save the administrator account": "无法保存管理员账号，请检查数据目录权限。",
  "Authentication request was rejected": "登录请求未通过验证，请刷新后重试。",
  "Invalid authentication request": "登录信息格式不正确，请重试。",
  "Too many attempts. Please try again in a few minutes.": "尝试次数较多，请几分钟后重试。",
  "Connection unavailable": "连接暂不可用",
  "Please try again": "请重试",
  "Could not open the workspace. Please reload.": "无法打开工作区，请刷新页面重试。",
  "Log out": "退出登录",
  Password: "密码",
  "Confirm password": "确认密码",
  "Set a LAN password": "设置局域网密码",
  "New password": "新密码",
  "Set password": "设置密码",
  "Setting password…": "正在设置密码…",
  "Logging in…": "正在登录…",
  "Passwords do not match": "两次输入的密码不一致",
  "A password was already set. Log in to continue.": "密码已设置，请登录后继续。",
  "Unable to set the password": "无法设置密码",
  "Unable to log in": "无法登录",
  "Current engine: Codex": "当前引擎：Codex",
  "PandaForce login": "PandaForce 登录",
  "PandaForce password setup": "PandaForce 密码设置",
  "New task": "新任务",
  "New chat": "新对话",
  "New tab": "新标签页",
  Search: "搜索",
  "Search chats": "搜索对话",
  "Close search": "关闭搜索",
  Projects: "项目",
  "Loading projects…": "正在加载项目…",
  "Could not load file preview. Please retry.": "无法加载文件预览，请重试。",
  "Could not load terminal. Close and reopen to retry.": "无法加载终端，请关闭后重新打开重试。",
  "Could not load projects": "无法加载项目",
  "No visible projects": "暂无显示的项目",
  "Project options": "项目选项",
  "Project options for “{name}”": "项目“{name}”的选项",
  "Hide project": "隐藏项目",
  "New session": "新建会话",
  "Project hidden. Creating a new session will show it again.": "项目已隐藏，新建会话后将重新显示。",
  "Could not hide project": "无法隐藏项目",
  "Could not restore project": "无法恢复项目",
  "Project restored": "项目已恢复",
  "Project is still hidden": "项目仍处于隐藏状态",
  Undo: "撤销",
  Project: "项目",
  Tasks: "任务",
  Connecting: "正在连接",
  "Connecting to Codex": "正在连接 Codex",
  "Connecting to Codex…": "正在连接 Codex…",
  "Loading sessions…": "正在加载会话…",
  "Could not load sessions": "无法加载会话",
  "Codex connected": "Codex 已连接",
  Settings: "设置",
  Profile: "个人资料",
  Usage: "用量",
  "Keyboard shortcuts": "键盘快捷键",
  Help: "帮助",
  "Open profile menu": "打开个人资料菜单",
  "Open settings": "打开设置",
  "Toggle sidebar": "切换侧边栏",
  "Toggle summary": "切换摘要",
  "Toggle side panel": "切换右侧面板",
  "What can I help?": "我能帮你做些什么？",
  "Do anything": "告诉我你想完成什么",
  "Task prompt": "任务输入",
  "Composer suggestions": "输入建议",
  "Attached context": "已附加的上下文",
  "Attach files and folders": "附加文件和文件夹",
  "Attach files": "添加附件",
  Attachments: "附件",
  "Uploading…": "正在上传…",
  "Upload failed": "上传失败",
  "Remove attachment {name}": "移除附件 {name}",
  "You can attach up to 10 files": "最多添加 10 个附件",
  "Each attachment must be 25 MiB or smaller": "每个附件不能超过 25 MiB",
  "Cannot upload an empty file": "无法上传空文件",
  "Invalid attachment filename": "附件文件名无效",
  "Image content does not match its file type": "图片内容与文件类型不符",
  "Could not save attachment": "无法保存附件",
  Queue: "排队",
  "Queue message (Tab)": "消息排队（Tab）",
  "Queued messages": "排队消息",
  "Queueing…": "正在排队…",
  Queued: "已排队",
  "Starting message…": "正在启动…",
  "Queue failed": "排队失败",
  "Queue unconfirmed": "排队待确认",
  "Cancel queued message": "取消排队",
  "Dismissing message": "移除消息",
  "Cancelling…": "正在取消…",
  "Send message": "发送消息",
  Copy: "复制",
  "Copy message": "复制消息",
  Copied: "已复制",
  "Copy failed. Please select and copy the message manually.": "复制失败，请选中消息文字手动复制。",
  Session: "会话",
  "Goal in progress": "Goal 进行中",
  "Goal paused": "Goal 已暂停",
  "Goal blocked": "Goal 已阻塞",
  "Goal usage limited": "Goal 已达到用量限制",
  "Goal budget limited": "Goal 已达到预算限制",
  "Goal completed": "Goal 已完成",
  "Goal failed": "Goal 失败",
  "Goal status": "Goal 状态",
  "Show Goal details": "查看 Goal 详情",
  "Hide Goal details": "隐藏 Goal 详情",
  "Goal details": "Goal 详情",
  "Goal actions": "Goal 操作",
  "Resume goal": "恢复 Goal",
  "Clear goal": "清除 Goal",
  "Goal objective": "Goal 目标",
  "Goal objective cannot be empty": "Goal 目标不能为空",
  "Goal updated": "Goal 已更新",
  "Start a task first": "请先开始一个任务",
  Objective: "目标",
  Save: "保存",
  "Saving…": "正在保存…",
  "No active session": "当前没有活动会话",
  "Copy session marker": "复制会话标记",
  "Session marker copied": "会话标记已复制",
  "Send this marker when reporting a session problem.": "报告会话问题时，请发送此标记。",
  "Session name": "会话名称",
  "Rename session": "重命名会话",
  "Save session name": "保存会话名称",
  "Session name cannot be empty": "会话名称不能为空",
  "Session renamed": "会话已重命名",
  "Auto-generated from first message": "根据第一条消息自动生成",
  "Model unavailable": "模型信息不可用",
  Steer: "插入消息",
  "In progress": "进行中",
  "Loading conversation…": "正在加载会话…",
  "Refreshing conversation…": "正在重新同步会话…",
  "Conversation resynchronized": "会话已重新同步",
  "Could not refresh conversation": "无法重新同步会话",
  "Task failed": "任务失败",
  "Task failed: {message}": "任务失败：{message}",
  "Last activity: {time}": "上次活动：{time}",
  "Activity time unavailable": "暂无活动时间",
  "Sending…": "发送中…",
  Sent: "已发送",
  "Send failed": "发送失败",
  "Pin project": "置顶项目",
  "Unpin project": "取消置顶",
  "Pin project “{name}”": "置顶项目“{name}”",
  "Unpin project “{name}”": "取消置顶项目“{name}”",
  Pinned: "已置顶",
  "Pin session": "置顶会话",
  "No pinned sessions": "暂无置顶会话",
  "Unpin session": "取消置顶会话",
  "Pin session “{title}”": "置顶会话“{title}”",
  "Unpin session “{title}”": "取消置顶会话“{title}”",
  "Fork session": "分叉会话",
  "Session options": "会话选项",
  "Session options for “{title}”": "会话“{title}”选项",
  "Session status": "会话状态",
  "Not started": "尚未执行",
  Completed: "已完成",
  "Status syncing…": "状态同步中…",
  Stopped: "已停止",
  "Show more sessions": "更多",
  "Load earlier messages": "加载更早消息",
  "Delivery unconfirmed": "发送待确认",
  Stop: "停止",
  "Change permissions": "更改权限",
  "Ask for approval": "请求审批",
  "How should agent actions be approved?": "智能体的操作应如何审批？",
  "Context usage": "上下文用量",
  "Reasoning effort": "思考强度",
  "Loading models…": "正在加载模型…",
  "Model load failed · Retry": "模型加载失败 · 重试",
  "Could not load models": "无法加载模型",
  "Retry loading models": "重新加载模型",
  None: "无",
  Minimal: "最低",
  Low: "低",
  Medium: "中",
  High: "高",
  "Extra High": "极高",
  Max: "最大",
  Ultra: "超高",
  Review: "审阅",
  Terminal: "终端",
  Browser: "浏览器",
  Files: "文件",
  Git: "Git",
  "Git changes": "Git 更改",
  Changes: "更改",
  "Unversioned files": "未纳入版本控制的文件",
  "No local changes.": "暂无本地更改。",
  "Git status unavailable.": "Git 状态不可用。",
  file: "个文件",
  files: "个文件",
  Modified: "已修改",
  Added: "已添加",
  Deleted: "已删除",
  Renamed: "已重命名",
  Conflict: "冲突",
  Unversioned: "未跟踪",
  Changed: "已更改",
  "Back to files": "返回文件",
  "Close all": "关闭全部",
  "You can open up to 9 files at once. Close a tab first.": "最多只能同时打开 9 个文件，请先关闭一个标签页。",
  "Git status: {status}": "Git 状态：{status}",
  Diff: "差异",
  History: "历史",
  "Search files": "搜索文件",
  "Refresh files": "刷新文件",
  "Clear file search": "清除文件搜索",
  "Loading files…": "正在加载文件…",
  "Searching files…": "正在搜索文件…",
  "No files found": "未找到文件",
  "No files in this folder.": "此文件夹中没有文件。",
  "Choose a project to browse files.": "请选择项目以浏览文件。",
  "Choose project folder": "选择项目文件夹",
  "Could not load files.": "无法加载文件。",
  "More files are hidden. Search to find them.": "还有更多文件未显示，请使用搜索查找。",
  "Side task": "子任务",
  "Side tasks": "子任务",
  Summary: "摘要",
  Environment: "环境",
  Scheduled: "计划任务",
  "Computer Use": "电脑操作",
  "Computer use": "电脑操作",
  Plan: "计划",
  Sources: "来源",
  "Local workspace": "本地工作区",
  "Remote workspace": "远程工作区",
  "No project": "无项目",
  "No changes yet": "暂无更改",
  "Changes will appear here.": "文件更改会显示在这里。",
  "Switch to split diff": "切换到并排差异",
  "Switch to unified diff": "切换到统一差异",
  "Toggle word wrap": "切换自动换行",
  "Enable word wrap": "启用自动换行",
  "Disable word wrap": "关闭自动换行",
  "Collapse all diffs": "折叠所有差异",
  "Expand all diffs": "展开所有差异",
  "Undo changes": "撤销更改",
  "Reapply changes": "重新应用更改",
  "Changes reverted": "更改已撤销",
  "Changes reapplied": "更改已重新应用",
  "This task is currently running in another Codex app or CLI. Close it there, then try again.":
    "此任务正在另一个 Codex 应用或 CLI 中运行。请先在那里关闭或结束任务，然后重试。",
  "This task could not be found. Refresh the task list and try again.": "找不到此任务。请刷新任务列表后重试。",
  "Delete thread": "删除任务",
  "Delete thread “{title}”": "删除任务“{title}”",
  "Delete “{title}”? This permanently deletes the thread and its descendants.":
    "删除“{title}”？这将永久删除此任务及其子任务。",
  "Thread deleted": "任务已删除",
  "Could not delete thread": "无法删除任务",
});

Object.assign(ZH_CN, {
  General: "通用",
  Appearance: "外观",
  Configuration: "配置",
  Personal: "个人",
  Integrations: "集成",
  Coding: "编程",
  Archived: "已归档",
  "Archived chats": "已归档的对话",
  Plugins: "插件",
  Skills: "技能",
  Connections: "连接",
  "Cloud preferences": "云端偏好设置",
  "Cloud environments": "云端环境",
  "Code review": "代码审阅",
  Git: "Git",
  Hooks: "钩子",
  Worktrees: "工作树",
  "Back to app": "返回应用",
  "Back to settings": "返回设置",
  "Search settings": "搜索设置",
  "Search settings…": "搜索设置…",
  "Clear settings search": "清除设置搜索",
  "No results found": "未找到结果",
  Permissions: "权限",
  "Auto-review": "代我审批",
  "Show “Approve for me” in the composer": "在输入框中显示“代我审批”",
  "Full access": "完全访问权限",
  "Show unrestricted access in the composer": "在输入框中显示不受限制的访问权限",
  "Selected mode": "所选模式",
  "Permission mode used for new turns": "新任务使用的权限模式",
  "Working folder used for new chats": "新对话使用的工作文件夹",
  Notifications: "通知",
  "Task notifications": "任务通知",
  "Show a browser notification when a task completes": "任务完成时显示浏览器通知",
  "Task completed": "任务完成",
  "Browser notifications are blocked": "浏览器通知已被阻止",
  Theme: "主题",
  System: "系统",
  Language: "语言",
  "Interface language": "界面语言",
  "System default": "跟随系统",
  "Interface scale": "界面缩放",
  Default: "默认",
  Model: "模型",
  Approval: "审批",
  "Web search": "网页搜索",
  Automatic: "自动",
  "Installed plugins": "已安装的插件",
  "Plugin sources": "插件来源",
  "Installed skills": "已安装的技能",
  "Not configured": "未配置",
  "Browser access": "浏览器访问",
  "Network access": "网络访问",
  "Inherited from permissions": "继承自权限设置",
  "Connected services": "已连接的服务",
  "Diff view": "差异视图",
  Unified: "统一",
  "Branch format": "分支格式",
  Environments: "环境",
  "Review instructions": "审阅说明",
  "Git integration": "Git 集成",
  "Configured hooks": "已配置的钩子",
  "Worktree behavior": "工作树行为",
  "Turn on Full Access?": "启用完全访问权限？",
  "The connected agent can run commands, access the internet, and create or edit files anywhere in its execution environment without asking for approval.":
    "连接的智能体无需再次确认，即可执行命令、访问互联网，并在其运行环境的任意位置创建或修改文件。",
  "Files and folders": "文件和文件夹",
  "Read, create, modify, upload, or delete files anywhere on this computer":
    "读取、创建、修改、上传或删除这台电脑任意位置的文件",
  "Terminal commands": "终端命令",
  "Run commands, install software, and change system settings": "运行命令、安装软件和更改系统设置",
  "Internet and connected apps": "互联网和已连接的应用",
  "Access websites, send data, and use enabled plugins": "访问网站、发送数据并使用已启用的插件",
  Cancel: "取消",
  Confirm: "确认",
  Ready: "就绪",
  "Browser navigation": "浏览器导航",
  "Go back": "后退",
  "Go forward": "前进",
  "Refresh page": "刷新页面",
  "Browser URL": "浏览器网址",
  "Enter URL": "输入网址",
  "Go to URL": "打开网址",
  "Open in new tab": "在新标签页打开",
  "Enter a URL to browse": "输入网址开始浏览",
  "Pages stay in their original site context. Some sites do not allow embedding.":
    "网页会保留原站点上下文，部分网站不允许嵌入显示。",
  "Loading page…": "正在加载页面…",
  "Page could not be embedded": "无法嵌入此页面",
  "Open externally": "在外部打开",
  "Embedded browser page": "嵌入式浏览器页面",
  "Close panel": "关闭面板",
  "Close summary": "关闭摘要",
  "Open side panel tab": "打开右侧面板标签页",
  "Task side panel": "任务右侧面板",
  Image: "图片",
  "Image unavailable": "图片不可用",
  "Open original": "打开原图",
  "Close image viewer": "关闭图片查看器",
  "Image could not be loaded.": "无法加载图片。",
});

Object.assign(ZH_CN, {
  Working: "正在处理",
  Completed: "已完成",
  "Tool failed": "工具调用失败",
  Thinking: "思考中",
  Thought: "已思考",
  "Running command": "正在运行命令",
  "Ran command": "已运行命令",
  "Command failed": "命令运行失败",
  "Editing files": "正在编辑文件",
  "Edited a file": "已编辑 1 个文件",
  "Edited files": "已编辑文件",
  "File edit failed": "文件编辑失败",
  Reading: "正在读取",
  Read: "已读取",
  Searching: "正在搜索",
  Searched: "已搜索",
  Listing: "正在列出",
  Listed: "已列出",
  "Viewing images": "正在查看图片",
  "Viewed image": "已查看图片",
  "Viewed images": "已查看图片",
  "Image view failed": "图片查看失败",
  "Searching the web": "正在搜索网页",
  "Searched the web": "已搜索网页",
  "Search failed": "搜索失败",
  "Starting side task": "正在启动子任务",
  "Started side task": "已启动子任务",
  "Sending input to side task": "正在向子任务发送消息",
  "Sent input to side task": "已向子任务发送消息",
  "Resuming side task": "正在恢复子任务",
  "Resumed side task": "已恢复子任务",
  "Waiting for side tasks": "正在等待子任务",
  "Waited for side tasks": "已等待子任务",
  "Closing side task": "正在关闭子任务",
  "Closed side task": "已关闭子任务",
  "Updating side task": "正在更新子任务",
  "Updated side task": "已更新子任务",
  "Side task failed": "子任务失败",
  "Side task interrupted": "子任务已中断",
  "Side task active": "子任务正在运行",
  "Side task started": "子任务已启动",
  "Waiting for approval": "正在等待审批",
  Worked: "处理过程",
  "Activity failed": "操作失败",
  "Read files": "已读取文件",
  "Ran commands": "已运行命令",
  "Edited files": "已编辑文件",
  "No output": "无输出",
  Success: "成功",
  Failed: "失败",
  Stopped: "已停止",
  "Stopped command": "已停止命令",
  "Waiting for patch details…": "正在等待补丁详情…",
  "No patch details": "无补丁详情",
  "Plan mode": "规划模式",
  "Approve for me": "代我审批",
  "Always ask for permission before editing external files or using the internet":
    "编辑工作区外的文件或使用互联网前始终请求许可",
  "Only ask for actions detected as potentially unsafe": "仅在检测到可能不安全的操作时请求许可",
  "Not allowed by managed settings": "受管理设置限制，无法使用",
  Custom: "自定义",
  "Custom (config.toml)": "自定义（config.toml）",
  "Custom permissions": "自定义权限",
  "Custom permission profile": "自定义权限配置",
  "Uses permissions defined in config.toml": "使用 config.toml 中定义的权限",
  "Unrestricted access to the internet and any file on your computer": "不受限制地访问互联网和此电脑上的任意文件",
  "API key mode": "API 密钥模式",
  "Codex model account": "Codex 模型账号",
  "Codex model account quota across all sessions.": "Codex 模型账号额度，涵盖所有会话。",
  "5-hour limit": "5 小时额度",
  Refresh: "刷新",
  "Weekly limit": "每周额度",
  used: "已用",
  remaining: "剩余",
  "Resets at": "重置时间",
  "Resets in {days}d {hours}h {minutes}m": "{days}天{hours}小时{minutes}分钟后",
  "Updated at": "更新时间",
  "Reset time unavailable": "重置时间不可用",
  "Usage data unavailable": "暂无用量数据",
  "Loading usage…": "正在加载用量…",
  "Connect to Codex to load usage": "连接 Codex 后可查看用量",
  "No Codex quota data. ChatGPT sign-in is required.": "暂无 Codex 额度数据，需要登录 ChatGPT 账户。",
  "Unable to load usage. Check Codex sign-in and retry.": "无法加载用量，请检查 Codex 登录状态并重试。",
  Reasoning: "思考强度",
  "Select model": "选择模型",
  Back: "返回",
  "No matching tasks": "没有匹配的任务",
  "No subfolders": "没有子文件夹",
  "Loading folders…": "正在加载文件夹…",
  "No folder selected": "尚未选择文件夹",
  "Use this folder": "使用此文件夹",
  "Choose where new tasks should work.": "选择新任务的工作位置。",
  None: "无",
  "Don't work in a project": "不在项目中工作",
  "Parent folder": "上一级文件夹",
  Go: "前往",
  "Side tasks started by this chat will appear here.": "此对话启动的子任务会显示在这里。",
  "No side tasks": "没有子任务",
  "Choose a project folder accessible to PandaForce on the connected machine.":
    "选择或切换 PandaForce 运行环境中可访问的项目文件夹。",
  "Choose project folder": "选择项目文件夹",
  "Open Browser from the right panel to keep it beside the chat.": "请从右侧面板打开浏览器，以便与对话并排显示。",
  "Scheduled task data requires the native desktop bridge.": "计划任务数据需要原生桌面桥接。",
  "Computer Use controls require the native desktop bridge.": "电脑操作控件需要原生桌面桥接。",
  "Plan data is not exposed by app-server.": "app-server 未提供计划数据。",
  "Side task data requires the native desktop bridge.": "子任务数据需要原生桌面桥接。",
  "Conversation source data is not exposed by app-server.": "app-server 未提供对话来源数据。",
});

const ZH_CN_PATTERNS = [
  [/^(\d+) changed files?$/, (match) => `${match[1]} 个文件已更改`],
  [/^Review (\d+) changed files?$/, (match) => `审阅 ${match[1]} 个已更改文件`],
  [/^Load earlier messages \((\d+)\)$/, (match) => `加载更早的消息（${match[1]}）`],
  [/^Worked for (.+)$/, (match) => `处理耗时 ${match[1]}`],
  [/^Reasoning: (.+)$/, (match) => `思考强度：${translate(match[1], "zh-CN")}`],
  [/^Model: (.+)$/, (match) => `模型：${match[1]}`],
  [/^Context usage: (\d+)%$/, (match) => `上下文用量：${match[1]}%`],
  [/^(\d+)% full$/, (match) => `已使用 ${match[1]}%`],
  [/^(\d+)% used \((\d+)% left\)$/, (match) => `已使用 ${match[1]}%（剩余 ${match[2]}%）`],
  [/^(\d+)k \/ (\d+)k tokens used$/, (match) => `已使用 ${match[1]}k / ${match[2]}k 令牌`],
  [/^(\d+) images$/, (match) => `${match[1]} 张图片`],
  [/^(\d+) side tasks?$/, (match) => `${match[1]} 个子任务`],
  [/^Ran (.+)$/, (match) => `已运行 ${match[1]}`],
  [/^Stopped (.+)$/, (match) => `已停止 ${match[1]}`],
  [/^Exit code (\d+)$/, (match) => `退出码 ${match[1]}`],
  [/^What can I help with in (.+)\?$/, (match) => `我能为 ${match[1]} 做些什么？`],
  [/^Remove (.+)$/, (match) => `移除 ${match[1]}`],
];

Object.assign(ZH_CN, {
  Workspace: "工作台",
  "Workspace navigation": "工作台导航",
  Deliverables: "交付物",
  Connections: "连接",
  "Project details": "项目详情",
  "Search anything": "搜索任务、项目与操作",
  "Toggle theme": "切换主题",
  "Your next move": "从一个目标开始",
  "What would you like to get done?": "今天，你想完成什么？",
  "Start with a goal. Stay in control, and review the result in one place.":
    "描述目标、掌握进度，在同一个工作台检查成果。",
  "Review a project": "审查一个项目",
  "Prepare a plan": "准备执行计划",
  "Explain this project": "介绍这个项目",
  "Needs review": "待确认",
  Failed: "失败",
  Ready: "就绪",
  "From a goal to a result": "从目标到成果",
  "Choose a project, describe your goal, review requests for approval, then inspect the files. Your PandaForce and model accounts are separate.":
    "选择项目、描述目标、确认需要审批的操作，再查看产出的文件。PandaForce 账号与模型账号相互独立。",
  "Got it": "知道了",
  "Recent tasks": "最近任务",
  "View all tasks": "查看全部任务",
  "No tasks found": "未找到任务",
  "Create a task or change your filters to get started.": "创建任务，或调整筛选条件。",
  "Keep every piece of work in view.": "掌握每项工作的状态与下一步。",
  "Search tasks…": "搜索任务…",
  "Search tasks": "搜索任务",
  "Task status": "任务状态",
  "All tasks": "全部任务",
  "Search projects": "搜索项目",
  "Search projects…": "搜索项目…",
  "Show hidden projects": "显示已隐藏项目",
  "No matching projects": "没有匹配的项目",
  "Organize the context behind your work.": "整理项目背景，让每次工作都有清晰的上下文。",
  "Add project": "添加项目",
  tasks: "个任务",
  Hidden: "已隐藏",
  Pin: "固定",
  Unpin: "取消固定",
  "Hide project": "隐藏项目",
  "Restore project": "恢复项目",
  "Project unavailable": "项目不可用",
  "Choose an accessible project to continue.": "请选择有权访问的项目继续。",
  "Working folder": "工作目录",
  "Project tasks": "项目中的任务",
  "Your tools, with clear capabilities and connection status.": "查看工具的可用能力与连接状态。",
  Connected: "已连接",
  Disconnected: "未连接",
  "Your current execution engine. Model authentication is separate from your PandaForce sign-in.":
    "当前执行引擎。模型登录状态与 PandaForce 登录身份相互独立。",
  "Model and permissions": "模型与权限",
  "Other tools": "其他工具",
  "Claude CLI, SparkForce, PixelForce and the PandaForce plugin runtime are planned. They are not connected to this instance.":
    "Claude CLI、SparkForce、PixelForce 和 PandaForce 插件运行时尚在规划中，当前实例尚未接入。",
  Planned: "规划中",
  "Inspect files in their task context.": "在任务上下文中检查文件。",
  "Files from your tasks": "任务中的文件",
  "Open a task to browse and preview its project files. A consolidated deliverable index is planned for I3.":
    "打开任务即可浏览和预览项目文件。集中交付物索引将在后续迭代提供。",
  "Browse project files": "浏览项目文件",
  "Workspace preparation": "工作台准备进度",
  "Connection status": "连接状态",
  "Loaded tasks": "已加载任务",
  "Retry workspace reads": "重试工作台读取",
  "Retry remaining steps": "重试未完成步骤",
  waiting: "等待中",
  loading: "加载中",
  ready: "已就绪",
  error: "失败",
  "Ctrl/Cmd+K searches. Ctrl/Cmd+Shift+K creates a task.": "Ctrl/Cmd+K 打开搜索；Ctrl/Cmd+Shift+K 创建新任务。",
  "Could not update project": "无法更新项目",
  "Could not complete action": "操作未能完成",
  "Task unavailable": "任务不可用",
  "Return to tasks or retry this task.": "可以返回任务列表，或重试读取该任务。",
  "Retry task": "重试任务",
  "Engines and tools": "引擎与工具",
  "Storage and logs": "存储与日志",
  "Account and security": "账户与安全",
  "Choose light, dark, or follow your system": "选择浅色、深色或跟随系统",
  Light: "浅色",
  Dark: "深色",
  "PandaForce account": "PandaForce 账号",
  "Authenticated PandaForce account": "已登录的 PandaForce 账号",
  "Persistent storage": "持久化存储",
  "Configuration, attachments, logs, plugins, cache and backups use separate directories.":
    "配置、附件、日志、插件、缓存与备份分别存放在独立目录。",
  "Log retention": "日志保留",
  "Logs are written to the console and rolling files. Retention is managed by instance configuration.":
    "日志同时输出到控制台与滚动文件，保留策略由实例配置管理。",
  "Storage configuration": "存储配置",
  "Read only here. Your administrator manages storage and log settings for this instance.":
    "此处只读，由管理员管理当前实例的存储与日志设置。",
  "Choose a project": "选择项目",
});

Object.assign(ZH_CN, { "Describe a task, add files, or start with an idea…": "描述任务、添加文件，或从一个想法开始…" });
Object.assign(ZH_CN, {
  "Showing the first 100 matches. Refine your search to find another task.":
    "当前展示前 100 条匹配结果，可通过搜索定位其他任务。",
});
export function resolveLocale(preference = "system", languages = []) {
  if (preference === "zh-CN") return "zh-CN";
  if (preference === "en") return "en";
  const values = Array.isArray(languages) ? languages : [languages];
  return values.some((value) => /^zh(?:-|$)/i.test(String(value || ""))) ? "zh-CN" : "en";
}

function interpolate(template, values = {}) {
  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) =>
    key in values ? String(values[key]) : match,
  );
}

export function translate(message, locale = "en", values = {}) {
  const source = interpolate(message, values);
  if (locale !== "zh-CN") return source;
  const direct = ZH_CN[message] || ZH_CN[source];
  if (direct) return interpolate(direct, values);
  for (const [pattern, replacement] of ZH_CN_PATTERNS) {
    const match = source.match(pattern);
    if (match) return replacement(match);
  }
  return source;
}

export function createI18n({
  storage = globalThis.localStorage,
  languages = globalThis.navigator?.languages || [],
} = {}) {
  let preference = storage?.getItem?.(LOCALE_STORAGE_KEY) || "system";
  if (!LOCALE_PREFERENCES.includes(preference)) preference = "system";
  let locale = resolveLocale(preference, languages);
  const listeners = new Set();
  const api = {
    get preference() {
      return preference;
    },
    get locale() {
      return locale;
    },
    t(message, values) {
      return translate(message, locale, values);
    },
    setPreference(next) {
      if (!LOCALE_PREFERENCES.includes(next)) return false;
      preference = next;
      locale = resolveLocale(preference, languages);
      storage?.setItem?.(LOCALE_STORAGE_KEY, preference);
      for (const listener of listeners) listener(locale, preference);
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return api;
}

const DOM_I18N_EXCLUDE = [
  "[data-i18n-ignore]",
  "[contenteditable='true']",
  ".message-text",
  ".activity-detail",
  ".activity-output",
  ".approval-reason p",
  ".approval-subtitle",
  ".autocomplete-title",
  ".review-hunks",
  ".side-task-copy small",
  ".terminal-host",
  ".file-preview-editor",
  ".cm-editor",
  ".thread-item",
  ".user-message",
  ".thread-name",
  ".review-file-name",
  ".change-path",
  ".folder-item",
  "code",
  "pre",
  "#accountName",
  "#accountMenuName",
  "#accountMenuSubtitle",
  "#browserUrl",
  "#folderPathInput",
  "#folderSelection",
  "#imageViewerPath",
  "#projectName",
  "#projectPath",
  "#settingsAccountName",
  "#settingsAccountMeta",
  "#summaryWorkspace",
  "#threadPath",
  "#threadTitle",
].join(",");

const TRANSLATED_ATTRIBUTES = ["aria-label", "placeholder", "title"];

function translateTextValue(value, i18n) {
  const source = String(value || "");
  const trimmed = source.trim();
  if (!trimmed) return source;
  const translated = i18n.t(trimmed);
  return translated === trimmed ? source : source.replace(trimmed, translated);
}

function isExcluded(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  if (element?.closest?.("[data-i18n-ui]")) return false;
  return Boolean(element?.closest?.(DOM_I18N_EXCLUDE));
}

export function createDomI18n(i18n, { root = globalThis.document } = {}) {
  if (!i18n || !root?.createTreeWalker) return { refresh() {}, disconnect() {} };

  const view = root.defaultView || root.ownerDocument?.defaultView || globalThis;
  const NodeFilterApi = view.NodeFilter || globalThis.NodeFilter;
  const MutationObserverApi = view.MutationObserver || globalThis.MutationObserver;
  const textState = new WeakMap();
  const attributeState = new WeakMap();

  function translateTextNode(node) {
    if (isExcluded(node)) return;
    const current = node.nodeValue || "";
    let state = textState.get(node);
    if (!state) {
      state = { source: current, last: current };
      textState.set(node, state);
    } else if (current !== state.last) {
      state.source = current;
    }
    const next = translateTextValue(state.source, i18n);
    state.last = next;
    if (current !== next) node.nodeValue = next;
  }

  function translateElementAttributes(element) {
    if (isExcluded(element)) return;
    let states = attributeState.get(element);
    if (!states) {
      states = new Map();
      attributeState.set(element, states);
    }
    for (const name of TRANSLATED_ATTRIBUTES) {
      if (!element.hasAttribute?.(name)) continue;
      const current = element.getAttribute(name) || "";
      let state = states.get(name);
      if (!state) {
        state = { source: current, last: current };
        states.set(name, state);
      } else if (current !== state.last) {
        state.source = current;
      }
      const next = translateTextValue(state.source, i18n);
      state.last = next;
      if (current !== next) element.setAttribute(name, next);
    }
  }

  function translateSubtree(node) {
    if (!node || isExcluded(node)) return;
    if (node.nodeType === 3) {
      translateTextNode(node);
      return;
    }
    if (node.nodeType === 1) translateElementAttributes(node);
    const walker = root.createTreeWalker(node, NodeFilterApi.SHOW_ELEMENT | NodeFilterApi.SHOW_TEXT);
    while (walker.nextNode()) {
      const current = walker.currentNode;
      if (current.nodeType === 3) translateTextNode(current);
      else translateElementAttributes(current);
    }
  }

  function refresh() {
    const documentElement = root.documentElement || root.ownerDocument?.documentElement;
    if (documentElement) documentElement.lang = i18n.locale;
    translateSubtree(root.documentElement || root);
  }

  const observer = MutationObserverApi
    ? new MutationObserverApi((records) => {
        for (const record of records) {
          if (record.type === "characterData") translateTextNode(record.target);
          else if (record.type === "attributes") translateElementAttributes(record.target);
          else for (const node of record.addedNodes) translateSubtree(node);
        }
      })
    : null;
  observer?.observe(root.documentElement || root, {
    attributes: true,
    attributeFilter: TRANSLATED_ATTRIBUTES,
    characterData: true,
    childList: true,
    subtree: true,
  });
  const unsubscribe = i18n.subscribe(refresh);
  refresh();

  return {
    refresh,
    disconnect() {
      observer?.disconnect();
      unsubscribe();
    },
  };
}

export { ZH_CN as zhCNMessages };
