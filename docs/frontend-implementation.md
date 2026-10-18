# 前端实现说明：仿 DeepSeek Harness Web 端

本文说明 `agent_platform/webui/` 这次前端重构的实现细节：设计系统、布局、组件划分、
状态与事件流、Markdown 渲染、人工审批、主题与响应式，以及构建验证和已知限制。

- 适用范围：桌面 Web 为主，移动端为自适应降级
- 技术栈：React 18 + TypeScript + Vite，后端 FastAPI + SSE
- 设计基准：DeepSeek Harness 官方 Web 端的布局、间距、字体和 `--dsw-*` 设计 token

---

## 1. 目标与范围

本次重构要解决的问题：

1. 旧界面更像“聊天工具 + 侧栏”，与官方 DSH Web 的信息层级差距较大；
2. 会话、主题、模型、工作流、轨迹、审批散落在不同位置，缺少统一入口；
3. 空会话页、设置、命令面板等缺少官方式的视觉与交互；
4. 代码块、工具调用、推理过程等富文本内容的展示不够稳定。

实现目标：

- 用官方设计 token 重建视觉层，而不是手写一套近似色；
- 侧边栏、标题栏、对话流、Composer、右侧/全页面板全部重排；
- 在不改变后端 SSE 契约的前提下，补齐官方式功能：命令面板、设置、主题切换、
  会话搜索/置顶/重命名/导出、Slash 指令、团队/轨迹视图；
- 修复 Markdown 代码卡片渲染时偶发的 DOM 异常。

非目标：

- 不在本次改动中重写 dsh runtime 或 SDK；
- 不引入新的前端状态库（仍用 React 本地状态 + refs）；
- 不改变“会话存在后端内存”的既有架构。

---

## 2. 总体架构

```text
Browser (React / Vite)
   │  REST + SSE
   ▼
FastAPI (agent_platform/web/)
   │  只调用 AgentService
   ▼
AgentService (agent_platform/agent/)
   │  runtime 生命周期 / session / turn / workflow / approval
   ▼
DeepSeekHarness SDK
   │  JSON-RPC over stdio
   ▼
dsh runtime (Node)
   ├── agent loop / tools / session / llm
   ├── assistant-stream-forwarder
   ├── approval-bridge
   └── workflow / subagent / MCP / skills
```

前端数据流：

```text
用户输入
  │
  ▼
Composer.onSubmit(text, teamMode)
  │
  ▼
App.handleSend → api.createChat（必要时）→ App.sendTurn
  │
  ▼
streamTurn() 读取 SSE 帧
  │
  ├─ record(event)          → sessionStorage 轨迹
  ├─ 审批事件               → approvals 状态
  ├─ chat_title             → 会话标题
  └─ reduceTurn(prev, event)→ TurnState（blocks / children / meta）
                                   │
                                   ▼
                            React 重新渲染
```

改造后的前端不直接接触 runtime，也不解析 dsh 原始通知；它只消费
`agent_platform/web/` 暴露的 REST/SSE 契约。

---

## 3. 设计系统与布局

### 3.1 颜色与字体

颜色全部来自 `agent_platform/webui/src/styles/vendor/design-platform.css` 的
`--dsw-alias-*` token，组件内只写语义变量，不写主题相关字面色：

| 用途 | 变量 |
|---|---|
| 页面底色 | `--dsw-alias-bg-base` |
| 浮层/卡片 | `--dsw-alias-bg-layer-1/2/3` |
| 主/次/三级文字 | `--dsw-alias-label-primary/secondary/tertiary` |
| 侧栏底色 | `--dsw-specific-sidebar-fill` |
| 用户气泡 | `--dsw-specific-bubble` |
| 代码块 | `--dsw-alias-markdown-code-block` |
| 品牌色 | `--dsw-alias-brand-primary` / `--dsw-static-deepseek-500` |
| 成功/警告/错误 | `--dsw-alias-state-success-*` / `warn-*` / `error-*` |

字体：

- 正文：`--dsw-font-family`（系统字体栈）
- 品牌/标题：`--dsw-font-family-brand`（Montserrat，随构建打包）
- 代码：`--ds-font-family-code`（SF Mono / JetBrains Mono 等）

### 3.2 关键尺寸

| 元素 | 尺寸 |
|---|---|
| 侧边栏展开 | `280px` |
| 侧边栏收起轨道 | `56px` |
| 主标题栏 | `76px`（空会话态 `52px`） |
| 对话内容列 | 最大 `742px`，两侧各 `24px` padding |
| Composer 卡片 | 最大 `774px` |
| 用户气泡 | 圆角 `20px`，padding `10px 16px`，最大宽度 `82%` |
| Composer 卡片 | 圆角 `28px`，官方同款三层阴影 |
| 代码块 | 圆角 `16px`，正文 `11px/19px` |
| 正文 | `14px/24px` |

### 3.3 布局骨架

```text
.app-shell (flex, 100dvh)
├── Sidebar (280px / 56px)
└── main (flex column)
    ├── MainHeader (title row + tabs)
    ├── mock banner / ApprovalBar
    ├── 内容区
    │   ├── 空会话：Welcome + Composer(hero)
    │   └── 已有内容：Conversation + Composer(dock)
    │   或 TeamView / TrajectoryView
    └── 浮层：Settings / CommandPalette / Confirm / Toast
```

侧边栏在 `≤900px` 时变为固定定位的抽屉，带半透明遮罩；主内容列同步缩小 padding。

---

## 4. 组件树与职责

```text
App.tsx
├── Sidebar.tsx
│   ├── Brand.tsx
│   ├── Menu.tsx
│   └── Icons.tsx
├── MainHeader.tsx
│   └── Menu.tsx
├── Welcome.tsx
├── Conversation.tsx
│   ├── Markdown.tsx → lib/markdown.tsx
│   └── Icons.tsx
├── Composer.tsx
│   ├── Menu.tsx
│   └── Icons.tsx
├── TeamView.tsx
├── TrajectoryView.tsx
├── ApprovalBar.tsx
├── SettingsDialog.tsx
├── CommandPalette.tsx
├── ConfirmDialog.tsx
├── Toast.tsx
└── ErrorBoundary.tsx
```

| 文件 | 职责 |
|---|---|
| `App.tsx` | 会话状态、SSE 生命周期、事件归约、快捷键、持久化、视图切换 |
| `Sidebar.tsx` | 会话搜索/排序/分组/置顶/重命名/删除/导出、折叠轨道 |
| `MainHeader.tsx` | 标题、对话/团队/轨迹 tab、运行状态、停止、更多菜单 |
| `Conversation.tsx` | 历史消息分组、用户气泡、助手摘要、工具卡片、推理、子代理、滚动跟随 |
| `Composer.tsx` | 输入、自动高度、模式切换、Slash 指令、建议、模型信息、发送/停止 |
| `TeamView.tsx` | 工作流角色阶段、时间线、Lead 直接回答 |
| `TrajectoryView.tsx` | Turn/Step/Tool 时间线、筛选、统计 |
| `SettingsDialog.tsx` | 外观、模型、工作区、工作流、关于 |
| `CommandPalette.tsx` | ⌘K 命令搜索与键盘导航 |
| `ApprovalBar.tsx` | 人工审批卡片与允许/拒绝 |
| `ConfirmDialog.tsx` | 删除会话 / 停止全部任务确认 |
| `Toast.tsx` | 顶部轻提示 |
| `Icons.tsx` | 统一的线性 SVG 图标集 |
| `Brand.tsx` | 品牌标记 + AgentBox/HARNESS wordmark |
| `Menu.tsx` | 通用弹出菜单（点击外部/Esc 关闭） |
| `Markdown.tsx` | 统一的 Markdown 渲染入口 |

---

## 5. 应用状态与并发控制

### 5.1 状态分组

`App.tsx` 中的状态大致分为四组：

```text
服务端数据
  config / chats / entries / trajectory

当前 turn
  turn.blocks / turn.children / turn.meta
  running / status / team / elapsed

界面偏好
  themeMode / sidebarCollapsed / pinned / view / feedback
  settingsOpen / paletteOpen / confirm / mobileOpen / notice

会话选择
  activeId / loadingChat / focusSignal
```

`TurnState` 是当前流式 turn 的唯一内存模型：

```ts
interface TurnState {
  blocks: Block[];
  children: ChildGroup[];
  meta: TurnMeta | null;
}
```

`Block` 是判别联合，覆盖：

`user`、`message`、`reasoning`、`tool`、`phase`、`verdict`、`error`、`note`。

### 5.2 refs 的用途

| ref | 作用 |
|---|---|
| `runningRef` | 在异步回调和键盘事件里读取最新运行态，避免闭包过期 |
| `activeRef` | 在 SSE 回调和 `finally` 中判断当前会话 |
| `chatsRef` | 删除会话、导出、发送时读取最新会话列表 |
| `trajectoryRef` | 按 chat 保存轨迹，避免频繁读写 sessionStorage |
| `configRef` | SSE 回调中读取最新 workflow agents |
| `didInitRef` | 防止 React StrictMode 下初始化请求重复 |
| `toastTimerRef` | 清理上一条 Toast 的定时器 |

### 5.3 初始化

```text
App mount
  → api.config() + api.chats()
  → 读 localStorage 的 agentbox-last-chat
  → 命中则 selectChat(id)，否则 selectChat(chats[0])
  → 都没有则进入空会话页
```

初始化失败会显示全屏错误页，带“重试”按钮；不是简单的红条。

### 5.4 会话切换与并发

- 同一会话正在运行 turn 时，`selectChat` 会拒绝切换到其他会话，并给出 Toast；
- 仍允许点击当前会话，仅切回“对话”tab；
- `sendTurn` 开始前会占用 `runningRef`，结束后统一在 `finally` 释放；
- 新建会话、发送首条消息、删除会话、停止全部都通过 ref/状态双重判断。

### 5.5 持久化

| 存储 | key | 内容 |
|---|---|---|
| localStorage | `agentbox-theme` | `system` / `light` / `dark` |
| localStorage | `agentbox-sidebar-collapsed` | `1` / `0` |
| localStorage | `agentbox-pinned` | 置顶会话 id 数组 |
| localStorage | `agentbox-last-chat` | 上次打开的会话 id |
| sessionStorage | `agentbox-trajectory:<chatId>` | 当前会话轨迹事件（上限 500 条） |

主题、置顶、上次会话、侧栏折叠是纯前端偏好，不会写回后端；换浏览器不同步。

---

## 6. SSE 事件与 `reduceTurn`

### 6.1 SSE 消费

`src/api.ts` 中的 `streamTurn`：

1. 根据 `team` 选择 `POST /api/chats/{id}/messages` 或 `/team`；
2. 用 `ReadableStream` 逐块读取；
3. 以 `\n\n` 切帧，取 `data: ` 行并 `JSON.parse`；
4. 每收到一个 `assistant_delta` 后 `await 8ms`，让浏览器有机会绘制增量文本，
   而不是一次性把整段文字画出来；
5. 非 2xx 响应转成 `ApiError`，由上层提示。

### 6.2 事件到 Block 的映射

| SSE 事件 | 归约结果 |
|---|---|
| `user_echo` | `user` block |
| `turn_start` / `step_start` | 更新状态栏、`meta.startedAt` |
| `tool_call` | `tool` block（子代理走 `children`） |
| `tool_result` | 按 `callId` 回填 result；找不到则补一个工具块 |
| `assistant_stream_start` | 插入空的 `message` block（带 `streamId`） |
| `assistant_delta` | 追加到对应 `streamId` 的 message |
| `assistant_stream_end` | 删除空占位，保留最终 message |
| `message` | 更新/创建 message；`reasoning` 字段写入 reasoning block |
| `reasoning` | 合并到最后一个 reasoning block，或新建 |
| `phase` | `phase` block + 更新团队阶段 |
| `verdict` | `verdict` block + 更新审查时间线 |
| `agent_spawn` / `agent_done` | 新建/收尾子代理卡片 |
| `error` | `error` block + `meta.failed = true` |
| `end` | `meta.endedAt` / `finishReason`，补最终回复或停止提示 |
| `usage` | 写入 `meta.usage` |
| `approval_request` / `approval_resolved` | 不进入对话流，由 `App` 单独处理 |

### 6.3 一次 turn 的生命周期

```text
sendTurn(chatId, text, team)
  │
  ├─ running = true
  ├─ turn = { blocks: [], children: [], meta: { startedAt } }
  ├─ 团队模式则初始化 team = { stages: {}, timeline: [] }
  │
  ├─ streamTurn(..., apply)
  │    ├─ record(event) → 轨迹
  │    └─ reduceTurn(...) → setTurn
  │
  └─ finally
       ├─ running = false
       ├─ 刷新 chats
       ├─ 刷新 chat detail → entries
       ├─ 重置 turn
       └─ 清理该会话审批
```

失败路径：

- `error` 事件会把错误写进 `meta.failed`，并渲染 `error-card`；
- 若流在异常中断，`finally` 刷新详情时如果后端没有留下 system 提示，
  前端会补一条本地 `⚠️ ...` system entry；
- 停止全部任务时，后端会写入“⏹️ 已停止全部任务”的 system 记录，
  前端在 `end` 事件里也会补一个 `note` block。

### 6.4 计时与 usage

- `meta.startedAt` 在 `turn_start` / 发送时设置；
- `meta.endedAt` 在 `end` 或 `error` 时设置；
- `running` 期间每秒更新 `now`，用于标题栏和 turn 摘要的耗时；
- `usage` 事件写入 `meta.usage`，在消息底部的操作栏显示总 token 和缓存命中率。

### 6.5 `latestAnswer`

团队视图需要一个“本轮输出”文本，即使没有进入 coder/reviewer 阶段：

```ts
const messageBlock = [...turn.blocks].reverse().find(
  (block): block is Extract<Block, { kind: "message" }> =>
    block.kind === "message" && Boolean(block.text),
);
const latestAnswer =
  messageBlock?.text ||
  [...entries].reverse().find((entry) => entry.role === "assistant")?.text ||
  "";
```

这样当 review 工作流把问题路由为普通问答时，团队页会显示
“本轮由 Lead 直接回答”，而不是 0/2 的空白阶段卡片。

---

## 7. Markdown 与代码块

### 7.1 渲染管线

`src/lib/markdown.tsx`：

```text
marked (GFM)
  → highlight.js (common 语言集)
  → DOMPurify.sanitize
  → decorate()：包代码卡片、加复制/换行按钮、外链 target
  → dangerouslySetInnerHTML
```

安全约束：

- 所有 HTML 先经过 DOMPurify；
- 只在 sanitize 之后注入按钮 DOM；
- 外链在 decorate 阶段补 `target="_blank"` / `rel="noreferrer noopener"`；
- 代码高亮失败时降级为转义后的纯文本。

### 7.2 代码卡片结构

```text
.code-card
├── .code-card-head
│   ├── .code-lang
│   └── .code-actions
│       ├── [data-wrap] 自动换行
│       └── [data-copy] 复制代码
└── <pre><code class="hljs language-*">…</code></pre>
```

复制/换行由 `Conversation` 容器上的事件委托处理，不绑定内联脚本。

### 7.3 修复 `replaceChild` 偶发异常

错误现象：

```text
Failed to execute 'replaceChild' on 'Node':
The new child element contains the parent.
```

以及修复过程中暴露的第二形态：

```text
Failed to execute 'replaceChild' on 'Node':
The node to be replaced is not a child of this node.
```

根因：`decorate()` 需要把 `<pre>` 包进 `.code-card`，但原来的顺序是：

```ts
card.append(head, pre);          // pre 已被移入 card
pre.parentElement?.replaceChild(card, pre);
```

`pre.parentElement` 已经变成 `card`，用 `card` 替换 `pre` 等于“用祖先替换自己的子节点”；
如果改成先缓存 parent，`pre` 又已被移走，不再是 parent 的子节点，于是出现第二种错误。

最终实现：

```ts
const parent = pre.parentElement;
if (!parent) return;
const nextSibling = pre.nextSibling;

card.append(head, pre);              // 先把 pre 移进卡片
parent.insertBefore(card, nextSibling); // 再把卡片插回原位置
```

关键点：

- 在移动 `pre` 之前记录它的 `nextSibling`；
- 用 `insertBefore` 而不是 `replaceChild`，保持代码块在文档中的原始位置；
- 该问题只在出现代码块时触发，所以表现为“有时候”报错。

---

## 8. 侧边栏功能

### 8.1 结构

```text
Sidebar
├── 品牌行（点击折叠态 logo 可展开）
├── 新会话按钮
├── 团队工作流 / 运行轨迹 / 命令面板
├── 工作区标题 + 搜索/排序/新建
├── 工作区行 + 会话列表
│   ├── 已置顶
│   ├── 今天 / 昨天 / 最近 7 天 / 更早
│   ├── 展开其余 N 个会话
│   └── 会话右键/更多菜单
└── 底部：审批提示、连接状态、更多/主题/设置
```

### 8.2 会话操作

- 搜索：按标题过滤，显示“搜索结果”分组；
- 排序：最新优先 / 最早优先；
- 分组：按创建时间分组，默认最多显示 6 条，超出折叠；
- 置顶：`localStorage` 保存，置顶分组优先；
- 重命名：行内 input，Enter 提交、Esc 取消、失焦提交；
- 删除：二次确认后调用 `DELETE /api/chats/{id}`；
- 导出：生成 Markdown 文件下载；
- 右键菜单：重命名 / 置顶 / 导出 / 删除。

### 8.3 重命名 API

后端新增 `PATCH /api/chats/{chat_id}`：

```python
class ChatTitleIn(BaseModel):
    title: str

@router.patch("/api/chats/{chat_id}")
def api_rename_chat(chat_id, body, service):
    return service.rename_chat(chat_id, body.title)
```

`AgentService.rename_chat` 会 trim 标题、限制 120 字符，空标题抛 `ValueError`（HTTP 400）。

### 8.4 快捷键

| 快捷键 | 行为 |
|---|---|
| `⌘/Ctrl + K` | 打开/关闭命令面板 |
| `⌘/Ctrl + N` | 新建会话 |
| `⌘/Ctrl + B` | 收起/展开侧边栏 |
| `⌘/Ctrl + ,` | 打开设置 |
| `Enter` | 发送 |
| `Shift + Enter` | 换行 |
| `Esc` | 关闭弹层/移动端侧栏 |

---

## 9. Composer

### 9.1 结构

```text
.composer-card（774px，圆角 28）
├── textarea（自动高度，max 240px）
├── toolbar
│   ├── + 更多操作
│   ├── 标准模式 / 团队工作流菜单
│   ├── spacer
│   ├── 模型 chip（model + High）
│   └── 圆形发送/停止按钮
└── 底部提示（Enter / Shift+Enter / ⌘K）
```

空会话时 Composer 使用 `hero` 变体：上方显示工作区、模式和角色数，
下方显示 3 个建议 chip；已有对话时使用 `dock` 变体固定在底部。

### 9.2 Slash 指令

输入以 `/` 开头时弹出指令面板，支持键盘上下选择和 Enter 执行：

| 指令 | 行为 |
|---|---|
| `/team` | 切换团队工作流模式 |
| `/review` | 插入代码审查模板 |
| `/test` | 插入测试用例模板 |
| `/explain` | 插入代码解释模板 |
| `/clear` | 清空输入 |

这些是前端提示模板，不是后端命令；真正的命令面板是 `⌘K`。

### 9.3 输入细节

- 中文输入法组合输入期间不发送（`compositionstart/end` + `isComposing`）；
- 回车发送、Shift+Enter 换行、Esc 关闭 Slash 菜单；
- 发送后清空并重置 textarea 高度；
- 运行中发送按钮变为停止按钮，点击触发“停止全部任务”确认；
- 模型/provider 来自后端配置，仅展示，不提供切换。

---

## 10. 三个主视图

### 10.1 对话

- 历史 `entries` 按 user/assistant/system 分组；
- 用户消息右对齐、浅蓝气泡、时间戳 + 复制；
- 助手消息前有“已完成”摘要行，可折叠；
- 助手内容使用 Markdown；
- 工具调用以紧凑卡片展示，参数/输出可展开；
- 推理过程折叠；
- 团队角色的消息带 Agent chip；
- 子代理事件放进子代理卡片；
- 底部操作栏：复制、赞/踩、导出、usage、时间；
- 滚动跟随：用户上滑后停止自动跟随，右下角出现“回到最新”。

### 10.2 团队

- 工作流名称、描述、角色数、类型、最大轮次；
- 每个角色一张阶段卡片：头像、名称、角色说明、状态、输出；
- review 工作流额外显示审查时间线；
- 没有阶段数据但存在回答时，显示“本轮由 Lead 直接回答”；
- 没有数据时显示角色顺序和“用团队模式开始”按钮。

团队状态由 `reduceTurn` 的 `message` / `phase` / `verdict` 驱动：

- `phase` → 角色阶段和轮次；
- `message`（带 `agent`）→ 角色输出文本；
- `verdict` → reviewer 结论和 timeline；
- `end` → 所有阶段标记为 done。

### 10.3 轨迹

- 读取 `sessionStorage` 中当前 chat 的事件账本；
- 按 turn / step / tool / assistant / approval / usage / end 构建行；
- 顶部统计 turns / steps / tools / tokens / 总时长；
- 支持筛选：全部 / 消息 / 工具 / 审批；
- 轨迹筛选和行渲染与后端 SSE 事件词汇表保持同构。

轨迹只存在当前浏览器会话中；换浏览器或清 sessionStorage 后不可恢复。
对话正文里的工具卡片只在当前流式 turn 内展示，完成后重载正文来自后端 transcript，
后端 transcript 目前只保存 user/assistant/system 文本，不保存 tool/reasoning 富内容。

---

## 11. 人工审批

两条路径同时存在：

1. SSE 实时事件：`approval_request` / `approval_resolved`；
2. 轮询兜底：`GET /api/approvals` 每 3 秒同步一次。

这样刷新页面或 SSE 丢帧后，审批条仍能恢复。

```text
AgentService 审批注册表
  → SSE approval_request（带 approvalId/toolName/reason/timeoutSeconds）
  → App approvals 状态
  → ApprovalBar
  → POST /api/approvals/{id} {decision: approve|reject}
  → AgentService 唤醒等待中的工具调用
```

前端行为：

- 审批条显示工具名、原因、超时时间；
- “允许一次”只对当前调用生效；
- 拒绝/超时都按拒绝处理；
- 侧边栏和标题栏显示待审批数量；
- 如果审批属于另一个会话，点击提示会尝试切换过去（运行中则只提示）。

---

## 12. 主题、无障碍与响应式

### 12.1 主题

支持 `system` / `light` / `dark` 三种模式：

- `useTheme` 读取 `localStorage["agentbox-theme"]`；
- `system` 模式监听 `prefers-color-scheme` 变化；
- 通过 `body[data-ds-dark-theme]` 切换官方 token；
- `webui/index.html` 在首屏前执行内联脚本，避免暗色用户白闪。

### 12.2 无障碍

- 图标按钮基本都有 `aria-label` / `title`；
- tab 使用 `role="tablist"` / `role="tab"` / `aria-selected`；
- 弹层使用 `role="dialog"` / `aria-modal`，确认框使用 `role="alertdialog"`；
- Toast 使用 `role="status"` / `aria-live`；
- `:focus-visible` 统一 outline；
- 支持 `prefers-reduced-motion`，关闭动画和过渡。

### 12.3 响应式

| 断点 | 行为 |
|---|---|
| `≤1100px` | 侧边栏收窄到 260px |
| `≤900px` | 侧边栏变抽屉，显示遮罩 + 顶部菜单按钮；标题栏 padding 缩小 |
| `≤640px` | 用户气泡放宽到 92%；模型名和模式文本截断；设置导航横向滚动 |

桌面端仍是主场景；移动端只保证可用，不追求与官方移动端完全一致。

---

## 13. 构建与验证

### 13.1 命令

```bash
# 类型检查 + 构建产物到 agent_platform/static/
cd agent_platform/webui
CI=true pnpm build

# 无浏览器启动探针（jsdom 加载构建产物）
node scripts/boot-check.mjs

# 后端测试
.venv/bin/python -m unittest discover -s tests -v
```

Vite 构建配置保持：

- `base: "/static/"`
- `outDir: "../static"`
- `emptyOutDir: false`（保留旧 hash 资源，避免旧 index 引用导致白屏）
- `manualChunks`：react / markdown 分离

FastAPI 对 `index.html` 返回 `Cache-Control: no-store`，带 hash 的资源可长缓存；
`web/static.py` 对缺失的旧 hash JS 返回自动刷新脚本，避免白屏。

### 13.2 已验证场景

- 后端测试：50 个测试全部通过（含新增的 `rename_chat` 测试）；
- `pnpm build`：TypeScript 无错误，Vite 构建成功；
- `boot-check.mjs`：无运行时异常，`#root` 正常渲染；
- 桌面 1440×900：浅色、深色、空会话、设置、命令面板、团队、轨迹截图；
- 移动 390×844：抽屉侧栏与主界面截图；
- 真实对话：普通问答、team review 直答、bash 工具调用、代码块渲染；
- 代码块修复后：无 `replaceChild` 异常，`code-card` 正常生成。

---

## 14. 已知限制与后续改进

| 限制 | 说明 | 建议 |
|---|---|---|
| 会话只在后端内存 | 服务重启后会话列表清空 | 后续可接 `Chat` 持久化存储 |
| 工具/推理不持久 | 对话正文完成后重载只保留文本，工具卡片/推理只在流式 turn 内 | 扩展 transcript 事件模型或前端 rich history |
| 团队面板不持久 | `team` 是当前 App 内存态，刷新后为空 | 按 chat 缓存 turn 级 team 快照 |
| 模型只读 | model/provider 来自 `.env` | 增加设置写回或 per-session 模型覆盖 |
| 无附件/文件引用 | 输入框没有真实上传和 `@` 文件选择 | 接 `attachment` / `file-reference` API |
| Slash 指令是模板 | 不是后端命令 | 后续可映射到 commands registry |
| 审批轮询 | 3 秒一次，非多端实时推送 | 可改为 WebSocket 或复用 SSE 通道 |
| 轨迹存 sessionStorage | 换浏览器丢失 | 可保存到后端会话存储 |
| 移动端仅可用 | 不是官方移动端交互 | 后续单独设计移动端手势和导航 |

---

## 15. 文件索引

```text
agent_platform/webui/src/
├── App.tsx                     # 应用状态 / SSE / 归约 / 快捷键 / 持久化
├── api.ts                      # REST + SSE 客户端（含 PATCH rename）
├── types.ts                    # API / SSE / ViewTab / Block / TurnMeta 类型
├── main.tsx                    # 入口、样式加载、ErrorBoundary
├── components/
│   ├── ApprovalBar.tsx
│   ├── Brand.tsx
│   ├── CommandPalette.tsx
│   ├── Composer.tsx
│   ├── ConfirmDialog.tsx
│   ├── Conversation.tsx
│   ├── ErrorBoundary.tsx
│   ├── Icons.tsx
│   ├── MainHeader.tsx
│   ├── Markdown.tsx
│   ├── Menu.tsx
│   ├── SettingsDialog.tsx
│   ├── Sidebar.tsx
│   ├── TeamView.tsx
│   ├── Toast.tsx
│   ├── TrajectoryView.tsx
│   └── Welcome.tsx
├── lib/
│   ├── markdown.tsx            # marked + hljs + DOMPurify + 代码卡片
│   ├── theme.ts                # system/light/dark
│   └── ui.ts                   # 时间/token/复制/下载/安全文件名
└── styles/
    ├── app.css                 # 全部布局与组件样式
    └── vendor/                 # 官方设计 token、字体、滚动条、焦点样式

agent_platform/web/app.py       # PATCH /api/chats/{id}
agent_platform/agent/service.py # AgentService.rename_chat
tests/test_service.py           # rename 测试
docs/frontend-implementation.md # 本文
```

---

## 16. 设计取舍小结

1. **复用官方 token，而不是复制官方 CSS**：`design-platform.css` 已包含亮暗两套
   语义变量，组件只消费 token，后续跟随官方升级成本低。
2. **不引入状态库**：平台规模有限，`App` 本地状态 + refs 足够；SSE 回调和键盘
   事件通过 refs 读取最新值，避免闭包过期。
3. **视图用 tab 而不是右侧 dock**：官方 Web 的主信息结构是“对话 / 轨迹”页签，
   团队视图作为第三个 tab 更符合信息层级；右侧 dock 在窄屏下也会挤压内容。
4. **前端不伪造功能**：模型选择、附件、后端命令等能力未实现时只展示状态或模板，
   不制造“看起来能点但无效”的入口。
5. **错误必须可见且可恢复**：初始化失败有全屏重试，渲染失败有 ErrorBoundary，
   SSE 失败补 system 记录，代码卡片异常修复后保留原始代码块位置。
