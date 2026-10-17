# Agent 平台配置与原理

本文说明这个平台里 **skill、MCP、流式输出、workflow、停止和轨迹** 分别配置在哪里、运行时如何工作，以及 Python SDK 路线的边界。

---

## 1. 整体架构

```text
Browser (React)
   │  HTTP + SSE
   ▼
FastAPI (agent_platform/main.py)
   │  Python SDK: session/prompt, notifications
   ▼
DeepSeekHarness (deepseek_harness)
   │  JSON-RPC over stdio
   ▼
dsh runtime (Node, --profile sdk)
   ├── dsh-agent-loop / tools / session / llm
   ├── dsh-skill + dsh-skill-filesystem + dsh-tool-skill
   ├── dsh-mcp-client (可选,通过 patch 挂载)
   ├── dsh-workflow + dsh-tool-workflow
   └── 自定义插件: assistant-stream-forwarder
```

关键点：

- FastAPI **不直接调用模型**，只负责会话、SSE、任务编排和事件翻译。
- 真正的 agent loop、工具执行、上下文和持久化都在 dsh runtime 里。
- dsh 的插件树通过 **profile bundle + patch** 组合；平台自己的定制都尽量放在 patch/plugin 层，不 fork 上游。
- 同一个 runtime 被所有平台 chat 共享；runtime 退出时，下一条消息会自动重启（见第 8 节）。

---

## 2. 配置入口一览

| 配置 | 位置 | 作用 |
|---|---|---|
| 模型 / API key | `.env` | provider、model、DeepSeek key/base URL |
| 团队工作流 | `workflows.json` | coder/reviewer 的名称、描述、最大修复轮数 |
| Skill | `agent_platform/skills/` | 自定义 `SKILL.md` |
| Skill 根目录 patch | `agent_platform/dsh-patches/skills.yml` | 把 `customSkillDirs` 指向仓库内 skills |
| MCP | `agent_platform/dsh-patches/mcp.yml` | 每个 MCP server 一条配置 |
| MCP 示例 | `agent_platform/dsh-patches/mcp.example.yml` | 复制为 `mcp.yml` 后启用 |
| 流式插件 | `agent_platform/dsh-plugins/assistant-stream-forwarder/` | 转发 `agent/assistant-stream` |
| 流式 patch | 运行时生成到 `$DSH_HOME/patches/streaming.yml` | 让 runtime 加载流式插件 |
| 轨迹 | 浏览器 `sessionStorage` | 当前浏览器的 per-chat 事件账本 |
| runtime 状态 | `.dsh-home/` | profile、session、凭据、日志 |

`agent_platform/main.py` 在启动时决定要加载哪些 patch：

```python
runtime_patches = []
if SKILLS_PATCH.is_file():
    runtime_patches.append(str(SKILLS_PATCH))
if MCP_PATCH.is_file():
    runtime_patches.append(str(MCP_PATCH))
# streaming patch 是动态生成的,因为 name 字段不能使用 !!js
```

这些 patch 最终变成 dsh 的 `--patch` 参数。

---

## 3. Skill

### 3.1 dsh 的 skill 分层

dsh 把 skill 拆成三个角色：

| 角色 | 包 | 职责 |
|---|---|---|
| Registry | `@deepseek-ai/dsh-skill` | 注册/合并不同 provider 的 skill |
| Provider | `@deepseek-ai/dsh-skill-filesystem` | 从磁盘发现 `SKILL.md`，监听变更 |
| Consumer | `@deepseek-ai/dsh-tool-skill` | 给模型注入 catalog，注册 `skill` 加载工具 |

SDK profile 默认已经启用这三行，所以平台不需要自己实现 skill 机制。

### 3.2 扫描根目录

`dsh-skill-filesystem` 默认按优先级扫描：

| 优先级 | 来源 | 路径 |
|---|---|---|
| 100 | project-dsh | `<projectRoot>/.dsh/skills` |
| 200 | project-agents | `<projectRoot>/.agents/skills` |
| 300 | custom | `Config.customSkillDirs` |
| 400 | user-dsh | `<DSH_HOME>/skills` |
| 500 | user-agents | `~/.agents/skills` |
| 600 | bundled | `Config.bundledSkillDir` |

本平台把 `customSkillDirs` 指向：

```text
agent_platform/skills/
```

patch 内容：

```yaml
# agent_platform/dsh-patches/skills.yml
- id: skill-filesystem
  config:
    customSkillDirs:
      - !!js process.env.DSH_SKILLS_DIR
```

`main.py` 在启动 runtime 时注入：

```python
runtime_env["DSH_SKILLS_DIR"] = str(SKILLS_DIR)
```

### 3.3 SKILL.md 格式

目录式：

```text
agent_platform/skills/code-review/SKILL.md
```

或扁平式：

```text
agent_platform/skills/code-review.md
```

内容：

```markdown
---
name: code-review
description: 对工作区改动做结构化代码审查。
whenToUse: 用户要求 review、检查实现或找 bug 时。
---

# Code Review

1. 先读改动文件和测试。
2. 按正确性、边界条件、错误处理、可读性列出问题。
3. 最后输出「结论:APPROVE」或「结论:NEEDS_CHANGES」。
```

要求：

- `name` 必须是 kebab-case。
- `description` 必填。
- 可选 `whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable`。
- 目录式只识别 `<root>/<name>/SKILL.md`；嵌套的 `**/SKILL.md` 不会发现。
- frontmatter 非法时整个 skill 被跳过，并在 runtime 日志里告警。

### 3.4 模型如何看到 skill

`dsh-tool-skill` 在会话开始前注入一个 catalog：

```text
<available_skills>
- `code-review`: 对工作区改动做结构化代码审查。
</available_skills>
```

模型需要时调用：

```text
skill(name="code-review")
```

返回完整正文。用户也可以在消息里输入 `/code-review`，直接注入同一份 `<skill_content>`。

### 3.5 热更新

`dsh-skill-filesystem` 监听 skill 根目录：

- 新增/删除/重命名 skill；
- 修改 frontmatter；
- 修改 `SKILL.md` 正文。

下一次 step 会看到新的 catalog/正文，不需要重启 runtime。

注意：

- 只有 frontmatter 变化才会改变 catalog digest；只改正文不会重新发布 catalog，但下一次 `skill` 调用会读到新正文。
- 当前平台所有 agent 共享同一个 skill 根，所以 coder/reviewer/lead 都能看到所有 skill。没有 per-agent 硬隔离。

### 3.6 加一个 skill 的最短路径

```bash
mkdir -p agent_platform/skills/my-skill
cat > agent_platform/skills/my-skill/SKILL.md <<'EOF'
---
name: my-skill
description: 一句话说明这个 skill 做什么。
---

这里写模型加载后要遵循的完整指令。
EOF
```

不需要改 `main.py`，也不需要重启 runtime。

---

## 4. MCP

### 4.1 MCP 在 dsh 里是什么

`@deepseek-ai/dsh-mcp-client` 把外部 MCP server 的工具桥接成 dsh 原生工具。

模型看到的工具名：

```text
mcp__<serverName>__<rawToolName>
```

例如：

```text
mcp__github__create_issue
mcp__memory__create_entities
```

默认 **不启用任何 MCP server**。SDK profile 也没有挂载 `dsh-mcp-client` 行，所以需要平台加一个 patch。

### 4.2 配置字段

| 字段 | 说明 |
|---|---|
| `serverName` | 命名空间，`[A-Za-z0-9_-]{1,32}`，同一 scope 内唯一 |
| `transport` | `stdio` 或 `streamable-http` |
| `command` / `args` / `env` / `cwd` | stdio 模式 |
| `url` / `headers` | streamable HTTP 模式 |
| `toolCallTimeoutMs` | 单次 `tools/call` 超时，默认 60s |
| `failOnStartupError` | 初始连接/同步失败时是否让插件加载失败，默认 `false` |
| `reconnect.enabled` | 断线自动重连，默认 `true` |
| `reconnect.initialDelayMs` | 首次重连延迟，默认 500ms，指数退避 |
| `reconnect.maxDelayMs` | 退避上限，默认 30s |
| `reconnect.maxAttempts` | 连续失败上限，默认 10 次 |

### 4.3 stdio 示例

`agent_platform/dsh-patches/mcp.yml`：

```yaml
- insert:
    - id: mcp-memory
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: memory
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-memory']
        failOnStartupError: false
```

需要 GitHub：

```yaml
- insert:
    - id: mcp-github
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: github
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-github']
        env:
          GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN
```

### 4.4 Streamable HTTP 示例

```yaml
- insert:
    - id: mcp-web
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: web
        transport: streamable-http
        url: http://127.0.0.1:3000/mcp
        headers:
          Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
```

### 4.5 平台如何加载 MCP patch

`main.py` 里：

```python
MCP_PATCH = Path(__file__).resolve().parent / "dsh-patches" / "mcp.yml"

if MCP_PATCH.is_file():
    runtime_patches.append(str(MCP_PATCH))
```

所以最短启用步骤：

```bash
cp agent_platform/dsh-patches/mcp.example.yml agent_platform/dsh-patches/mcp.yml
# 编辑 mcp.yml,取消注释需要的 server
# 重启 uvicorn
```

### 4.6 环境变量

MCP stdio 子进程会继承 runtime 的环境，但 dsh 会先做一次 scrub：

- 删除名字匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的环境变量；
- 删除所有 `DSH_*`；
- 再把配置里的 `env` 合并进去。

所以 MCP 凭据应该：

```bash
export GITHUB_TOKEN=...
.venv/bin/uvicorn agent_platform.main:app --host 127.0.0.1 --port 8765
```

不要在 patch 里硬编码 token。`.env` 里的其他变量不会自动进入 runtime；需要 MCP 凭据时用 shell export，或者 source `.env` 后再启动。

### 4.7 启动、重连和边界

- 初始连接失败时，默认 harness 仍然启动，只是没有该 server 的工具；设置 `failOnStartupError: true` 会让启动失败。
- server 断线后自动重连；重连期间旧工具仍然列出，但调用会失败。
- 连续失败达到 `maxAttempts` 后工具被移除，直到重启或重新加载配置。
- MCP 只桥接 **tools**；resources 和 prompts 不支持。
- 工具定义会进入每次模型请求，server 越多、schema 越大，token 成本越高。
- 同一 scope 内 `serverName` 重复会导致后加载的条目失败。

---

## 5. 流式输出

### 5.1 两层流式

平台有两层不同的“流式”：

| 层 | 内容 | 是否逐 token |
|---|---|---|
| 事件级 SSE | turn/step、tool/call、tool/result、完整 message | 否 |
| token 级文本 | `agent/assistant-stream` 的 `text-delta` | 是 |

### 5.2 为什么 Python SDK 默认做不到 token 流式

dsh runtime 内部有 `agent/assistant-stream` 事件：

```text
start  →  chunk(text-delta / reasoning-delta / tool-call-delta)  →  end
```

但 `dsh-sdk-jsonrpc-server` 只把以下内容转发给 Python 客户端：

```text
session.event
session.status
subagent.*
```

它不转发 `agent/assistant-stream`。所以默认情况下，Python SDK 只能在完整 `assistant/message` 提交后拿到整段文本。

### 5.3 平台的自定义转发插件

`agent_platform/dsh-plugins/assistant-stream-forwarder/index.js`：

```js
export const name = 'assistant-stream-forwarder'

export function apply(ctx) {
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const sessionId = agent?.session?.id
    if (!sessionId || !frame) return
    try {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'agent/assistant-stream',
          params: { sessionId, frame },
        }) + '\n',
      )
    } catch {
      // client may have closed
    }
  })
}
```

为什么这样可以：

- dsh 的 stdout 本来就是 newline-delimited JSON-RPC；
- Python SDK 的 reader 会把任何带 `method` 的帧当作 notification；
- `HarnessClient.subscribe_session_notifications()` 的 predicate 会按 payload 里的 `sessionId` 匹配当前 session tree；
- 于是 `Session.run` 的 `on_notification` 就能收到这些自定义 notification。

### 5.4 事件翻译

FastAPI 在 `translate_notification` 里把 frame 翻译成：

```text
assistant_stream_start
assistant_delta
assistant_stream_end
usage
```

前端 reducer：

- `assistant_stream_start` 创建一个带 `streamId` 的 message block；
- `assistant_delta` 往同一个 block 追加 text；
- 最终 `assistant/message` 用完整文本校正；
- `usage` 进入轨迹面板；
- `assistant_stream_end` 清理没有文本的空 block。

`agent_platform/webui/src/api.ts` 在每个 delta 后 `await setTimeout(8ms)`，避免 React 18 把同一个网络 chunk 里的很多 delta 批量成一次渲染。

### 5.5 流式覆盖范围

| 场景 | token 级 |
|---|---|
| 普通对话 | 是 |
| 团队 coder / reviewer | 是，带 agent 标签 |
| 只读 investigator | 是 |
| 团队直答 | 是（lead 先路由，再跑一轮自然语言回答） |
| lead 路由调用本身 | 否（内部 JSON，不展示） |
| subagent 文本 | 否（仍按完整 message） |
| reasoning | 否（按完整 message 展示） |
| skill 加载结果 | 否（工具结果，完成时整段返回） |

### 5.6 插件如何加载

`main.py` 在启动时生成：

```text
$DSH_HOME/patches/streaming.yml
```

内容类似：

```yaml
- insert:
    - id: assistant-stream-forwarder
      name: "file:///.../agent_platform/dsh-plugins/assistant-stream-forwarder/index.js"
```

`name` 字段不支持 `!!js`，所以不能用环境变量拼 URL，必须在启动时生成绝对 `file://` URL。

加载成功后 `/api/config` 返回：

```json
{ "streaming": true }
```

如果插件缺失或加载失败，前端自动退回“完整消息一次性出现”。

---

## 6. Workflow

这里有三个不同层次，容易混：

### 6.1 平台团队工作流（当前默认）

`workflows.json` 定义的是 **平台侧角色名册**，不是 dsh 的 workflow 引擎。

```json
{
  "id": "coder-reviewer",
  "name": "Coder + Reviewer",
  "description": "平台编排:coder 实现,reviewer 审查。",
  "maxRounds": 1,
  "agents": [
    { "id": "coder", "name": "Coder", "emoji": "👨‍💻", "role": "...", "writes": true },
    { "id": "reviewer", "name": "Reviewer", "emoji": "🔍", "role": "...", "writes": false }
  ]
}
```

`agent_platform/workflows.py` 把它加载成 `WorkflowSpec`，并注入每个角色的 prompt：

```text
[平台团队上下文]
当前工作流: coder-reviewer
团队名册: 2 个模型 agent + 1 个平台编排器
...
list_agents 只列你派生的 continuable 子代理,不列平台角色。
```

### 6.2 Lead 路由

团队模式不是“所有输入都写代码”。`_run_team_turn` 先跑一个内部 lead：

```text
用户请求
  ├─ answer  → 直接回答（再跑一轮自然语言回答以流式）
  ├─ inspect → 只读 investigator,不跑 reviewer
  └─ coding  → coder → reviewer →(可选)coder 修复
```

lead 输出严格 JSON：

```json
{"route":"answer|inspect|coding","plan":"...","answer":"..."}
```

路由失败会回退旧的 coder/reviewer 流程。

### 6.3 原生 dsh workflow 工具

SDK profile 默认已经启用：

```text
@deepseek-ai/dsh-workflow
@deepseek-ai/dsh-workflow-worker-thread
@deepseek-ai/dsh-tool-workflow
```

模型可以调用 `workflow` 工具，写一段 JavaScript 编排脚本：

```js
const reviews = await parallel([
  () => agent('Review src/a.ts for correctness'),
  () => agent('Review src/b.ts for correctness'),
])
return { reviewed: reviews.length }
```

脚本可用钩子：

| 钩子 | 作用 |
|---|---|
| `agent(prompt, opts)` | 启动一个子 agent，返回最终文本或结构化值 |
| `parallel([...])` | 并行执行多个异步任务 |
| `pipeline(...)` | 串行/流水线组合 |
| `phase(name)` | 给观察者标注阶段 |
| `log(message)` | 记录进度 |

工具参数：

```json
{
  "meta": { "name": "...", "description": "...", "whenToUse": "...", "phases": [] },
  "script": "JavaScript body, ends with return <json>",
  "args": { "optional": "object" }
}
```

行为：

- 父 turn **阻塞等待**整个 workflow 结束；
- 子 agent 的中间消息不会回到父对话；
- 成功返回 `{ runId, agentsStarted, result }`；
- 取消/异常返回错误，不返回部分成功；
- 没有 journal/resume，进程重启不能继续；
- 没有保存的 workflow 定义，脚本由模型每次生成。

### 6.4 三种编排方式对比

| 方式 | 谁决定流程 | 适合 |
|---|---|---|
| 平台团队工作流 | 平台代码 + lead 路由 | 稳定的 coder/reviewer 质量门禁 |
| 原生 `subagent` | 模型 | 一两个独立委派 |
| 原生 `workflow` | 模型写 JS | 大量并行子任务、审计、迁移、多角度调研 |

### 6.5 自定义子 agent / 主从关系

如果你希望主 agent 自己决定把任务交给 `researcher`、`coder`、`reviewer`,而不是平台写死 coder→reviewer,可以给每个角色挂一个**命名 subagent 工具**。

最小配置见 `agent_platform/dsh-patches/agents.example.yml`:

```yaml
- insert:
    - id: tool-subagent-researcher
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: researcher
        backgroundMode: continuable
        maxDepth: 1
        persona: |
          你是团队的 researcher,只读调查员...
    - id: tool-subagent-coder
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: coder
        backgroundMode: continuable
        maxDepth: 1
        persona: |
          你是团队的 coder,实现工程师...
    - id: tool-subagent-reviewer
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: reviewer
        backgroundMode: continuable
        maxDepth: 1
        persona: |
          你是团队的 reviewer...
```

启用:

```bash
cp agent_platform/dsh-patches/agents.example.yml agent_platform/dsh-patches/agents.yml
# 编辑 persona / maxDepth / 可选 toolFilter
# 重启 uvicorn
```

`main.py` 会自动把 `agents.yml` 加进 runtime patch:

```python
if SUBAGENTS_PATCH.is_file():
    runtime_patches.append(str(SUBAGENTS_PATCH))
```

#### 关键字段

| 字段 | 作用 |
|---|---|
| `provider` | 子 agent 后端,本平台用 `spawn` |
| `toolName` | 模型看到的工具名,例如 `researcher` |
| `backgroundMode` | `continuable`:后台持久子 agent,可用 `send_message` 追问;`one-shot`:调用即等待结果 |
| `persona` | 子 agent 的角色指令 |
| `maxDepth` | 子 agent 还能不能再派生子 agent;`0` 禁止,`1` 只允许一层 |
| `toolFilter` | 限制子 agent 的全局工具,例如 `deny: ['write', 'edit']` |
| `agentOptions` | 子 agent 的 provider/model/reasoningEffort/maxTokens;不写则继承父 agent 的兼容路由 |

#### 主从关系

- `backgroundMode: continuable` 时,父 agent 调用 `coder("...")` 会得到子 agent id,主 turn 可以继续做别的事。
- 父 agent 可用 `list_agents` 查看自己启动的 continuable 子代理。
- 父 agent 可用 `send_message(agent_id, message)` 给直接子代理追加任务。
- 父 agent 可用 `interrupt_agent(agent_id)` 停止某个子代理的当前 turn,但保留它的会话。
- `list_agents(scope="descendants")` 能看整棵子代理树;`send_message` 只能直接父子,兄弟之间不能互发。
- `maxDepth` 控制树深;`toolFilter` 可以给 reviewer 做“只读”约束。

这就形成了一个原生的主从树:

```text
main agent
  ├── researcher (continuable, 只读)
  ├── coder       (continuable, 可写)
  └── reviewer    (continuable, 只读审查)
```

#### 固定 workflow / DAG

如果流程是确定的,例如“并行调研 3 个方向 → 汇总 → 实现 → 审查”,不要让主 agent 自由发挥,直接用原生 `workflow` 工具写脚本:

```js
const research = await parallel([
  () => agent('调研 dsh 的 session 持久化'),
  () => agent('调研 dsh 的 subagent 机制'),
  () => agent('调研 dsh 的 workflow 引擎'),
])

phase('implement')
const code = await agent(`根据以下调研实现最小 demo:\n${JSON.stringify(research)}`)

phase('review')
const review = await agent(`审查实现:\n${code}`)

return { research, code, review }
```

`workflow` 适合一次性 DAG;`continuable` 命名 subagent 适合长期主从关系。两者可以组合:主 agent 用 `workflow` 做批量编排,用命名 subagent 做需要多轮追问的角色。

#### 让模型知道有哪些子 agent

仅挂工具还不够。工具有名字,但模型不一定知道何时用。建议二选一:

1. 在 `agent_platform/skills/` 加一个 `subagents/SKILL.md`,写清每个工具的职责和使用时机;
2. 或在 `workflows.json`/平台 prompt 里加一段名册(当前平台只内置 coder/reviewer,自定义工具需要自己补 prompt)。

推荐用 skill,因为 skill 是模型可发现的,且与工具配置解耦。

#### 和当前团队模式的关系

当前团队模式是**平台侧 root session 编排**:

```text
lead(root) → coder(root) → reviewer(root)
```

命名 subagent 是**父 agent 内的子会话树**:

```text
main(root) → coder(child) / reviewer(child)
```

两者不要混用同一套角色名,否则模型会混淆“平台角色”和“子代理工具”。如果要迁移,建议:

- 保留平台团队模式作为稳定的质量门禁;
- 另建一个“自由编排”模式,启用 `agents.yml`,主 agent 自己调用子 agent。

---

## 7. 轨迹

`🧭 轨迹` 是前端的事件账本，不是 dsh 官方 Trajectory 的完整实现。

记录内容：

- USER / Turn / Step
- tool call / result + 耗时
- Assistant message / reasoning 摘要
- team phase / verdict
- subagent started/finished
- usage(input/output/cached)
- end reason

实现：

- `App.tsx` 在 `sendTurn` 的 `apply` 里把 SSE 事件追加到 `TrajectoryEvent[]`；
- 跳过 `assistant_delta`、`assistant_stream_start/end`、`chat_title`；
- 每个 chat 存在 `sessionStorage`，刷新页面保留；
- 右侧 dock 由 `TrajectoryDock.tsx` 渲染；
- turn/step/tool 的时间是**客户端收到事件的时间**，不是 dsh 的精确 session timing。

与官方的差距：

- 没有请求 header、system prompt、tool schema；
- 没有 TTFT / decoding 拆分；
- 没有完整 session event replay；
- 没有跨设备/跨浏览器持久化。

要完全对齐官方 Trajectory，需要改用 dsh Web host 的 session-event/assistant-stream 传输，或者在 runtime 侧补一个完整 session bridge。

---

## 8. 停止全部

当前实现是**硬停止**：

```http
POST /api/stop
```

行为：

1. 给所有 chat 标记 `stop_requested`；
2. 终止共享 dsh runtime 子进程；
3. 正在 `session.run` 的 worker 收到 `TransportClosedError`；
4. worker 看到 `stop_requested` 后输出干净的 `end(finish_reason=stopped)`；
5. 下一条消息由 `_ensure_harness()` 自动重启 runtime；
6. 旧 runtime session 失效，下一条消息走“新建 runtime session + 注入最近对话”的恢复逻辑。

为什么不做单会话优雅取消：

- Python SDK 的 wire 没有 `session/cancel` / prompt-cancel；
- runtime 内部有 `agent.cancel()`,但需要额外 cancel bridge 才能暴露给 Python。

---

## 9. 运行时恢复

`_ensure_harness()` 会在每次真实消息前检查：

```python
proc = harness.client._proc
alive = proc is not None and proc.poll() is None
```

如果 runtime 已退出：

- 关闭旧 harness；
- 用保存的 `harness_factory` 重新启动；
- 失败则返回 503，不继续写已关闭的管道。

`/api/config` 暴露：

```json
{
  "runtimeAlive": true,
  "streaming": true,
  "startupError": null
}
```

---

## 10. 常见问题排查

### Skill 不出现

1. 文件是否是 `agent_platform/skills/<name>/SKILL.md` 或 `<name>.md`？
2. frontmatter 是否有合法 `name` / `description`？
3. runtime 是否带上了 `skills.yml` patch？
4. `/api/config` 是否正常、runtime 是否启动？
5. 新会话/新 step 才会刷新 catalog。

### MCP 工具不出现

1. 是否把 `mcp.example.yml` 复制成了 `mcp.yml`？
2. patch 是否有 `insert` 和正确的 `name: '@deepseek-ai/dsh-mcp-client'`？
3. `serverName` 是否唯一、合法？
4. stdio 的 `command` 是否存在？`npx` 是否能联网安装包？
5. 需要的 token 是否在启动 uvicorn 的 shell 环境里？
6. 看 runtime stderr / 启动日志；必要时设置 `failOnStartupError: true` 让错误显性化。

### 没有 token 流式

1. `/api/config` 的 `streaming` 是否为 `true`？
2. 顶栏是否有 `⚡ 流式`？
3. 浏览器是否加载了最新的 `index-*.js`（强制刷新）？
4. DevTools Network 的 SSE 里是否有 `assistant_delta`？
5. 如果 `assistant_delta` 有但页面不逐字，检查 `api.ts` 的 8ms pacing 和 React 版本。

### 白屏

- 常见原因是旧 `index.html` 引用了被删除的 hash 资源；
- 构建已改为 `emptyOutDir: false` 保留旧资源；
- 后端对缺失的 `*.js` 返回自动刷新脚本，对缺失 `*.css` 返回空样式；
- 仍然白屏时强制刷新，检查 DevTools Console/Network 的 404。

### `409 上一条消息还在处理中`

一个 chat 同时只允许一个 turn。等当前 SSE 结束，或点“停止全部”。

### `TransportClosedError`

runtime 退出或被杀。下一条消息会自动重启；如果重启失败，看 `/api/config.startupError` 和服务端日志。

---

## 11. 安全与部署边界

- 平台没有鉴权，**不要暴露到公网**。
- agent 有 bash 权限，工作目录是 `.dsh-workspace/`，但沙箱策略仍应在 runtime 层确认。
- `.env`、`.dsh-home/`、`.dsh-workspace/`、`.venv/`、`node_modules/` 不应提交到 git。
- MCP token 只放在环境变量或本地 patch，不要提交。
- 停止全部会杀掉共享 runtime；多用户场景下需要改成 per-session cancel bridge 或 Web host API。
- 会话历史目前在内存里，重启即清；生产化需要 SQLite/文件持久化。
