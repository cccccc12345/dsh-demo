# 人工审批(Human-in-the-loop)

平台现在支持和浏览器/CLI 联动的一次性人工审批:

- agent 执行敏感工具时,可以暂停并请求用户批准;
- 前端弹出审批条,选择「批准一次」或「拒绝」;
- 批准只对当前工具调用生效,超时或无法回答都按拒绝处理;
- 审批过程和结果会出现在轨迹里。

默认开启。设置 `DSH_APPROVAL_BRIDGE=0` 可以关闭。

---

## 1. 架构

```text
工具流水线 / guarded_echo
   │ ctx.approval.request(...)
   ▼
approval-bridge 插件(dsh runtime)
   │ HTTP POST 127.0.0.1:<random>/approval
   ▼
AgentService 审批注册表
   │ SSE: approval_request
   ▼
浏览器审批条
   │ POST /api/approvals/{id} {decision: approve|reject}
   ▼
AgentService 唤醒等待中的请求
   │ HTTP response: allowed-once / rejected
   ▼
approval-bridge 插件把结果交回 dsh
   │
   ▼
工具继续执行,或返回审批失败
```

关键文件:

```text
agent_platform/
├── agent/approvals.py              # pending 表 + 本地回调 HTTP server
├── agent/service.py                # 审批路由/等待/超时/取消
├── dsh-plugins/approval-bridge/    # runtime 侧 approval/request → 平台
└── dsh-plugins/tools/demo-tools/   # guarded_echo 审批示例
agent_platform/webui/src/components/ApprovalBar.tsx
demos/custom_tool_demo.py           # --approval 端到端演示
```

---

## 2. 快速体验

### 2.1 浏览器

正常启动服务:

```bash
.venv/bin/uvicorn agent_platform.main:app --host 127.0.0.1 --port 8765
```

然后问:

```text
请调用 guarded_echo 工具,text 用 "HITL works!",reason 写 "演示人工审批"。
必须调用工具。
```

模型调用 `guarded_echo` 后,输入框上方会出现:

```text
🛡️ 人工审批 · guarded_echo
演示人工审批
[拒绝] [批准一次]
```

- 批准:工具返回 `已批准:HITL works!`,本轮继续。
- 拒绝:工具返回 `Error: 人工审批未通过:rejected`,模型会解释失败。
- 120 秒不处理:自动拒绝。
- 批准/拒绝都会出现在轨迹面板。

### 2.2 CLI demo

```bash
.venv/bin/python -m demos.custom_tool_demo --approval
```

脚本会打印审批请求并在终端询问:

```text
[approval] guarded_echo 请求审批:演示人工审批
批准? [y/N]
```

输入 `y` 或 `n` 即可。审批结果会写回 runtime,脚本继续打印工具结果和最终回复。

---

## 3. 怎么让工具走审批

### 3.1 工具内显式请求

任何原生工具都可以在 `execute()` 里调用 `ctx.approval.request()`。示例见
`agent_platform/dsh-plugins/tools/demo-tools/index.js` 的 `guarded_echo`:

```js
const outcome = await ctx.approval.request({
  agent: exec.agent,
  toolName: 'guarded_echo',
  callId: exec.callId,
  reason: 'guarded_echo 请求人工确认',
  signal: exec.signal,
})
if (outcome !== 'allowed-once') {
  throw new Error(`人工审批未通过:${outcome}`)
}
```

`outcome` 的取值:

| 值 | 含义 |
|---|---|
| `allowed-once` | 用户批准了本次调用 |
| `rejected` | 用户拒绝,或超时 |
| `cancelled` | 调用被取消/中断 |
| `unavailable` | 没有可用审批通道,失败关闭 |

### 3.2 对现有工具强制审批

设置环境变量后,以下工具每次调用都会先请求审批:

```bash
export DSH_APPROVAL_TOOLS="bash,write,edit"
.venv/bin/uvicorn agent_platform.main:app --host 127.0.0.1 --port 8765
```

支持逗号分隔的多个工具名;留空(默认)表示不额外拦截。
实现方式是在 `approval-bridge` 插件里监听 `tools/pre-execute`,对被点名的工具返回
`{ kind: 'ask', reason: ... }`,dsh 会自动把请求交给 `ctx.approval`。

注意:这会显著改变使用体验,建议只在需要严格审批的环境开启,并配合前端审批条使用。

---

## 4. 配置

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `DSH_APPROVAL_BRIDGE` | `1` | `0` 关闭审批桥,回到 dsh 默认的 fail-closed(直接拒绝) |
| `DSH_APPROVAL_TIMEOUT` | `120` | 等待人工决定的秒数,超时自动拒绝 |
| `DSH_APPROVAL_TOOLS` | 空 | 逗号分隔的工具名,强制每次调用都审批 |
| `AGENT_APPROVAL_URL` | 平台注入 | runtime 插件回调地址,仅本机 |
| `AGENT_APPROVAL_TOKEN` | 平台注入 | 回调鉴权 token |
| `AGENT_APPROVAL_TIMEOUT_MS` | 平台注入 | 插件侧 fetch 超时,略大于后端超时 |
| `AGENT_APPROVAL_TOOLS` | 平台注入 | 由 `DSH_APPROVAL_TOOLS` 映射 |

> 纯 API / CI 场景没有浏览器审批条,建议设置 `DSH_APPROVAL_BRIDGE=0`;否则需要审批的
> 调用会一直等到超时再被拒绝。也可以让客户端读取 SSE 并调用 `/api/approvals`。

`GET /api/config` 会返回:

```json
{
  "approval": {
    "enabled": true,
    "timeoutSeconds": 120
  }
}
```

启动日志里会出现:

```text
[agent-platform] 人工审批桥已启用(timeout=120s)
```

生成的 runtime patch 在 `$DSH_HOME/patches/approval-bridge.yml`。

---

## 5. API 契约

### 5.1 SSE 事件

审批请求会进入当前 turn 的事件流:

```json
{
  "type": "approval_request",
  "approvalId": "approval-xxxxxxxx",
  "chatId": "chat-xxxxxxxx",
  "toolName": "guarded_echo",
  "callId": "call-1",
  "reason": "演示人工审批",
  "timeoutSeconds": 120
}
```

用户决定或超时后:

```json
{
  "type": "approval_resolved",
  "approvalId": "approval-xxxxxxxx",
  "outcome": "allowed-once"
}
```

### 5.2 HTTP

```text
GET  /api/approvals
POST /api/approvals/{approvalId}
     {"decision": "approve" | "reject"}
```

POST 返回:

```json
{"ok": true, "id": "approval-xxxxxxxx", "outcome": "allowed-once"}
```

未知/已过期的审批返回 404;非法 decision 返回 400。

---

## 6. 行为和边界

- **一次性授权**:只有 `allowed-once`,没有“始终允许/记住规则/撤销”。
- **审批请求不带完整参数**:dsh 只提供 `toolName`、`callId`、`reason`。前端可以用
  `callId` 关联已经流出的 `tool/call` 事件来展示参数。
- **必须发生在未结束的 turn 内**:dsh 的审批审计事件要求 turn 打开;空闲时不能审批。
- **超时/失败关闭**:浏览器不在、用户不处理、回调失败,都会拒绝,不会默认放行。
- **停止全部会取消 pending 审批**:被中断的审批按拒绝返回,不影响下一条消息重启 runtime。
- **多会话路由**:按 runtime session id 找到 chat;subagent 子会话通过通知里见过的
  session id 关联。无法确定 chat 时返回 `unavailable` 并拒绝。
- **本地回调安全**:回调 server 只绑定 `127.0.0.1`,随机端口 + 随机 token,不暴露公网。
- **前后端只走本机 HTTP**:审批桥不适合跨机器部署;如果 web 和 runtime 分离部署,
  需要把回调改成受保护的内网服务或消息队列。

### 排错

| 现象 | 处理 |
|---|---|
| 启动日志没有 `人工审批桥已启用` | 检查 `approval-bridge/index.js` 是否存在、`DSH_APPROVAL_BRIDGE` 是否为 `0` |
| 审批请求出现但前端没有审批条 | 浏览器 SSE 连接是否还在;换页/刷新会丢失当前 turn 的事件流 |
| 审批总是超时被拒绝 | 没有浏览器连接、用户未处理,或 `DSH_APPROVAL_TIMEOUT` 太短 |
| `POST /api/approvals/{id}` 返回 404 | 审批已超时/已处理,或 id 不对 |
| 设置了 `DSH_APPROVAL_TOOLS` 但工具没被拦 | 工具名必须和模型看到的 name 完全一致(如 `bash`),并重启 uvicorn |
| `guarded_echo` 不在工具列表 | 本地工具插件没加载;确认启动日志出现 `本地工具插件:demo-tools` |

---

## 7. 测试

```bash
.venv/bin/python -m unittest tests.test_approvals -v       # 审批注册表/回调/超时
.venv/bin/python -m unittest tests.test_approval_bridge -v # runtime 插件转发
.venv/bin/python -m unittest tests.test_custom_tools -v    # guarded_echo 逻辑
```

已验证的真实链路:

```text
tool_call guarded_echo
→ approval_request
→ POST /api/approvals/{id} approve
→ approval_resolved allowed-once
→ tool_result 已批准:HITL works!
→ end completed
```

拒绝链路同样返回 `isError=true`,模型会解释审批未通过。
