# 自定义工具(Function Calling)

本文说明在这个平台里怎么给 agent 增加自定义工具,包括:

- 原生 dsh 工具插件(同进程,最接近 OpenAI function calling);
- MCP server(外部进程,接入最快);
- 命名 subagent 工具(把任务委派给另一个 agent)。

平台自带的 `bash`、文件读写/搜索、`web`、`skill`、`subagent`、`workflow`、`todo`
等工具已经是 function calling 形式,不需要额外配置。模型看到的是每个工具的
`name + description + parameters(JSON Schema)`,调用后由 dsh runtime 执行。

> Web 层不注册工具,也不执行工具。FastAPI 只负责把 `tool/call`、`tool/result`
> 等 SSE 事件转给前端;真正的工具 schema 和 `execute()` 都在 runtime 插件里。

---

## 1. 三种方式对比

| 方式 | 运行位置 | 适合 | 是否需要写 JS 插件 |
|---|---|---|---|
| 原生 dsh 工具插件 | runtime 同进程 | 本地函数、低延迟、完全控制 schema | 是 |
| MCP server | 独立进程 / HTTP | 已有 Python/Node 服务、跨语言、可复用 | 否 |
| 命名 subagent | runtime 子会话 | 把任务交给另一个 agent,而不是普通函数 | 否 |

---

## 2. 原生工具插件(推荐用于本地函数)

平台会自动发现下面这种目录:

```text
agent_platform/dsh-plugins/tools/
└── demo-tools/
    ├── index.js
    └── package.json
```

启动时 `AgentService` 会:

1. 扫描 `agent_platform/dsh-plugins/tools/*/index.js`;
2. 生成 `$DSH_HOME/patches/local-tools.yml`;
3. 把该 patch 加进 runtime 的 `--patch` 参数。

生成出来的 patch 类似:

```yaml
- insert:
    - id: local-tool-demo-tools
      name: "file:///绝对路径/agent_platform/dsh-plugins/tools/demo-tools/index.js"
```

`name` 字段不支持 `!!js`,所以本地插件必须用绝对 `file://` URL;平台已经替你生成,
不需要手写。

### 2.1 一个最小工具

`agent_platform/dsh-plugins/tools/demo-tools/index.js` 里的 `text_stats` 就是完整示例:

```js
export const name = 'demo-tools'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register({
    name: 'text_stats',
    description: '统计一段文本的字符数和单词数。需要精确统计时调用。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要统计的完整文本。' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          characters: { type: 'integer' },
          words: { type: 'integer' },
        },
        required: ['characters', 'words'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `字符数:${value.characters};单词数:${value.words}`,
        },
      ],
    },
    async execute(args) {
      if (typeof args.text !== 'string') throw new Error('text 必须是字符串')
      const words = args.text.trim() ? args.text.trim().split(/\s+/).length : 0
      return { characters: [...args.text].length, words }
    },
  })
}
```

几个关键点:

- `inject = ['tools']`:等 `ctx.tools` 服务就绪后再注册。
- `name`:模型看到的工具名,同一作用域内不能重复。
- `parameters`:JSON Schema。模型按它生成参数。
- `output.schema`:返回值必须符合这个 schema,否则调用失败。
- `output.render`:把规范返回值转成模型/UI 看到的 content blocks,必须返回数组。
- `execute(args, exec)`:同步或异步都可以;抛错会变成模型可见的工具错误。
  原始 `ctx.tools.register` 不会替你校验入参,需要像示例一样手动检查。
- `exec.signal` 是可选的 `AbortSignal`,长时间任务可以协作取消。

> 如果你用 TypeScript 的 `defineTool()` 辅助函数,需要把
> `@deepseek-ai/dsh-tools` 安装到插件自己的 `node_modules`。SDK runtime 是单文件
> 打包,不会替外部插件解析这个包。零依赖时用上面的原始注册写法即可。

### 2.2 启用与验证

新增或修改插件后**重启 uvicorn**:

```bash
.venv/bin/uvicorn agent_platform.main:app --host 127.0.0.1 --port 8765
```

启动日志里应出现:

```text
[agent-platform] 本地工具插件:demo-tools
```

然后直接在界面里问:

```text
请用 text_stats 工具统计这句话的字符数和单词数:
DeepSeek Harness 的 function calling demo 很好用!
```

轨迹面板/工具芯片里会先出现 `text_stats` 的调用,再出现结果。

### 2.3 运行 demo 脚本

仓库里带了一个端到端脚本:

```bash
.venv/bin/python -m demos.custom_tool_demo
```

它会启动本地 runtime,发一条明确要求调用 `text_stats` 的消息,并打印:

```text
[tool_call] text_stats {"text": "DeepSeek Harness 的 function calling demo 很好用!"}
[tool_result] isError=False 字符数:45;单词数:7
```

如果当前是 Mock 模式(没有有效 `DEEPSEEK_API_KEY`),脚本会提示先填 key,
因为 Mock 模式不会启动 runtime,也就不会加载工具插件。

同一个 demo 插件里还有 `guarded_echo`:它在执行前调用 `ctx.approval.request()`
请求人工批准,用于演示 HITL。运行:

```bash
.venv/bin/python -m demos.custom_tool_demo --approval
```

审批桥、浏览器审批条和 API 见 [人工审批(HITL)](human-in-the-loop.md)。

### 2.4 手动挂载 patch(高级)

如果插件已经是一个 npm 包,或者你不想放进自动发现目录,可以写
`agent_platform/dsh-patches/tools.yml`。平台启动时会自动加载它:

```yaml
# 注意:name 不支持 !!js;本地文件要写绝对 file:// URL。
- insert:
    - id: my-tools
      name: 'file:///绝对路径/agent_platform/dsh-plugins/my-tools/index.js'
```

`tools.yml` 含绝对路径,通常只用于本机或已安装到 profile 的 npm 包;需要跨机器共享时,
优先把插件放进自动发现目录,让平台自己生成路径。

生成路径:

```bash
python -c "from pathlib import Path; print(Path('agent_platform/dsh-plugins/my-tools/index.js').resolve().as_uri())"
```

---

## 3. MCP server(接入已有服务最快)

MCP 适合把已有 Python/Node 函数暴露给 agent。平台用
`@deepseek-ai/dsh-mcp-client` 把 MCP tools 桥接成 dsh 工具,模型看到的名称是:

```text
mcp__<serverName>__<toolName>
```

例如 `mcp__mytools__get_weather`。

### 3.1 写一个最小 MCP server

```python
# my_mcp_server.py
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("my-tools")

@mcp.tool()
def get_weather(city: str) -> str:
    """查询城市天气。city 是城市名。"""
    return f"{city}: 25°C"

if __name__ == "__main__":
    mcp.run()  # stdio
```

```bash
.venv/bin/pip install mcp
```

### 3.2 配置 `mcp.yml`

```bash
cp agent_platform/dsh-patches/mcp.example.yml agent_platform/dsh-patches/mcp.yml
```

```yaml
- insert:
    - id: mcp-my-tools
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: mytools
        transport: stdio
        command: /绝对路径/.venv/bin/python
        args: ['/绝对路径/my_mcp_server.py']
        failOnStartupError: true
```

重启 uvicorn 后,模型会看到 `mcp__mytools__get_weather`。如果 MCP server 已经在某个
HTTP 服务里:

```yaml
- insert:
    - id: mcp-my-tools
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: mytools
        transport: streamable-http
        url: http://127.0.0.1:3000/mcp
```

### 3.3 MCP 注意事项

- `failOnStartupError: true` 适合调试;默认是 `false`,server 挂了平台仍会启动,
  只是没有对应工具。
- stdio 子进程的环境会经过 dsh 的 scrub:名字含 `KEY/PASSWORD/SECRET/TOKEN`
  的变量会被删除。凭据要写在 MCP 配置的 `env` 里,并在启动 uvicorn 前 export。
- MCP 只桥接 tools,不桥接 resources/prompts。
- 工具 schema 会进入每次模型请求;server 越多,token 成本越高。

更完整的字段和重连策略见
[配置与原理 · MCP](configuration-and-internals.md#4-mcp)。

---

## 4. 命名 subagent 工具

如果所谓“函数”其实是“让另一个 agent 去做一件事”,用 subagent 工具更合适:

```bash
cp agent_platform/dsh-patches/agents.example.yml agent_platform/dsh-patches/agents.yml
```

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
          你是只读调查员……
```

模型会看到 `researcher` 工具,调用后得到一个子 agent,可用 `list_agents` /
`send_message` 追问。它不是普通函数,适合多轮委派和并行调研。详见
[配置与原理 · 自定义子 agent](configuration-and-internals.md#65-自定义子-agent--主从关系)。

---

## 5. 工具 schema 与执行约定

### 5.1 参数 schema

`parameters` 使用 dsh 支持的 JSON Schema 子集。第一方插件常用简写 DSL:

```js
parameters: {
  city: { type: 'string', required: true, description: '城市名' },
  days: { type: 'integer', description: '预报天数' },
}
```

原始注册也可以直接写标准对象:

```js
parameters: {
  type: 'object',
  properties: {
    city: { type: 'string' },
  },
  required: ['city'],
  additionalProperties: false,
}
```

模型会按 tool schema 生成参数。建议:

- `description` 写清楚“什么时候用”和“不要用它做什么”;
- 必填项一定放进 `required`;
- 对象尽量设置 `additionalProperties: false`,避免模型塞未知字段;
- 不要把巨大枚举或无关 schema 塞进工具,会增加每次请求的 token。

### 5.2 返回值

`execute()` 必须返回 JSON 可序列化的值,并符合 `output.schema`。失败时直接抛错:

```js
if (typeof args.city !== 'string') throw new Error('city 必须是字符串')
```

模型会把错误当成工具结果继续推理。非 JSON 值(函数、Map、Date、BigInt 等)会被
runtime 拒绝。

### 5.3 呈现与 UI

`output.render(args, value)` 返回 content blocks,例如:

```js
render: (_args, value) => [{ type: 'text', text: `结果:${value.answer}` }]
```

前端会把工具调用显示成工具芯片,结果可折叠。`presentCall` / `presentResult` 可以
自定义卡片(参考 dsh 的 `dsh-tool-fs`),当前平台不依赖它们。

### 5.4 native 与 Code Mode

`tools.mode` 默认是 `native`,也就是标准 function calling。可选值:

- `native`:模型直接看到每个工具的 JSON Schema;
- `code`:模型看到 `run_code` 和生成的 SDK,通过代码调用工具;
- `both`:两者都暴露。

如果只想用 function calling,保持默认即可。需要强制时可在 patch 里覆盖:

```yaml
- id: tools
  config:
    mode: native
```

---

## 6. 让模型真正调用工具

工具注册后 schema 会自动进入下一轮请求,但模型不一定知道何时用。建议:

1. 把 `description` 写成面向模型的指令,说明触发条件;
2. 在 `agent_platform/skills/` 里加一个 skill,写清工具职责和使用示例;
3. 或在 `workflows.json` / 平台 prompt 里补充名册说明。

一个最小 skill:

```markdown
---
name: text-stats
description: 需要精确统计文本字符数/单词数时,调用 text_stats 工具。
---

统计文本时不要心算,先把原文传给 text_stats,再解释返回的 characters / words。
```

Skill 会在下一个 step 热加载,工具插件则要重启服务。

---

## 7. 排错

| 现象 | 处理 |
|---|---|
| 模型完全不知道工具 | 重启服务;确认启动日志出现 `本地工具插件:...`;问模型“你有哪些工具” |
| 模型知道工具但不调用 | 强化 `description`,加 skill,或在 prompt 里明确“必须调用” |
| 平台启动后变成 Mock 模式 | 本地插件/`tools.yml` 加载失败会让 runtime 启动失败;看 uvicorn 日志和 `GET /api/config` 的 `startupError` |
| `Cannot find package '@deepseek-ai/dsh-tools'` | 外部插件不要直接 import 未安装的 dsh 包;用原始 `ctx.tools.register`,或把依赖装进插件自己的 `node_modules` |
| MCP 工具不出现 | 检查 `mcp.yml` 是否存在、`serverName` 是否重复、server 是否能启动;调试时设 `failOnStartupError: true` |
| MCP 调用失败但工具在列表里 | server 可能断线重连中,或凭据被环境 scrub 掉了;把 token 放进 MCP 配置的 `env` |
| 工具名冲突 | 同一作用域内工具名必须唯一;给不同插件/插件目录用不同 `name` |
| 前端看不到工具调用 | 工具调用通过 `tool/call` / `tool/result` SSE 事件展示;检查轨迹面板和浏览器网络面板 |

---

## 8. 相关文件

```text
agent_platform/
├── dsh-plugins/
│   ├── assistant-stream-forwarder/   # 流式转发插件
│   ├── approval-bridge/              # approval/request → Web 人工审批
│   └── tools/
│       └── demo-tools/               # text_stats + guarded_echo
├── dsh-patches/
│   ├── tools.yml                     # 可选:手动工具 patch(不存在则跳过)
│   ├── mcp.yml                       # 可选:MCP patch
│   └── agents.yml                    # 可选:subagent patch
└── agent/
    ├── config.py                     # LOCAL_TOOLS_DIR / TOOLS_PATCH
    ├── approvals.py                  # 审批回调 server + pending 表
    └── service.py                    # 自动发现工具、路由审批
demos/
└── custom_tool_demo.py               # text_stats / --approval guarded_echo
tests/
├── test_custom_tools.py              # 插件注册/执行/发现测试
├── test_approvals.py                 # 审批注册表/回调/超时
└── test_approval_bridge.py           # runtime 审批插件测试
```
