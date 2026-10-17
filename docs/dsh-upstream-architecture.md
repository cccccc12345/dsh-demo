# DeepSeek Harness(dsh)架构文档

本文档介绍本仓库 `upstream/` 目录下的完整 DeepSeek Harness 源码仓(dsh)的架构,面向想理解或基于它做二次开发的读者。事实以仓内权威文档为准,本文是导览:

- 上游架构总纲:`upstream/docs/architecture.md`(有中文版 `architecture.zh.md`)
- Cordis 框架入门:`upstream/docs/cordis-primer.md`
- 包地图:`upstream/packages/README.md`
- 决策记录(为什么这么设计):`upstream/.agents/notes/`
- 本仓库如何用上游:`README.md`(agent_platform 平台)

---

## 1. 一句话定位

DeepSeek Harness(**dsh**)是 DeepSeek 的**全插件化 agent 运行时框架**——类比 Claude Code / OpenCode 的 harness 层:它负责会话日志、agent loop(模型循环)、工具注册与执行流水线、prompt 组装、沙箱与审批、后台任务、Web GUI、SDK 等一切 agent 基础设施。

它的核心哲学是:**没有需要 hack 的特权内核**。产品里的每一块——模型适配器、工具注册表、session 日志、agent loop 本身——都是 Cordis 框架里的一个插件,可以由配置(patch)替换、增删。产品不过是一棵在启动时按序组合出来的插件树。

对外提供多种形态:

| 形态 | 入口 | 说明 |
|---|---|---|
| Web GUI | `dsh --profile web` | 浏览器版 AgentBox 官方界面(host 服务 + 浏览器 client) |
| 一次性任务 | `dsh --profile headless "任务"` | 跑完一个持久化会话、打印最终答案、退出 |
| Out-of-process SDK | `dsh --profile sdk` | JSON-RPC over stdio 服务,配 TypeScript / Python SDK |
| 极简 SDK 树 | `dsh --profile sdk-minimal` | 独立的最小插件树(不叠 dsh-base) |
| 自动化协议 | `dsh --profile acp` | 仅自动化用途的 Agent Client Protocol stdio 服务 |
| 桌面应用 | Electron(`apps/desktop`) | 内置签名 dsh 生产 runtime + 保留的 `desktop` profile |

本仓库(`agent_platform/`)走的是 **Python SDK** 路线,详见第 11 节。

## 2. 分层总览

```
┌─ 应用形态层 (apps/ + python/) ───────────────────────────────────────┐
│  apps/cli     dsh 命令(唯一受支持的 Node 应用启动器)                 │
│  apps/web     Web GUI(官方 AgentBox 前端)                            │
│  apps/desktop + apps/desktop-host   Electron 桌面                     │
│  python/      Python SDK(deepseek_harness)+ 打包好的 runtime 轮子     │
├─ 组合层 (packages/bundle + profile) ─────────────────────────────────┤
│  profiles: web / headless / sdk / sdk-minimal / acp                  │
│  dsh-base(bundle): 模型适配器+工具+持久化+沙箱/审批+设置+凭据…         │
│  cordis.yml(插件配置)+ 有序 patch 叠层定制                            │
├─ 产品 API 脊柱 (packages/core) ──────────────────────────────────────┤
│  ctx.sessions 会话日志 · ctx.systemPrompt · ctx.tools                 │
│  ctx.agents · ctx.agentLoop(默认驱动,可换) · ctx.llm                │
├─ 能力包族 (packages/* ≈50+ 包) ──────────────────────────────────────┤
│  执行世界: shell/subprocess/sandbox/ssh/terminal/ptc-runtime          │
│  模型工具: fs/web/lsp/skill/mcp/computer-use/browser-use/todo/…       │
│  上下文:   compaction/context/attachment/spill/deliverables           │
│  编排:     subagent/jobs/workflow/preset/plan/goal/schedule/guard     │
│  界面:     host(服务端) + client(浏览器) · settings/credentials      │
│  数据面:   session 持久化 · session-query 检索 · storage              │
├─ 插件框架 (vendor/cordis,vendored) ─────────────────────────────────┤
│  plugin · ctx 服务仓库 · 类型化事件 · 可逆 effect 注册 · HMR          │
└─────────────────────────────────────────────────────────────────────┘

  周边设施: native/(node-addon 原生模块) · scripts/(门禁与生成器)
            benchmarks/ · snapshots/ · patches/ · docs/ + website/(VitePress)
```

依赖铁律(见 `upstream/packages/README.md`):**扩展插件只依赖 Service Definition,绝不依赖具体 provider**。UI/hook/工具插件依赖 `dsh-agent` 而非 `dsh-agent-loop`(loop 本身可换);只有组合用的 bundle 才允许依赖脊柱插件。

## 3. 地基:Cordis 插件框架

Cordis 是 vendored 的插件框架(`vendor/` 目录,`vendor/README.md` 带上游 SHA 清单)。dsh 的一切上层机制都建立在 5 个概念上:

1. **插件 = Service**:可以是带 `inject` / `apply(ctx)` 字段的函数,也可以是 `Service` 子类,由 Loader 挂载进 context(服务包 default-export 服务类;函数插件命名导出 `name` / `inject` / `Config` / `apply`,二者不混)。
2. **context(简写 `ctx`)= 服务仓库**:每个服务声明一个稳定的 `ctx.<key>`(如 `ctx.tools`、`ctx.llm`、`ctx.sessions`),其他插件按 key 找服务,而不是直接 import 具体实现。
3. **用 `inject` 声明依赖**:插件等所需服务就绪后再激活,加载顺序由服务需求表达,不需要手工排序启动。(可选服务用 `ctx.get(key)` 取,避免 topology 敏感的属性代理。)
4. **类型化事件通信**:5 种分发模式,模式属于事件公开契约的一部分:

| 模式 | 是否等待 | 监听顺序 | 有返回值 |
|---|---|---|---|
| `emit` | 否 | 按注册顺序观察 | 否 |
| `waterfall` | 否 | 按注册顺序 | 有 |
| `parallel` | 是 | 并行 | 否 |
| `serial` | 是 | 按注册顺序 | 有 |
| `bail` | 否 | 触发到第一个 bail 即停 | 有 |

   **waterfall 语义 = around 中间件**:监听器收到 `(...args, next)`,必须调 `next()` 把结果交给下一个监听器;不调 `next()` 直接 return 就是短路。策略型监听器(拥有决定权)短路是设计意图;仅观测/注解的监听器必须委托。
5. **注册皆 effect**:`ctx.effect()` / `ctx.on()` 安装的一切(prompt section、tool schema、adapter、provider、监听器)都会返回 disposer,插件卸载/HMR 时按序回卷。仓库还有一条强规则:**每个注册贡献都要证明可处置**(HMR 测试:dispose 后观测到条目被移除)。

手写插件装配文件是 `cordis.yml`(Cordis 配置):`config` 和 `disabled` 字段允许 `!!js` 表达式插值(注意不能写 `!js`),其余字段保持字面量;需要按环境选择插件的组合一律走 overlay patch。

## 4. 组合机制:profile / bundle / patch

一个运行中的 `dsh` = 启动时按序组合出的插件树。

- **profile(档案)**:存放在 Harness home 的命名组合,列出要叠的 bundle 清单、到哪里装 out-of-tree 插件,以及用户自己的 `cordis.patch.yml`。每个 profile 在自己的 `package.json` 用 `dsh.profile` 声明 bundle 列表。
- **bundle(束)**:"可安装的 patch 层",`package.json` 里 `dsh.bundle.patch` 指向 patch 文件。`packages/bundle/base`(dsh-base)是 `web / headless / sdk / acp` 四个 profile 的共享第一层,内容覆盖:模型适配器、工具、持久化、沙箱与审批策略、settings、credentials、遥测。`sdk-minimal` 是刻意保留的例外:一个 bundle 拥有完整显式的 SDK 插件树,不叠 dsh-base。

**叠层顺序**(后者覆盖前者;patch 按行 id 替换整行 config,或插入新行;preset patch 在声明内部以同样优先级递归应用):

```
profile 有序 bundle 列表  →  profile cordis.patch.yml  →  home patch  →  --patch 覆盖
```

查看机器实际启动的插件树:

```sh
dsh --profile web --dump-config
# 打印出来的任何一行,都可以被你自己的一份 patch 替换
```

HMR 由 YAML 控制:base 对 Web 开启 config-only HMR;headless/SDK/ACP 关闭;`sdk-minimal` 不含。YAML 改配置 → 插件行随 HMR 重建,这是 dsh 可定制性的关键体验之一。

**活例子**:本仓库 `upstream/agentbox.patch.yml` 就是最典型的 `--patch` 用法——在官方 Web profile 上,把与官方账号/余额体系耦合的几行插件整行禁用(`deepseek-account`、`account-controller`、`ui-settings-account`、`llm-deepseek-account`),把 `agent-default-model` 的整行 config 替换为 API-key 直连路由(`deepseek-official`),再 `insert` 启用实验性的 Agent Teams 面板。全程**没有改过任何上游源码**——这正是"叠层 patch 取代 fork"的设计意图。配套启动脚本:`upstream/agentbox.sh`。

## 5. 核心 API 脊柱(packages/core)

| 包 | 职责 | ctx key |
|---|---|---|
| `core/session` | 仅追加(append-only)的 `SessionEvent` 日志与内存存储 | `ctx.sessions` |
| `core/system-prompt` | 有序 prompt section + tool schema 组装 | `ctx.systemPrompt` |
| `core/tools` | 受管辖的工具注册表与执行流水线 | `ctx.tools` |
| `core/agent` | `Agent` 句柄、活跃注册表、`agent/*` 事件 | `ctx.agents` |
| `core/agent-loop` | 上述 `Agent` 接口的默认实现(可整体替换) | `ctx.agentLoop` |
| `core/agent-default-model` | 部署级默认模型选择入口 | `ctx.agentDefaultModel` |
| `core/scope` | 按 agent 隔离注册/事件路由的原语 | 库,无 key |
| `llm/llm` | 消息与流词汇表 + 适配器接缝 | `ctx.llm` |

## 6. 事件三域与 turn 生命周期

写行为前先选事件域(权威版:`upstream/docs/architecture.md` § Events):

- **Session events**:写入日志的持久事实,经 `session/event` 广播——事实需要在重载后仍存在,就用它。
- **Agent events(`agent/*`)**:携带活的 `Agent` 对象——观测/拦截进行中的工作(收件箱、step、状态、请求、校验、续跑)。
- **Capability events**:把策略与适配器贴到能力接缝上(`fs/*`、`tools/*`、`telemetry/*`),不 import 就能生效。

每个 **step** = 一次模型请求 + 它触发的工具批;每个 **turn** = 零或多个 step。主循环(简化):

```
turn/start
  认领下一步输入(含一条排队消息)
  组装 prompt sections + tool schemas
  agent/pre-step        (waterfall:决定接受哪些输入,可改写/拒绝;拒绝或空→不执行 step 直接关 turn)
  step/start
  agent/request + prepareCall   解析真正的模型调用(此后取消:系统与用户都不落账)
  把被接受的消息作为 user/message 落账;从日志派生并冻结模型历史
  流式调用 → llm/stream → agent/assistant-stream(进程本地的实时帧)
  完整压缩流先落账成 assistant/message(或 assistant/attempt),再发已提交的 end 帧
  tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*
  step/end
  还有工具欠一次请求,或新输入到达 → 认领 → 下一个 step
turn 收尾检查 → turn/end
```

`turn/*、step/*、system|user|assistant/message、assistant/attempt、tool/*` 是持久 session 事件;`agent/pre-step、agent/request、llm/stream` 与三个 `tools/*` 是 waterfall 实时扩展点。详细时序见 `upstream/docs/agent-lifecycle.md` 与 `upstream/docs/subsystems/core.md`。

发送侧支持 `agent.inject()` 把模型可见的上下文塞进下一次请求;每个 agent 由单一收件箱驱动,注入的上下文会排队等唤醒。失败 step 会补写缺失的 tool result(`agent-loop` README 的 ordering 一节)。

## 7. Session 日志:唯一事实源

- 日志是 **append-only** 事件序列;`deriveMessages()` 从日志投影出模型历史。铁律:**"模型可见 ⟺ 已写入日志"**——任何进入模型请求的东西都必须能从日志重建;新增模型可见输入必须新增 session 事件。这保证了 fork / resume / transcript / 遥测 / 持久化从同一事实源派生。
- 每条 `assistant/message` 内嵌产生它的完整压缩 timed 流;`assistant/attempt` 只落日志不进模型历史,保留失败/重试/取消/流错误的原始尝试。进程在 settle 前硬挂,则没有持久 attempt 流(实时 UI 增量来自 `agent/assistant-stream`)。
- **持久化格式**:v0 用 `session.jsonl[.zstd]`,之后是 `session.vN.jsonl[.zstd]`;版本即 generation。**已提交的 generation 路径永不重命名、覆盖或删除**。读取时把"相邻迁移链"(`vN → vN+1` 每步一个独立迁移包)先在内存里串完;写入式打开会先编码、校验,然后在源 generation 旁独占地发布最终的 version-named successor。
- SQLite 侧单独用单调递增的 `SCHEMA_VERSION`。
- **投影接缝**(host 读不到该服务就激活即失败):`ctx.sessionProjections` 让单元增量 fold 已提交事件;host 用 `stateOf()` 读一个类型化状态;远程视图用 `snapshot()` 批量下发裁剪后的客户端视图。agent-loop 在此注册共享的 `turnBoundary` 状态。
- 会话标题(`ctx.sessionTitle` 唯一 provider)、报表、会话检索(`session-query`:逻辑语料 / 有界读取 / 血缘 / 语义过滤 / SQLite 全文搜索)都是这个数据面上的服务。

## 8. 工具执行流水线(ctx.tools)

工具不散落在各处直接执行,而是全部经过同一条流水线(权威版:`upstream/docs/tool-execution-pipeline.md`):

```
assistant 消息带 tool-call 块
→ tool/call 先落日志(执行前)→ UI 出"待执行"卡片
→ tools/pre-execute waterfall:钩子、权限、沙箱包装
→ 注册的单调守卫(monotonic guards):拒绝或弃权
→ ctx.approval 一次性人工审批(服务缺席或不可答 = 拒绝)
→ tools/execute waterfall(around):超时 / 重试 / 指标
→ 工具 execute() 本体(内部可发 todo/write、fs/observed 等工具自有事件;
   仅对 tool-fs 变更走 fs/write-intent、fs/edit-intent 门)
→ projectContent(按 tool 定义准备展示文案与图片)
→ tools/post-execute waterfall:接受 / 阻断 / 改写 / 追加 additionalContext
→ 注册表外层规范化(流水线与结果快照中的抛错一律规范化为 isError 结果)
→ finalizeContent(仅内容,保证不变式)
→ tools/result(冻结的最终权威结果,同步通知)
→ 落账 tool/result(单个模型可见结果)→ UI 出完成卡片
→ 同批 additionalContexts 以 FIFO 注入 user/message
```

推论:**审批、超时、脱敏展示都是事件监听器,不需要改 loop**。任何失败都被规范化为结果而不是中断,同时保证 model-facing 的工具结果唯一且冻结。

本仓库的 `approval-bridge` 插件就是这个接缝上的一个 answerer:它监听 `approval/request`,
通过本地 HTTP 回调把问题送到 Web 审批条,拿到人工决定后返回 `allowed-once` / `rejected`。
详见 [人工审批(HITL)](human-in-the-loop.md)。

## 9. Capability Seam(能力接缝)模式

一个 **seam = 可替换的能力**,由三个角色构成完整组合:

- **Service Definition**:声明接口契约的包;
- **Service Provider**:实现接口的包;
- **Consumer**:使用它的包,常见是模型工具。

一个包可兼任多角色,但只有单角色不构成 seam——加能力必须三个角色一起设计(决策记录:`.agents/notes/implemented/architecture/2026-06-13-capability-seams.md`)。

这是"换一个 provider、整个产品跟随"的原因:

- **执行世界**:fs + subprocess + sandbox 共享同一个执行世界,把它们的 provider 指向远程沙箱,Bash、PTY、LSP 就整块跟着迁移,不需要逐个能力写 provider 分支。沙箱接缝本身有 bwrap / Landlock / Seatbelt 三个 confinement 后端,消费者在 spawn 前用 `ctx.sandbox` 包装 argv。
- **subagent**:同一个子代理接口之下,provider 可以是"新起一个子 agent",也可以是"委托给另一个产品里的一次会话回合"(见 `docs/subsystems/subagent.md`)。

`interaction` 包族(static approval seam + permission preset + ask-user 工具)在审批路径上与工具流水线无缝衔接:approval 是 seam 上的一个 provider,替换后端不需要改工具。

## 10. 能力包族速查

只列关键角色,详细契约见各组 README(`packages/<group>/README.md`):

| 族 | key 包 | 说明 |
|---|---|---|
| 执行 | `shell`(`ctx.shell`)· `terminal`(PTY)· `ptc-runtime` · `subprocess` · `sandbox` · `ssh` | PTC = 沙箱化 Node 的 plan-to-code 执行;ssh 实现成对挂 fs/subprocess/sandbox |
| 模型工具 | `fs` · `web`(search/fetch)· `lsp` · `skill` · `mcp`(外接 MCP server 变原生工具)· `todo`(`todo_write`)· `computer-use` · `browser-use` | computer/browser-use 是独占命名 provider 注册 |
| 上下文管理 | `compaction`(压缩)· `context`(工作区指令/时间上下文)· `attachment`(内容寻址存储)· `spill`(超大工具结果溢出)· `deliverables`(交付物与工作区变更记录) | |
| 编排 | `subagent` · `jobs`(`job_*` 工具管后台任务)· `workflow`(PTC 流程引擎 + `workflow` 工具)· `preset`(从 preset cordis.yml 按会话换能力组合,含 `isolate` realm)· `plan` / `goal` / `schedule`(Host 拥有的定时跟进)· `guard`(循环卫生:重复调用劝阻 + `tools/execute` 截止时间强制器)· `extensions`(插件/服务检查 + 模型自己写配置挂载/卸载 = 运行时自我修改) | |
| 人机交互 | `interaction`(审批/interaction seam、权限预设、命令、ask-user 工具)· `feedback` · `settings` · `credentials`(凭据引用 + env-over-`.env` provider + 需要 human 的授权流) | |
| 数据 | `session`(持久化接缝 + 后端、投影接缝、日志标题、会话报表)· `session-query`(检索/导出)· `storage`(非会话存储 hub)· `identity` · `workspace` | |
| 界面 | `host`(GUI 服务端:RPC/流/对象服务、目录选取、应用启动、插件清单、产品遥测)· `client`(浏览器半区:shell、wire、object services、slots、`ui-*` 插件)· `typert`(类型图生成/加载/运行时注册表)· `api`(远程 BFF 组装 + Typert RPC 网关) | Web Chat 节点通过 `ConversationNodeDefinition` + keyed renderer 扩展 |

两个值得点名的设计:

- **`guard`**:对 loop 卫生双保险——模型侧 advisory(重复调用提醒)+ 强制侧(`tools/execute` 上注册的 deadline enforcer)。相同"劝阻/强制"分层的思路贯穿流水线设计。
- **`extensions`**:把"插件清单 + 服务检查"暴露给模型,允许模型自己写 patch 挂载/卸载运行功能——能力自我扩展是产品级特性而不是 hack。

## 11. 对外接缝:apps / SDK / Python

### dsh CLI(apps/cli)

`dsh` 是**唯一**受支持的 Node 应用启动器;各 package 的 bin、demo、构建/测试专用可执行、浏览器内预览都不允许成为应用入口(由 `scripts/verify-application-entrypoints.ts` 强制)。入口模式:

```sh
dsh <name> / dsh --profile <name>     # 启动 profile(即 $DSH_HOME/profiles/<name>)
dsh web                              # Web profile
dsh --profile headless "任务"        # 一次性任务
dsh --profile sdk / sdk-minimal / acp
dsh plugin --profile <name> <pnpm>   # 管理该 profile 的插件(转发到 pnpm)
```

启动器只解析自己的 flag,其余参数原样交给启动后的 app 插件(`dsh-cmdline`),所以 `dsh --profile web --port 8080` 的 `--port` 属于 Web app。`web / headless / sdk / sdk-minimal / acp` 首次使用即从模板自动初始化;`desktop` 名字为 Electron 保留,CLI 拒绝直接启动它。

### Web GUI + 桌面

Web 面严格分两半:`host`(Node 侧 GUI 服务)与 `client`(浏览器侧 shell + slots + `ui-*` 插件)。工具卡片的呈现规则是:**host presenter 保持 pure;Web 卡片由原始事件 + 持久化结果元数据派生**(`docs/cookbook/adding-a-tool.md`)。

桌面版 Electron 把**精确的生产 dsh runtime** 打进签名资源,拥有保留的 `desktop` profile;窗口加载打包好的 Web 资产与 boot 注入,并在同一 document 里激活 client 插件——即"桌面 = 一台可信 host 上的完整 Web 应用"。Node IPC 只承载 boot 注入、就绪、致命错误、关闭信号。

### SDK 两个同构实现(TS 与 Python)

- TS:`dsh --profile sdk` 起 JSON-RPC stdio server,TS SDK client 连接;`sdk-minimal` 是"一个 bundle 拥有整个最小 SDK 树"的独立形态。
- Python(`upstream/python/`):
  - `deepseek-harness-sdk` / `deepseek_harness`:高层 turn API + 低层 JSON-RPC client。
  - `deepseek-harness-runtime-bin` / `deepseek_harness_runtime`:打包好的 dsh CLI 可执行 + 原生 sidecar,即"runtime 轮子"。
  - 行为:SDK 启动匹配的 `dsh --profile sdk` runtime 子进程,通过 **newline-delimited JSON-RPC over stdio** 通信;Python 只暴露"选 profile + 有序 patch 文件",不暴露完整 Cordis 树;**每次启动必须显式指定 Harness home**,绝不静默读 `~/.dsh`;持久化外部插件通过 `dsh plugin` 安装。

**本仓库对接方式**:`agent_platform/agent/`(agent 核心)+ `agent_platform/web/`(FastAPI 适配层)用这套 Python SDK——进程启动时拉起共享的 dsh runtime 子进程(agent 工作目录 = `.dsh-workspace/`,runtime 状态 = `.dsh-home/`),每个平台会话对应一个 `session-<uuid>` runtime session,把 runtime 通知翻译成 SSE 流(工具芯片 / 推理折叠 / 子代理渠道 / 进度文案)。`smoke.py` 跑一轮 turn 并 dump 全部事件词汇表,可直接对照 `upstream/docs/agent-lifecycle.md` 理解事件面。

## 12. 工程与质量体系

整个仓按"AI agent 可持续维护"设计——文档体系本身也被门禁检查(`upstream/docs/AGENTS.md` 定义了层级、one-home-per-fact、字数预算与校验):

- **生成即权威的目录**(由脚本再生,过期 CI 会红):模块图 `module-graph.md`、工具目录 `tool-catalog.md`、配置目录 `config-catalog.md`、持久化格式目录 `persistence-catalog.md`(附 `persistence-schema.json`)、CLI 帮助、各子系统页的 Cordis API 面(cordis-surface)。
- **测试体系**(`upstream/docs/testing.md`):
  - 单测 + `test:coverage` 是 CI 覆盖门(**`packages/*/*/src` 每文件 100% 覆盖率**);
  - 真键 e2e(无 `DEEPSEEK_API_KEY` 自跳过);
  - **快照回放**:无键重放录制的会话,走发货级 profiles,TS 与 Python 两套 SDK 的期望输出在同一 PR 里同步更新;
  - spec 在 fork 出的 worker 里与其他门禁进程并发执行,端口/路径/子进程的生命周期全部由 teardown 认领。
- **开发规约**:全 ESM;`strict: true` + `noImplicitAny`,`any` 需逐个说明理由;静态门禁与测试把 workspace 导入经 tsconfig `paths` 解析回 `src`(源面/工件面严格分离);凡可机械检查的不变式都提成顶层执行的 verify 脚本(`verify-export-jsdoc`、`verify-doc-budgets`、`verify-md-links`、`verify-application-entrypoints` 等);跨边界 id 一律 branded type;信任 TypeScript 同进程类型,只在解析器/配置/队列/JSON/持久化/worker/进程/wire 边界加运行时校验。
- **文档契约**:README / JSDoc / 文档与代码同 PR 更新;`architecture.md` 是唯一叙事总览(≤2400 词),类型定义归 `docs/subsystems/`,决策理由归 `.agents/notes/`(可归档),教程归 `docs/cookbook/`,产品指南归 `docs/user/`,审查规则归 `docs/defensive-patterns/`。中文文档通过 pairing workflow 与英文同步。
- `benchmarks/` 性能门禁;`native/` 是 `@deepseek-ai/node-addon-system` 原生源;`website/` 是 VitePress 文档投影;`patches/` 是依赖补丁;`snapshots/` 顶层树只放会话驱动的录制用例。

## 13. 读者地图建议

| 你想… | 从这里开始 |
|---|---|
| 理解整体 | `docs/architecture.zh.md` → `docs/cordis-primer.md` |
| 写一个插件/包 | `docs/cookbook/adding-a-package.md` → `packages/AGENTS.md` |
| 加一个模型工具 | `docs/cookbook/adding-a-tool.md`(含 UI 卡片设计) |
| 接一个新模型 provider | `docs/cookbook/adding-an-llm-adapter.md` |
| 用 Python 驱动 harness | `python/sdk/README.md` → 本仓库 `agent_platform/agent/service.py` |
| 理解事件与 turn 细节 | `docs/agent-lifecycle.md` + `docs/subsystems/core.md` |
| 跑起来看看 | 本仓 `upstream/agentbox.sh`(Web,patched)或 `agent_platform`(`.venv/bin/uvicorn agent_platform.main:app`) |
