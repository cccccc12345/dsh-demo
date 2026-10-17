# DeepSeek Harness · Agent Web 平台

基于 `deepseek-harness` SDK 的一个最小可用的 Agent Web 平台:多会话聊天界面 + SSE 流式事件推送(工具调用、推理、最终回复)。

## 结构

```
agent_platform/
├── main.py            # FastAPI 后端:SSE 流式、会话管理、事件翻译
├── workflows.py       # 平台 agent 名册/团队 prompt 上下文
├── skills/            # 自定义 skill(SKILL.md,热更新)
├── dsh-patches/       # runtime patch(自定义 skill 根等)
├── dsh-plugins/       # runtime 插件(assistant-stream 转发)
├── static/            # 前端构建产物(webui 构建输出,勿手改)
├── static-legacy/     # 旧版原生 JS 前端留档
└── webui/             # React + Vite 前端源码(仿 dsh 官方 AgentBox 风格)
    └── pnpm build     # 构建即写入 ../static,uvicorn 免重启
```

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

可选环境变量:`DSH_MODEL`(默认 `deepseek-v4-flash`)、`DSH_PROVIDER`(默认 `deepseek-official`)、`DEEPSEEK_BASE_URL`。

## 行为说明

- **Mock 模式**:启动时检测 `DEEPSEEK_API_KEY` 缺失或含非法字符(如中文引号占位符),则自动用本地剧本回放,不发模型请求,方便先看 UI。
- **真实模式**:进程启动时拉起一个 harness runtime 子进程(dsh),所有会话共享;agent 的工作目录是 `.dsh-workspace/`(bash/read 等工具只能碰这里),运行时状态存 `.dsh-home/`。
- 每个平台会话 = 一个 dsh session(`session-<uuid>`),右侧会话切换后历史从后端内存恢复。
- **团队模式**(输入框下方勾选):平台先让内部 lead 判断请求类型,不再把所有输入都塞进编码流程 ——
  - 普通问答、闲聊、能力询问 → lead 直接回答,不进入 coder/reviewer;
  - 只读代码/文件调查 → investigator 只读回答,不触发 review;
  - 需要改文件、实现功能、修 bug → 进入 coder + reviewer 流程:
    1. 👨‍💻 **Coder**(独立 runtime 会话,角色指令内置):实现任务、自测、汇报改动文件
    2. 🔍 **Reviewer**(独立 runtime 会话):独自读代码/跑测试,按规范输出 `结论:APPROVE / NEEDS_CHANGES`
    3. reviewer 打回时,coder 会话继续(上下文连续)修复一轮,再交 reviewer 复审(默认最多 1 轮)
  - 全程 SSE 流式:路由说明、阶段头、verdict、两个 agent 的工具调用/推理/结论气泡(左侧色条区分角色)
- **Agent 名册**:`list_agents` 是 dsh runtime 的"当前 agent 已派生的 continuable 子代理"列表,
  **不是**平台角色清单。团队模式的 coder/reviewer 是并行的独立 session,不互为父子,
  所以 coder 查 `list_agents` 为空是正常的。平台会把 `workflows.json` 里的名册注入每个角色的 prompt,
  让模型能正确回答"有哪些 agent";同时通过 `GET /api/agents` 暴露名册和数量。
- 事件流(SSE)由 runtime 通知翻译而来:
  - `tool/call` / `tool/result` → 工具芯片 + 可折叠的输出
  - `assistant/message` → 助手气泡(含 `reasoning` 折叠提示)
  - `subagent.*` / 子会话事件 → 🤖 子代理渠道(SDK runtime 原生支持 `subagent`/`workflow` 等多 agent 工具)
  - `turn/start`、`step/start` → 进度条文案;`turn/end`(错误时)→ 红色错误框
- 同一会话正在跑 turn 时,再次发送返回 409;会话运行中禁止删除/切换。

## 自定义团队名册

编辑仓库根目录的 `workflows.json`,可覆盖团队角色的展示名称、emoji、职责描述和最大修复轮数。
后端会把它注入每个角色的 prompt,并可通过 `GET /api/agents` 读取当前名册与数量:

```json
{
  "id": "coder-reviewer",
  "name": "Coder + Reviewer",
  "description": "平台编排:coder 实现,reviewer 审查。",
  "maxRounds": 1,
  "agents": [
    { "id": "coder", "name": "Coder", "emoji": "👨‍💻",
      "role": "实现工程师", "writes": true },
    { "id": "reviewer", "name": "Reviewer", "emoji": "🔍",
      "role": "代码审查员", "writes": false }
  ]
}
```

- `maxRounds` 控制 reviewer 打回后 coder 最多修复几轮(0–10)。
- 当前平台编排器在 coding 路由下固定执行「coder 实现 → reviewer 审查 →(可选)coder 修复 → reviewer 复审」,
  所以角色只支持 `coder` / `reviewer`;要支持任意角色图,需要扩展 `_run_team_turn`,
  或改用 dsh 原生的 `subagent` / `workflow` 工具。
- 自定义 `name` / `emoji` 会进入 prompt 和 `GET /api/agents`,但前端团队面板暂时仍使用固定的
  Coder / Reviewer 标签;角色 `id` 始终是 `coder` / `reviewer`。
- 配置缺失或非法时自动回退到默认名册,并在启动日志里打印警告。
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

## 冒烟测试

```bash
.venv/bin/python smoke.py   # 直接跑一轮 agent turn,dump 全部事件词汇表(诊断用)
```

## 已知边界(可按需扩展)

- 会话历史在内存里,重启即清(可加 SQLite / 文件持久化)。
- **runtime 会话生命周期**:每个 chat 首次发消息时新建随机 runtime session(`chat.runtime_sid`),同进程内多轮续聊共享它;server 重启后该 chat 的 runtime 会话失效,再发消息会**自动新建 runtime 会话并把最近对话注入为上下文**(transcript 里可见一条 system 备注)。runtime 不支持从 `.dsh-home` 持久化会话续聊(实测 `already exists`),故刻意不把 chat id 当作 runtime session id,彻底规避。
- 错误与"空回复"都会写进 transcript(role=system),UI 刷新后仍可见,不会出现"发了消息没有任何反馈"的静默失败。
- 团队模式先做一次 lead 路由模型调用:普通问题更快且不会走 review;路由失败会回退旧的 coder/reviewer 流程。
- runtime 意外退出后,下一次请求会自动重启 runtime;重启失败返回 503,不会继续往已关闭的管道写请求。
- 不建议用 `uvicorn --reload` 跑这个后端:reload 会关闭 runtime,正在进行的 SSE 会收到 `TransportClosedError`;前端调试请单独用 Vite,后端改代码后手动重启。
- 无鉴权,不要暴露到公网;agent 有 bash 权限,工作目录即沙箱边界。
- 每 turn 一个线程阻塞等待 `session.status == idle`,并发上限 = 线程池(8)+ runtime 自身能力。
- 未实现中途打断(stop);dsh 协议如有 interrupt 方法可在 `agent_platform/main.py` 加端点。
