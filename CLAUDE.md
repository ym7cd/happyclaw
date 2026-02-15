# HappyClaw — AI 协作者指南

本文档帮助 AI 和工程协作者快速理解项目架构、关键机制与修改边界。

## 1. 项目定位

HappyClaw 是一个自托管的个人 AI Agent 系统：

- **输入**：飞书消息（WebSocket 长连接）+ Web 界面聊天
- **执行**：Docker 容器或宿主机进程中运行 Claude Agent（基于 Claude Agent SDK）
- **输出**：飞书富文本卡片回复 + Web 实时流式推送
- **记忆**：Agent 自主维护 `CLAUDE.md` 和工作区文件，实现跨会话持久记忆

## 2. 核心架构

### 2.1 后端模块

| 模块 | 职责 |
|------|------|
| `src/index.ts` | 入口：.env 加载器（所有 import 之前）、管理员引导、消息轮询（2s）、IPC 监听（1s）、容器生命周期 |
| `src/web.ts` | Hono 框架：路由挂载、WebSocket 升级、HMAC Cookie 认证、静态文件托管 |
| `src/routes/auth.ts` | 认证：登录 / 登出 / 注册、`GET /api/auth/me`（含 `setupStatus`）、设置向导、RBAC、邀请码 |
| `src/routes/groups.ts` | 群组 CRUD、消息分页、会话重置（重建工作区）、群组级容器环境变量 |
| `src/routes/files.ts` | 文件上传（50MB 限制）/ 下载 / 删除、目录管理、路径遍历防护 |
| `src/routes/config.ts` | Claude / 飞书配置（AES-256-GCM 加密存储）、连通性测试、批量应用到所有容器 |
| `src/routes/monitor.ts` | 系统状态：容器列表、队列状态、健康检查（`GET /api/health` 无需认证） |
| `src/routes/memory.ts` | 记忆文件读写（`groups/global/` + `groups/{folder}/`）、全文检索 |
| `src/routes/tasks.ts` | 定时任务 CRUD + 执行日志查询 |
| `src/routes/skills.ts` | Skills 列表与管理 |
| `src/routes/admin.ts` | 用户管理、邀请码、审计日志、注册设置 |
| `src/feishu.ts` | 飞书集成：WebSocket 长连接、消息去重（LRU 1000 条 / 30min TTL）、富文本卡片、Reaction、自动注册回调 |
| `src/container-runner.ts` | 容器生命周期：Docker run + 宿主机进程模式、卷挂载构建、环境变量注入、OUTPUT_MARKER 流式输出解析 |
| `src/group-queue.ts` | 并发控制：最大 20 容器 + 最大 5 宿主机进程、会话级队列、任务优先于消息、指数退避重试 |
| `src/runtime-config.ts` | 配置存储：AES-256-GCM 加密、分层配置（容器级 > 全局 > 环境变量）、变更审计日志 |
| `src/task-scheduler.ts` | 定时调度：60s 轮询、cron / interval / once 三种模式、group / isolated 上下文 |
| `src/file-manager.ts` | 文件安全：路径遍历防护、符号链接检测、系统路径保护（`logs/`、`CLAUDE.md`、`.claude/`、`conversations/`） |
| `src/mount-security.ts` | 挂载安全：白名单校验、黑名单模式匹配（`.ssh`、`.gnupg` 等）、非主会话只读强制 |
| `src/db.ts` | 数据层：SQLite WAL 模式、Schema 版本校验（v1→v10）、核心表定义 |
| `src/config.ts` | 常量：路径、超时、并发限制、会话密钥（优先级：环境变量 > 文件 > 生成，0600 权限） |
| `src/logger.ts` | 日志：pino + pino-pretty |

### 2.2 前端

| 层次 | 技术 |
|------|------|
| 框架 | React 19 + TypeScript + Vite 6 |
| 状态 | Zustand 5（9 个 Store：auth、chat、groups、tasks、monitor、container-env、files、users、skills） |
| 样式 | Tailwind CSS 4（teal 主色调，`lg:` 断点响应式，移动端优先） |
| 路由 | React Router 7（AuthGuard + SetupPage 重定向） |
| 通信 | 统一 API 客户端（8s 超时，FormData 120s）、WebSocket 实时推送 + 指数退避重连 |
| 渲染 | react-markdown + remark-gfm + rehype-highlight（代码高亮）、@tanstack/react-virtual（虚拟滚动） |
| PWA | vite-plugin-pwa（条件启用，Node ≤22） |

#### 前端路由表

| 路径 | 页面 | 权限 |
|------|------|------|
| `/setup` | `SetupPage` — 管理员创建向导 | 公开（仅未初始化时） |
| `/setup/providers` | `SetupProvidersPage` — Claude/飞书配置 | 登录后 |
| `/login` | `LoginPage` | 公开 |
| `/register` | `RegisterPage` | 公开（可通过设置关闭） |
| `/chat/:groupFolder?` | `ChatPage` — 主聊天界面 | 登录后 |
| `/groups` | `GroupsPage` — 会话管理 | 登录后 |
| `/tasks` | `TasksPage` — 定时任务 | 登录后 |
| `/monitor` | `MonitorPage` — 系统监控 | 登录后 |
| `/memory` | `MemoryPage` — 记忆管理 | 登录后 |
| `/skills` | `SkillsPage` — Skills 管理 | 登录后 |
| `/settings` | `SettingsPage` — 系统设置 | 登录后 |
| `/users` | `UsersPage` — 用户管理 | `manage_users` / `manage_invites` / `view_audit_log` |
| `/more` | `MorePage` — 更多功能入口 | 登录后 |

### 2.3 容器 / 宿主机执行

Agent Runner（`container/agent-runner/`）在 Docker 容器或宿主机进程中执行：

- **输入协议**：stdin 接收初始 JSON（`ContainerInput`：prompt、sessionId、groupFolder、chatJid、isMain），IPC 文件接收后续消息
- **输出协议**：stdout 输出 `OUTPUT_START_MARKER...OUTPUT_END_MARKER` 包裹的 JSON（`ContainerOutput`：status、result、newSessionId、streamEvent）
- **流式事件**：`text_delta`、`thinking_delta`、`tool_use_start/end`、`tool_progress`、`hook_started/progress/response`、`status`、`init` —— 通过 WebSocket `stream_event` 消息广播到 Web 端
- **文本缓冲**：`text_delta` 累积到 200 字符后刷新，避免高频小包
- **会话循环**：`query()` → 等待 IPC 消息 → 再次 `query()` → 直到 `_close` sentinel
- **MCP Server**：7 个工具（`send_message`、`schedule_task`、`list/pause/resume/cancel_task`、`register_group`）
- **Hooks**：PreCompact 钩子在上下文压缩前归档对话到 `conversations/` 目录
- **敏感数据过滤**：StreamEvent 中的 `toolInputSummary` 会过滤 `ANTHROPIC_API_KEY` 等环境变量名

### 2.4 执行模式

每个注册群组可选择执行模式（`RegisteredGroup.executionMode`）：

| 模式 | 行为 | 前置依赖 |
|------|------|---------|
| `host` | Agent 作为宿主机进程运行，通过 `claude` CLI 直接访问宿主机文件系统 | Claude Agent SDK（自动安装） |
| `container` | Agent 在 Docker 容器中运行，通过卷挂载访问文件，完全隔离 | Docker Desktop + 构建镜像 |

**注意**：主会话（`folder === main`）在 `loadState()` 中会被自动设为 `host` 模式。宿主机模式通过 `node container/agent-runner/dist/index.js` 启动 agent-runner 进程，agent-runner 内部调用 `@anthropic-ai/claude-agent-sdk`，SDK 内置了完整的 Claude Code CLI 运行时（`cli.js`），无需全局安装。

宿主机模式支持 `customCwd` 自定义工作目录，使用 `MAX_CONCURRENT_HOST_PROCESSES`（默认 5）作为独立的并发限制。

### 2.5 Docker 容器构建

容器镜像（`container/Dockerfile`）基于 `node:22-slim`：

- 安装 Chromium + 系统依赖（用于 `agent-browser` 浏览器自动化）
- 全局安装 `agent-browser` 和 `@anthropic-ai/claude-code`（始终最新版本）
- 局部安装 `@anthropic-ai/claude-agent-sdk`（`"*"` 版本 + 无 lock file = 每次构建安装最新）
- entrypoint.sh：加载环境变量 → 发现 Skills（符号链接）→ 编译 TypeScript → 从 stdin 读取 → 执行
- 以 `node` 非 root 用户运行
- 构建命令：`./container/build.sh`（`CACHEBUST` 参数确保跳过缓存）

## 3. 数据流

### 3.1 消息处理

```
飞书/Web 消息 → storeMessageDirect(db) + broadcastNewMessage(ws)
     → index.ts 轮询 getNewMessages()（2s 间隔）→ 按 chat_jid 分组去重
     → queue.enqueueMessageCheck() 判断容器/进程状态
         ├── 空闲 → runContainerAgent() 启动容器/进程
         ├── 运行中 → queue.sendMessage() 通过 IPC 文件注入
         └── 满载 → waitingGroups 排队等待
     → 流式输出 → onOutput 回调
         → sendFeishuMessage() + broadcastToWebClients() + db.storeMessageDirect()
```

### 3.2 流式显示管道

```
Agent SDK query() → 流式事件 (text_delta, tool_use_start, ...)
  → agent-runner 缓冲文本（200 字符阈值），向 stdout 发射 StreamEvent JSON
  → container-runner.ts 解析 OUTPUT_MARKER，通过 WebSocket stream_event 广播
  → 前端 chat store handleStreamEvent()，更新 StreamingDisplay 组件
  → 系统错误 (agent_error, container_timeout) 通过 new_message 事件清除流式状态
```

StreamEvent 类型在三处定义，**必须保持同步**：
- `container/agent-runner/src/index.ts`（发射端）
- `src/types.ts`（后端类型定义）
- `web/src/stores/chat.ts`（前端消费端）

### 3.3 IPC 通信

| 方向 | 通道 | 用途 |
|------|------|------|
| 主进程 → 容器 | `data/ipc/{folder}/input/*.json` | 注入后续消息 |
| 主进程 → 容器 | `data/ipc/{folder}/input/_close` | 优雅关闭信号 |
| 容器 → 主进程 | `data/ipc/{folder}/messages/*.json` | Agent 主动发送消息（`send_message` MCP 工具） |
| 容器 → 主进程 | `data/ipc/{folder}/tasks/*.json` | 任务管理（创建 / 暂停 / 恢复 / 取消） |

文件操作使用原子写入（先写 `.tmp` 再 `rename`），读取后立即删除。IPC 轮询间隔 1s（`IPC_POLL_INTERVAL`）。

### 3.4 容器挂载策略

| 资源 | 容器路径 | 主会话 | 其他会话 |
|------|---------|--------|---------|
| 工作目录 `groups/{folder}/` | `/workspace/group` | 读写 | 读写（仅自己） |
| 项目根目录 | `/workspace/project` | 读写 | 不可访问 |
| 全局记忆 `groups/global/` | `/workspace/global` | 读写 | 只读 |
| Claude 会话 `data/sessions/{folder}/.claude/` | `/home/node/.claude` | 读写 | 读写（仅自己） |
| IPC 通道 `data/ipc/{folder}/` | `/workspace/ipc` | 读写 | 读写（仅自己） |
| 项目级 Skills `container/skills/` | `/workspace/project-skills` | 只读 | 只读 |
| 用户级 Skills `~/.claude/skills/` | `/workspace/user-skills` | 只读 | 只读 |
| 环境变量 `data/env/{folder}/env` | `/workspace/env-dir/env` | 只读 | 只读 |
| 额外挂载（白名单内） | `/workspace/extra/{name}` | 按白名单 | 按白名单（`nonMainReadOnly` 时强制只读） |

### 3.5 配置优先级

容器环境变量生效顺序（从低到高）：

1. 进程环境变量（`.env`，如存在）
2. 全局 Claude 配置（`data/config/claude-provider.json`）
3. 全局自定义环境变量（`data/config/claude-custom-env.json`）
4. 群组级覆盖（`data/config/container-env/{folder}.json`）

最终写入 `data/env/{folder}/env` → 只读挂载到容器 `/workspace/env-dir/env`。

### 3.6 WebSocket 协议

**服务端 → 客户端（`WsMessageOut`）**：

| 类型 | 用途 |
|------|------|
| `new_message` | 新消息到达（含 `chatJid`、`message`、`is_from_me`） |
| `agent_reply` | Agent 最终回复（含 `chatJid`、`text`、`timestamp`） |
| `typing` | Agent 正在输入指示 |
| `status_update` | 系统状态变更（活跃容器数、宿主机进程数、队列长度） |
| `stream_event` | 流式事件（含 `chatJid`、`StreamEvent`） |

**客户端 → 服务端（`WsMessageIn`）**：

| 类型 | 用途 |
|------|------|
| `send_message` | 发送消息（含 `chatJid`、`content`） |

## 4. 认证与授权

### 4.1 认证机制

- 密码哈希：bcrypt 12 轮（`bcryptjs`）
- 会话有效期：30 天
- Cookie 认证：HMAC 签名，`HttpOnly` + `SameSite=Lax`
- 会话密钥持久化：`data/config/session-secret.key`（0600 权限），优先级：环境变量 > 文件 > 自动生成
- 登录频率限制：5 次失败后锁定 15 分钟（可通过环境变量调整）

### 4.2 RBAC 权限

角色：`admin`（管理员）、`member`（普通成员）

5 种权限：

| 权限 | 说明 |
|------|------|
| `manage_system_config` | 管理系统配置（Claude / 飞书） |
| `manage_group_env` | 管理群组级容器环境变量 |
| `manage_users` | 用户管理（创建 / 禁用 / 删除） |
| `manage_invites` | 邀请码管理 |
| `view_audit_log` | 查看审计日志 |

权限模板：`admin_full`、`member_basic`、`ops_manager`、`user_admin`

### 4.3 审计事件

完整的审计事件类型（`AuthEventType`）：`login_success`、`login_failed`、`logout`、`password_changed`、`profile_updated`、`user_created`、`user_disabled`、`user_enabled`、`user_deleted`、`user_restored`、`user_updated`、`role_changed`、`session_revoked`、`invite_created`、`invite_deleted`、`invite_used`、`recovery_reset`、`register_success`

## 5. 数据库表

SQLite WAL 模式，Schema 经历 v1→v10 演进（`db.ts` 中的 `EXPECTED_SCHEMA_VERSION`）。

| 表 | 主键 | 用途 |
|-----|------|------|
| `chats` | `jid` | 群组元数据（jid、名称、最后消息时间） |
| `messages` | `(id, chat_jid)` | 消息历史（含 `is_from_me`、`source` 标识来源） |
| `scheduled_tasks` | `id` | 定时任务（调度类型、上下文模式、状态） |
| `task_run_logs` | `id` (auto) | 任务执行日志（耗时、状态、结果） |
| `registered_groups` | `jid` | 注册的会话（folder 映射、容器配置、执行模式、`customCwd`） |
| `sessions` | `group_folder` | 会话 ID 映射（Claude session 持久化） |
| `router_state` | `key` | KV 存储（`last_timestamp`、`last_agent_timestamp`） |
| `users` | `id` | 用户账户（密码哈希、角色、权限、状态） |
| `user_sessions` | `id` | 登录会话（token、过期时间、最后活跃） |
| `invite_codes` | `code` | 注册邀请码（最大使用次数、过期时间） |
| `auth_audit_log` | `id` (auto) | 认证审计日志 |

**注意**：`registered_groups.folder` 允许重复（多个飞书群组可映射到同一 folder）。

## 6. 目录约定

```
groups/{folder}/              # 会话工作目录（Agent 可读写）
groups/{folder}/CLAUDE.md     # 会话私有记忆（Agent 自动维护）
groups/{folder}/logs/         # Agent 容器日志
groups/{folder}/conversations/ # 对话归档（PreCompact Hook 写入）
groups/global/                # 全局共享目录
groups/global/CLAUDE.md       # 全局记忆（所有会话可见，Agent 自动维护）

data/sessions/{folder}/.claude/  # Claude 会话持久化（隔离）
data/ipc/{folder}/input/         # IPC 输入通道
data/ipc/{folder}/messages/      # IPC 消息输出
data/ipc/{folder}/tasks/         # IPC 任务管理
data/env/{folder}/env            # 容器环境变量文件
data/config/                     # 加密配置文件
data/config/claude-provider.json     # Claude API 配置
data/config/feishu-provider.json     # 飞书配置
data/config/claude-custom-env.json   # 自定义环境变量
data/config/container-env/{folder}.json  # 群组级环境变量覆盖
data/config/registration.json    # 注册设置（开关、邀请码要求）
data/config/session-secret.key   # 会话签名密钥（0600 权限）

store/messages.db             # SQLite 数据库（WAL 模式）

config/default-groups.json    # 预注册群组配置
config/mount-allowlist.json   # 容器挂载白名单

container/skills/             # 项目级 Skills（挂载到所有容器）
```

所有 `groups/`、`data/`、`store/` 目录在启动时自动创建（`mkdirSync recursive`），无需手动初始化。

## 7. Web API

### 认证
- `GET /api/auth/status` — 系统初始化状态（`initialized`、是否有用户）
- `POST /api/auth/setup` — 创建首个管理员（仅用户表为空时可用）
- `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me`（含 `setupStatus`）
- `POST /api/auth/register` · `PUT /api/auth/profile` · `PUT /api/auth/change-password`

### 群组
- `GET /api/groups` · `POST /api/groups`（创建 Web 会话）
- `PATCH /api/groups/:jid`（重命名） · `DELETE /api/groups/:jid`
- `POST /api/groups/:jid/reset-session`（重建工作区）
- `GET /api/groups/:jid/messages`（分页 + 轮询，支持多 JID 查询）
- `GET|PUT /api/groups/:jid/env`（群组级容器环境变量）

### 文件
- `GET /api/groups/:jid/files` · `POST /api/groups/:jid/files`（上传，50MB 限制）
- `GET /api/groups/:jid/files/download/:path` · `DELETE /api/groups/:jid/files/:path`
- `POST /api/groups/:jid/directories`

### 记忆
- `GET /api/memory/sources` · `GET /api/memory/search`（全文检索）
- `GET|PUT /api/memory/file`

### 配置
- `GET|PUT /api/config/claude` · `PUT /api/config/claude/secrets`
- `GET|PUT /api/config/claude/custom-env`
- `POST /api/config/claude/test`（连通性测试） · `POST /api/config/claude/apply`（应用到所有容器）
- `GET|PUT /api/config/feishu`

### 任务
- `GET /api/tasks` · `POST /api/tasks` · `PATCH /api/tasks/:id` · `DELETE /api/tasks/:id`
- `GET /api/tasks/:id/logs`

### 管理
- `GET /api/admin/users` · `POST /api/admin/users` · `PATCH /api/admin/users/:id`
- `DELETE /api/admin/users/:id` · `POST /api/admin/users/:id/restore`
- `POST /api/admin/invites` · `GET /api/admin/invites` · `DELETE /api/admin/invites/:code`
- `GET /api/admin/audit-log`
- `GET|PUT /api/admin/settings/registration`

### 监控
- `GET /api/status` · `GET /api/health`（无需认证）

### WebSocket
- `/ws`（详见 §3.6 WebSocket 协议）

## 8. 关键行为

### 8.1 设置向导

首次启动时，`GET /api/auth/status` 返回 `initialized: false`（无任何用户）。前端 `AuthGuard` 检测到未初始化状态后重定向到 `/setup`，引导创建管理员账号（自定义用户名 + 密码，调用 `POST /api/auth/setup`）。创建后自动登录并跳转到 `/setup/providers` 完成 Claude API 和飞书配置。

不存在默认账号。`POST /api/auth/setup` 仅在用户表为空时可用。

### 8.2 飞书自动注册

未注册的飞书群组首次发消息时，通过 `onNewChat` 回调自动注册到主会话（`folder='main'`）。支持多个飞书群组映射到同一个 folder。

### 8.3 无触发词

架构层面已移除触发词概念。注册会话中的新消息直接进入处理流程。

### 8.4 会话隔离

每个会话拥有独立的 `groups/{folder}` 工作目录、`data/sessions/{folder}/.claude` 会话目录、`data/ipc/{folder}` IPC 命名空间。非主会话只能发消息给自己所在的群组。

### 8.5 主会话特权

主会话（`folder === main`）拥有额外权限：
- 挂载项目根目录（读写）
- 全局记忆读写（其他会话只读）
- 跨会话操作（`register_group`、`refresh_groups` MCP 工具）
- IPC 消息可发送到任意群组

### 8.6 回复路由

主会话在 Web 与飞书共用历史（通过 `normalizeMainJid` 映射飞书 JID → `web:main`）。飞书来源的消息回复到飞书，Web 来源的消息仅在 Web 展示。

### 8.7 并发控制

- 最多 20 个并发容器 + 最多 5 个并发宿主机进程（独立计数）
- 任务优先于普通消息
- 失败后指数退避重试（5s→10s→20s→40s→80s，最多 5 次）
- 优雅关闭：`_close` sentinel → `docker stop`（10s） → `docker kill`（5s）
- 容器超时：默认 30 分钟（`CONTAINER_TIMEOUT`）
- 空闲超时：默认 30 分钟（`IDLE_TIMEOUT`），最后一次输出后无新消息则关闭

### 8.8 .env 加载器

`src/index.ts` 顶部（所有 import 之前）包含手动 `.env` 加载器，支持 `export` 前缀和 `#` 注释。替代 Node.js `--env-file` 标志，确保环境变量在模块初始化之前可用。

## 9. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ASSISTANT_NAME` | `HappyClaw` | 助手名称 |
| `WEB_PORT` | `3000` | 后端端口 |
| `WEB_SESSION_SECRET` | 自动生成 | 会话签名密钥 |
| `FEISHU_APP_ID` | - | 飞书应用 ID |
| `FEISHU_APP_SECRET` | - | 飞书应用密钥 |
| `CONTAINER_IMAGE` | `happyclaw-agent:latest` | Docker 镜像名称 |
| `CONTAINER_TIMEOUT` | `1800000`（30min） | 容器最大运行时间 |
| `CONTAINER_MAX_OUTPUT_SIZE` | `10485760`（10MB） | 单次输出最大字节 |
| `IDLE_TIMEOUT` | `1800000`（30min） | 容器空闲超时 |
| `MAX_CONCURRENT_HOST_PROCESSES` | `5` | 宿主机模式并发上限 |
| `MAX_LOGIN_ATTEMPTS` | `5` | 登录失败锁定阈值 |
| `LOGIN_LOCKOUT_MINUTES` | `15` | 锁定持续时间（分钟） |
| `TZ` | 系统时区 | 定时任务时区 |

## 10. 开发约束

- **不要重新引入"触发词"架构**
- **会话隔离是核心原则**，避免跨会话共享运行时目录
- 当前阶段允许不兼容重构，优先代码清晰与行为一致
- 修改容器 / 调度逻辑时，优先保证：不丢消息、不重复回复、失败可重试
- **Git commit message 使用简体中文**，格式：`类型: 简要描述`（如 `修复: 侧边栏下拉菜单无法点击`）
- 系统路径不可通过文件 API 操作：`logs/`、`CLAUDE.md`、`.claude/`、`conversations/`
- StreamEvent 类型必须在三处定义保持同步（§3.2）
- Claude SDK 和 CLI 始终使用最新版本（agent-runner `package.json` 中 `"*"` + 无 lock file）
- 容器内以 `node` 非 root 用户运行，需注意文件权限

## 11. 本地开发

### 常用命令

```bash
make dev           # 启动前后端（首次自动安装依赖和构建镜像）
make dev-backend   # 仅启动后端
make dev-web       # 仅启动前端
make build         # 编译全部（后端 + 前端 + agent-runner）
make start         # 一键启动生产环境
make typecheck     # TypeScript 全量类型检查（后端 + 前端 + agent-runner）
make format        # 格式化代码（prettier）
make install       # 安装全部依赖并编译 agent-runner
make clean         # 清理构建产物（dist/）
make reset-init    # 重置为首装状态（清空数据库和配置，用于测试设置向导）
```

### 端口

- 后端：3000（Hono + WebSocket）
- 前端开发服务器：5173（Vite，代理 `/api` 和 `/ws` 到后端）

### 三个独立的 Node 项目

| 项目 | 目录 | 用途 |
|------|------|------|
| 主服务 | `/`（根目录） | 后端服务 |
| Web 前端 | `web/` | React SPA |
| Agent Runner | `container/agent-runner/` | 容器/宿主机内执行引擎 |

每个项目有独立的 `package.json`、`tsconfig.json`、`node_modules/`。

## 12. 常见变更指引

### 新增 Web 设置项

1. 在对应的 `src/routes/*.ts` 文件中添加鉴权 API
2. 持久化写入 `data/config/*.json`（参考 `runtime-config.ts` 的加密模式）
3. 前端 `SettingsPage` 增加表单

### 新增会话级功能

1. 明确是否需要容器隔离
2. 明确是否写入会话私有目录
3. 同步更新 Web API 路由和前端 Store

### 新增 MCP 工具

1. 在 `container/agent-runner/src/ipc-mcp-stdio.ts` 添加 `server.tool()`
2. 主进程 `src/index.ts` 的 IPC 处理器增加对应 type 分支
3. 重建容器镜像：`./container/build.sh`

### 新增 Skills

1. 项目级：添加到 `container/skills/`（自动挂载到所有容器，通过符号链接发现）
2. 用户级：添加到 `~/.claude/skills/`（自动挂载到所有容器）
3. 无需重建镜像，volume 挂载 + entrypoint.sh 符号链接自动发现

### 新增 StreamEvent 类型

1. `container/agent-runner/src/index.ts` — 添加发射逻辑
2. `src/types.ts` — 添加 `StreamEventType` 联合类型成员和 `StreamEvent` 字段
3. `web/src/stores/chat.ts` — 添加 `handleStreamEvent()` 处理分支
4. 三处必须同步更新

### 修改数据库 Schema

1. 在 `src/db.ts` 中增加 migration 语句
2. 更新 `EXPECTED_SCHEMA_VERSION` 常量
3. 同时更新 `CREATE TABLE` 语句和 migration ALTER/CREATE 语句
