# DeepSeek Harness · Agent Web 平台

基于 `deepseek-harness` SDK 的一个最小可用的 Agent Web 平台:多会话聊天界面 + SSE 流式事件推送(工具调用、推理、最终回复)。

**深入阅读:** [配置与原理](docs/configuration-and-internals.md) — skill、MCP、流式、workflow、停止、轨迹的实现细节；[前端实现](docs/frontend-implementation.md) — 仿官方 DSH Web 的布局、组件、SSE 归约与主题；[自定义工具](docs/custom-tools.md) — function calling、原生工具插件、MCP 与 demo；[人工审批](docs/human-in-the-loop.md) — HITL 审批桥、浏览器审批条与 `guarded_echo` demo。

## 结构

```
agent_platform/
├── main.py            # 应用入口:uvicorn agent_platform.main:app
├── agent/             # Agent 核心:runtime、会话、turn、团队编排,不依赖 FastAPI
│   ├── service.py     # Web 层唯一门面 AgentService
│   ├── runtime.py     # 共享 dsh runtime 生命周期(启动/重启/停止)
│   ├── turns.py       # 普通对话 turn + Mock 剧本
│   ├── team.py        # 工作流编排(pipeline 顺序执行 / review 路由)
│   ├── events.py      # runtime 通知 → 前端事件
│   ├── prompts.py     # prompt 拼接与标题兜底
│   ├── models.py      # Chat 模型
│   └── config.py      # 路径、.env、patch 配置
├── web/               # Web 适配层:只做 HTTP/SSE 与静态资源
│   ├── app.py         # FastAPI 路由 + lifespan
│   ├── sse.py         # 事件队列 → SSE
│   └── static.py      # 静态资源 / SPA 入口
├── workflows.py       # 工作流配置加载/角色名册/prompt 上下文
├── skills/            # 自定义 skill(SKILL.md,热更新)
├── dsh-patches/       # runtime patch(自定义 skill 根、MCP、subagent、tools 等)
├── dsh-plugins/       # runtime 插件(assistant-stream 转发、人工审批桥)
│   └── tools/         # 本地 function-calling 工具插件(自动发现)
├── static/            # 前端构建产物(webui 构建输出,勿手改)
├── static-legacy/     # 旧版原生 JS 前端留档
└── webui/             # React + Vite 前端源码(仿 dsh 官方 AgentBox 风格)
    └── pnpm build     # 构建即写入 ../static,uvicorn 免重启
```

仓库根目录还包含:

```text
docs/frontend-implementation.md # 仿官方 DSH Web 的前端实现文档
docs/custom-tools.md            # 自定义工具技术文档
docs/human-in-the-loop.md       # 人工审批(HITL)技术文档
demos/custom_tool_demo.py       # text_stats / guarded_echo 端到端 demo
```

依赖方向是单向的:`web → agent`。`agent/` 不导入 FastAPI/Starlette,可以脱离 Web
单独实例化(`AgentService`)或做后端任务;`web/` 只调用 `AgentService` 的公开方法,
不直接接触 runtime 和通知翻译。`main.py` 只负责 `create_app()`。

## 快速启动

```bash
# 1. 安装依赖(已装则跳过)
.venv/bin/pip install -r requirements.txt

# 2. 确保 .env 或 shell 环境里有真实 key(占位符时自动进入 Mock 模式)
cp .env.example .env
# 然后编辑 .env,把 DEEPSEEK_API_KEY 换成真实 key
# 也可以直接: export DEEPSEEK_API_KEY=sk-...

# 3. 启动
.venv/bin/uvicorn agent_platform.main:app --host 127.0.0.1 --port 8765

# 4. 打开浏览器
open http://127.0.0.1:8765
```

可选环境变量:`DSH_MODEL`(默认 `deepseek-v4-flash`)、`DSH_PROVIDER`(默认 `deepseek-official`)、`DEEPSEEK_BASE_URL`;人工审批相关:`DSH_APPROVAL_BRIDGE`(默认 `1`)、`DSH_APPROVAL_TIMEOUT`(默认 `120` 秒)、`DSH_APPROVAL_TOOLS`(逗号分隔的强制审批工具)。

## 行为说明

- **Mock 模式**:启动时检测 `DEEPSEEK_API_KEY` 缺失或含非法字符(如中文引号占位符),则自动用本地剧本回放,不发模型请求,方便先看 UI。
- **真实模式**:进程启动时拉起一个 harness runtime 子进程(dsh),所有会话共享;agent 的工作目录是 `.dsh-workspace/`(bash/read 等工具只能碰这里),运行时状态存 `.dsh-home/`。
- 每个平台会话 = 一个 dsh session(`session-<uuid>`),右侧会话切换后历史从后端内存恢复。
- **工作流模式**(输入框下方勾选):由平台按 `workflows.json` 的 `type` 编排 ——
  - `pipeline`(当前仓库默认):按 `agents` 顺序执行
    **📊 数据分析 → 🧾 测试用例表格生成 → 🔁 用例去重 → 🧪 测试代码生成**。
    每个阶段是独立 runtime 会话,上一阶段的结论和 `test-artifacts/` 产物会传给下一阶段;
    全程 SSE 流式展示每个角色的工具调用、推理和输出。
  - `review`(兼容旧配置):先由内部 lead 路由,普通问答直接回答、只读调查走 investigator、
    需要改文件时进入 coder → reviewer →(可选)coder 修复 → reviewer 复审。
- **Agent 名册**:`list_agents` 是 dsh runtime 的"当前 agent 已派生的 continuable 子代理"列表,
  **不是**平台角色清单。工作流里的各角色是并行的独立 session,不互为父子,
  所以任一角色查 `list_agents` 为空是正常的。平台会把 `workflows.json` 里的名册注入每个角色的 prompt,
  让模型能正确回答"有哪些 agent";同时通过 `GET /api/agents` 暴露名册和数量。
- 事件流(SSE)由 runtime 通知翻译而来:
  - `tool/call` / `tool/result` → 工具芯片 + 可折叠的输出
  - `assistant/message` → 助手气泡(含 `reasoning` 折叠提示)
  - `subagent.*` / 子会话事件 → 🤖 子代理渠道(SDK runtime 原生支持 `subagent`/`workflow` 等多 agent 工具)
  - `turn/start`、`step/start` → 进度条文案;`turn/end`(错误时)→ 红色错误框
  - `approval_request` / `approval_resolved` → 人工审批条 + 轨迹;决定通过 `POST /api/approvals/{id}` 提交
- 同一会话正在跑 turn 时,再次发送返回 409;会话运行中禁止删除/切换。

## 自定义 Agent 工作流

编辑仓库根目录的 `workflows.json` 即可定义角色和流程。`type` 决定编排方式:

- `pipeline`:按 `agents` 数组顺序逐阶段执行,前一阶段的最终输出和产物路径作为后一阶段的输入;
- `review`:旧的 coder/reviewer 质量门禁(lead 路由 + 打回重修),角色仍只支持 `coder` / `reviewer`。

当前仓库默认是四阶段测试生成流水线:

```json
{
  "id": "test-generation",
  "name": "测试用例生成流水线",
  "type": "pipeline",
  "description": "数据分析 → 测试用例表格生成 → 用例去重 → 测试代码生成。",
  "agents": [
    { "id": "data-analysis", "name": "数据分析", "emoji": "📊",
      "role": "分析需求、数据与业务规则,输出测试范围、风险与可测试点",
      "brief": "你是测试流水线的「数据分析」阶段……",
      "deliverable": "test-artifacts/01-analysis.md" },
    { "id": "testcase-table", "name": "测试用例表格生成", "emoji": "🧾",
      "role": "产出结构化测试用例表格",
      "brief": "……", "deliverable": "test-artifacts/02-test-cases.csv" },
    { "id": "testcase-dedup", "name": "用例去重", "emoji": "🔁",
      "role": "去重、合并、规范化并校验覆盖",
      "brief": "……", "deliverable": "test-artifacts/03-test-cases-final.csv" },
    { "id": "test-code", "name": "测试代码生成", "emoji": "🧪",
      "role": "根据最终用例表生成可运行测试",
      "brief": "……", "deliverable": "tests/generated/" }
  ]
}
```

每个角色支持的字段:

| 字段 | 说明 |
|---|---|
| `id` | 必填,kebab-case 且全局唯一;不能使用 `assistant` / `lead` / `platform` |
| `name` / `emoji` | 前端和 prompt 里展示的角色名与图标 |
| `role` | 必填,一句话职责说明(进入名册和 prompt) |
| `writes` | 是否允许写工作区,仅作名册说明 |
| `brief` | 该阶段的完整工作指令;缺省时回退到 `role` |
| `deliverable` | 该阶段约定产物(相对工作区的路径),会交给下游并出现在最终汇总里 |

流水线约束:

- 阶段数 1–12,按数组顺序执行,不支持分支/并行;
- 每阶段使用独立 runtime 会话(`chat.agent_sids`),同一 chat 内可跨轮复用上下文;
- 上游结论超过 8000 字符会截断,完整内容由下游读取 `deliverable` 文件;
- 配置缺失或非法时自动回退到内置 coder/reviewer 名册,并在启动日志里打印警告;
- 修改 `workflows.json` 后需重启服务生效。

## 配置 Skill

dsh 的 skill 插件已经启用。平台通过 `agent_platform/dsh-patches/skills.yml` 把
`customSkillDirs` 指向 `agent_platform/skills/`,因此可以直接在仓库里维护技能:

```text
agent_platform/skills/
├── example/
│   └── SKILL.md          # 目录式
└── another-skill.md      # 扁平式
```

`SKILL.md` / `<name>.md` 需要 YAML frontmatter:

```markdown
---
name: example
description: 这个 skill 做什么、什么时候用。
whenToUse: 可选,补充触发场景。
---

正文是模型加载后看到的完整指令。可以把脚本、模板等资源放在同目录下,
在正文里写相对路径引用。
```

- `name` 必须是 kebab-case,`description` 必填。
- 模型在会话开始会收到 skill 目录摘要,需要时调用 `skill` 工具加载完整正文;
  用户也可以在消息里输入 `/example` 直接调用。
- 新增、删除或修改 skill 会自动热更新,下一个 step 生效,无需重启服务。
- 默认还会扫描 `.dsh-workspace/.dsh/skills`、`.dsh-workspace/.agents/skills`、
  `.dsh-home/skills` 和 `~/.agents/skills`;`agent_platform/skills` 只是额外的自定义根。
- 如果删除 `agent_platform/dsh-patches/skills.yml`,平台会回退到 dsh 默认 skill 根。
- 仓库里的 `agent_platform/skills/example/SKILL.md` 是可直接替换的示例。

## 自定义工具(Function Calling)

模型看到的工具由 dsh runtime 注册,形式是 `name + description + parameters(JSON Schema)`,
调用后由 runtime 执行;Web 层只负责转发 `tool/call` / `tool/result` 事件。
`bash`、文件读写/搜索、`web`、`skill`、`subagent`、`workflow` 等已经是这种机制。

新增自定义函数有三条路:

- **原生工具插件(推荐本地函数)**: 把插件放到
  `agent_platform/dsh-plugins/tools/<name>/index.js`。启动时平台会自动发现,生成
  `$DSH_HOME/patches/local-tools.yml` 并加载;修改后重启 uvicorn。
- **MCP server(接入已有服务最快)**: 复制 `agent_platform/dsh-patches/mcp.example.yml`
  为 `mcp.yml`,配置 `@deepseek-ai/dsh-mcp-client`。模型看到
  `mcp__<serverName>__<toolName>`。
- **命名 subagent 工具**: 用 `agents.yml` 定义 `toolName` / `persona`,
  适合把任务委派给另一个 agent,而不是普通函数。

仓库自带一个 `text_stats` demo:

```bash
.venv/bin/python -m demos.custom_tool_demo
```

输出会包含:

```text
[tool_call] text_stats {"text": "DeepSeek Harness 的 function calling demo 很好用!"}
[tool_result] isError=False 字符数:45;单词数:7
```

完整写法、schema 约定、MCP 配置和排错见 [自定义工具](docs/custom-tools.md)。

## 人工审批(HITL)

平台默认启用人工审批桥:需要审批的工具调用会暂停,并在输入框上方显示审批条。

- 浏览器里让模型调用 `guarded_echo`,或对现有工具强制审批:

  ```bash
  export DSH_APPROVAL_TOOLS="bash,write,edit"
  .venv/bin/uvicorn agent_platform.main:app --host 127.0.0.1 --port 8765
  ```

- 批准只对本次调用生效;拒绝、超时、审批通道不可用都按失败关闭处理。
- 审批事件会进入轨迹,API 是 `GET /api/approvals` 和
  `POST /api/approvals/{id}`。
- 默认等待 120 秒,可用 `DSH_APPROVAL_TIMEOUT` 调整;设置
  `DSH_APPROVAL_BRIDGE=0` 可关闭审批桥。

CLI 端到端 demo:

```bash
.venv/bin/python -m demos.custom_tool_demo --approval
```

完整架构、事件契约和限制见 [人工审批](docs/human-in-the-loop.md)。

## 流式输出

平台现在有**两层流式**:

1. **事件级 SSE**:`turn/start`、`step/start`、`tool/call`、`tool/result`、`message`、`turn/end`
   实时推送,所以工具调用和步骤进度是流式的。
2. **token 级文本**:`agent_platform/dsh-plugins/assistant-stream-forwarder` 监听 dsh 的
   `agent/assistant-stream`,把 `start / text-delta / end` 帧以 JSON-RPC notification 写到
   stdout;Python SDK 收到后由 FastAPI 翻译成:

```text
assistant_stream_start
assistant_delta
assistant_stream_end
```

前端收到 `assistant_delta` 后逐字追加到当前消息气泡,最终 `assistant/message` 再用完整文本校正。

覆盖范围:

- 普通对话:逐 token 输出;
- 团队 coder / reviewer / 只读 investigator:逐 token 输出,并保留 agent 标签;
- 团队直答:lead 先路由,再用第二轮回答流式输出;
- lead 的路由调用本身是内部 JSON,不展示,所以会先短暂等待再开始逐字输出;
- 子代理(subagent)文本目前仍按完整 `assistant/message` 展示,未逐 token;
- reasoning 仍按完整消息展示;
- skill 加载结果是工具结果,按工具完成时整段返回。

插件通过运行时生成的 `$DSH_HOME/patches/streaming.yml` 加载。改动插件或首次启用后需要重启服务;
之后 runtime 内的 assistant-stream 转发不需要再重启。`GET /api/config` 的 `streaming` 字段表示是否启用。
如果插件加载失败,前端会自动退回"完整消息一次性出现"的旧行为。

## 轨迹视图

顶栏的 `🧭 轨迹` 打开右侧轨迹抽屉,按事件顺序记录:

- `USER` / `Turn` / `Step`
- 工具调用与结果,含调用耗时
- Assistant 消息与 reasoning 摘要
- 工作流的 phase / verdict / 子代理启动结束
- token usage(`input / output / cached`)
- 结束原因(completed / stopped / error)

顶部汇总显示 turns、steps、tools、output tokens 和总耗时。轨迹按 chat 存在
`sessionStorage`,刷新页面仍可见;删除 chat 或换浏览器会清空。

这是官方 Trajectory 的简化版:官方还会展示完整 session event、请求 header、
system prompt、工具 schema、TTFT/生成耗时拆分等,这些数据当前 Python SDK
的 wire 没有暴露,所以这里用 SSE 事件 + 客户端到达时间近似。

## 停止全部任务

运行中时顶栏会出现 `⏹ 停止全部`,对应:

```text
POST /api/stop
```

语义是**硬停止**:

- 终止共享的 dsh runtime 子进程,当前所有会话、团队角色和子代理立即中断;
- 等待中的人工审批会被取消并按拒绝处理;
- 正在流式输出的 SSE 会收到 `finish_reason=stopped`,前端显示"已停止全部任务";
- runtime 在**下一条消息**到来时自动重启;
- 被中断的 chat 会走已有的 runtime 会话失效恢复逻辑(新建 runtime session 并注入最近对话)。

当前没有"只停止某个 chat、保留其他任务"的优雅取消:Python SDK 的 wire 协议没有
`session/cancel` / prompt-cancel 方法。需要单会话取消时,要走 dsh 的 Web host API
或额外的 cancel bridge 插件。

## 冒烟测试

```bash
.venv/bin/python smoke.py   # 直接跑一轮 agent turn,dump 全部事件词汇表(诊断用)
.venv/bin/python -m demos.custom_tool_demo  # 验证本地工具 text_stats 的 function calling
.venv/bin/python -m demos.custom_tool_demo --approval  # 验证人工审批 guarded_echo
```

## 已知边界(可按需扩展)

- 会话历史在内存里,重启即清(可加 SQLite / 文件持久化)。
- **runtime 会话生命周期**:每个 chat 首次发消息时新建随机 runtime session(`chat.runtime_sid`),同进程内多轮续聊共享它;server 重启后该 chat 的 runtime 会话失效,再发消息会**自动新建 runtime 会话并把最近对话注入为上下文**(transcript 里可见一条 system 备注)。runtime 不支持从 `.dsh-home` 持久化会话续聊(实测 `already exists`),故刻意不把 chat id 当作 runtime session id,彻底规避。
- 错误与"空回复"都会写进 transcript(role=system),UI 刷新后仍可见,不会出现"发了消息没有任何反馈"的静默失败。
- `review` 工作流会先做一次 lead 路由模型调用:普通问题更快且不会走 review;路由失败会回退旧的 coder/reviewer 流程。`pipeline` 工作流不做路由,按配置顺序执行。
- runtime 意外退出后,下一次请求会自动重启 runtime;重启失败返回 503,不会继续往已关闭的管道写请求。
- 不建议用 `uvicorn --reload` 跑这个后端:reload 会关闭 runtime,正在进行的 SSE 会收到 `TransportClosedError`;前端调试请单独用 Vite,后端改代码后手动重启。
- 无鉴权,不要暴露到公网;agent 有 bash 权限,工作目录即沙箱边界。
- 每 turn 一个 daemon 线程阻塞等待 runtime 进入 idle;SSE 侧用独立 8 线程池轮询事件队列,实际并发仍受 runtime 自身能力限制。
- 停止是"全部停止"(硬中断 runtime);单 chat / 单 turn 的优雅取消尚未实现,因为 Python SDK wire 没有 `session/cancel`。
