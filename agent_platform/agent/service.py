"""AgentService:Web 层与 agent 核心之间的唯一门面。

Web 层只需要:

- ``service.start()`` / ``service.stop()``
- 会话 CRUD 的 dict 视图
- ``service.start_turn(...)`` 返回一个事件队列(``TurnStream``)
- ``service.stop_all()`` / ``service.config()`` / ``service.agents()``

这里不导入任何 FastAPI/Starlette。
"""
from __future__ import annotations

import json
import os
import queue
import threading
import time
import uuid
from functools import partial
from typing import Any, Callable

from deepseek_harness import DeepSeekHarness, DeepSeekHarnessConfig

from agent_platform.workflows import WorkflowSpec, load_workflow

from .config import (
    APPROVAL_BRIDGE_PLUGIN,
    APPROVAL_PATCH_RUNTIME,
    DSH_HOME_DIR,
    LOCAL_TOOLS_PATCH_RUNTIME,
    MCP_PATCH,
    MODEL,
    PROVIDER,
    ROOT,
    SKILLS_DIR,
    SKILLS_PATCH,
    STREAM_FORWARDER,
    STREAM_PATCH_RUNTIME,
    SUBAGENTS_PATCH,
    TOOLS_PATCH,
    WORKFLOWS_FILE,
    WORKSPACE_DIR,
    discover_tool_plugins,
    key_is_placeholder,
    load_env_file,
)
from .approvals import ApprovalCallbackServer, PendingApproval
from .models import Chat
from .runtime import RuntimeManager
from .turns import run_mock_turn, run_real_turn
from .team import run_mock_team_turn, run_team_turn


class AgentError(Exception):
    """agent 域的基类异常,由 Web 层映射成 HTTP 状态码。"""


class ChatNotFound(AgentError):
    pass


class ChatBusy(AgentError):
    pass


class AgentUnavailable(AgentError):
    pass


class ApprovalNotFound(AgentError):
    pass


_STREAM_END: Any = object()


class TurnStream:
    """一轮 turn 的事件队列。

    ``next_event`` 在超时时照常抛 ``queue.Empty``,Web 层据此继续轮询;
    返回 ``None`` 表示本轮已经结束(成功、失败或停止)。
    """

    def __init__(self, events: "queue.Queue[Any]") -> None:
        self._events = events

    def next_event(self, timeout: float = 0.25) -> dict[str, Any] | None:
        item = self._events.get(timeout=timeout)
        if item is _STREAM_END:
            return None
        return item


class AgentService:
    """平台侧 agent 门面:会话表 + runtime + turn 调度。"""

    def __init__(
        self,
        *,
        runtime: RuntimeManager | None = None,
        workflow: WorkflowSpec | None = None,
        approval_enabled: bool | None = None,
        approval_timeout: float | None = None,
    ) -> None:
        self._runtime = runtime or RuntimeManager()
        self.workflow = workflow or load_workflow(WORKFLOWS_FILE)
        self._chats: dict[str, Chat] = {}
        self._chats_lock = threading.Lock()
        self.mock_mode = True
        self.startup_error: str | None = None
        self.streaming_enabled = False
        self._started = False

        if approval_enabled is None:
            approval_enabled = os.environ.get("DSH_APPROVAL_BRIDGE", "1").strip() != "0"
        if approval_timeout is None:
            try:
                approval_timeout = float(
                    os.environ.get("DSH_APPROVAL_TIMEOUT", "120")
                )
            except ValueError:
                approval_timeout = 120.0
        self.approval_enabled = approval_enabled
        self.approval_timeout = max(1.0, approval_timeout)
        self._approval_server: ApprovalCallbackServer | None = None
        self._approvals: dict[str, PendingApproval] = {}
        self._approvals_lock = threading.Lock()
        self._active_turns: dict[str, "queue.Queue[Any]"] = {}

    # -- 生命周期 -----------------------------------------------------------

    def start(self) -> None:
        """准备目录、读取 key、启动共享 runtime;失败则回退 Mock 模式。"""
        if self._started:
            return
        self._started = True

        WORKSPACE_DIR.mkdir(exist_ok=True)
        DSH_HOME_DIR.mkdir(exist_ok=True)
        SKILLS_DIR.mkdir(parents=True, exist_ok=True)

        env = load_env_file(ROOT / ".env")
        api_key = env.get("DEEPSEEK_API_KEY") or os.environ.get("DEEPSEEK_API_KEY")
        self._runtime.reset()

        if key_is_placeholder(api_key):
            self.mock_mode = True
            self.approval_enabled = False
            self._runtime.configure(None)
            print("[agent-platform] Mock 模式:DEEPSEEK_API_KEY 缺失或为占位符")
            return

        self.mock_mode = False
        # skill / MCP / subagent / 本地工具 / streaming 都通过 patch 注入 runtime。
        runtime_patches: list[str] = []
        runtime_env: dict[str, str] = {}
        if SKILLS_PATCH.is_file():
            runtime_patches.append(str(SKILLS_PATCH))
            runtime_env["DSH_SKILLS_DIR"] = str(SKILLS_DIR)
        if MCP_PATCH.is_file():
            runtime_patches.append(str(MCP_PATCH))
        if SUBAGENTS_PATCH.is_file():
            runtime_patches.append(str(SUBAGENTS_PATCH))
        if TOOLS_PATCH.is_file():
            runtime_patches.append(str(TOOLS_PATCH))
        local_plugins = discover_tool_plugins()
        if local_plugins:
            try:
                # name 字段不支持 !!js,所以为本地插件生成绝对 file:// URL patch。
                lines = ["- insert:"]
                for plugin in local_plugins:
                    lines.append(f"    - id: local-tool-{plugin.parent.name}")
                    lines.append(f"      name: {json.dumps(plugin.as_uri())}")
                LOCAL_TOOLS_PATCH_RUNTIME.parent.mkdir(parents=True, exist_ok=True)
                LOCAL_TOOLS_PATCH_RUNTIME.write_text(
                    "\n".join(lines) + "\n", encoding="utf-8"
                )
                runtime_patches.append(str(LOCAL_TOOLS_PATCH_RUNTIME))
                print(
                    "[agent-platform] 本地工具插件:"
                    + ", ".join(plugin.parent.name for plugin in local_plugins)
                )
            except OSError as exc:
                print(f"[agent-platform] 本地工具 patch 生成失败:{exc}")
        streaming_enabled = STREAM_FORWARDER.is_file()
        if streaming_enabled:
            try:
                # name 字段不支持 !!js,所以这里生成一个带绝对 file:// URL 的 patch。
                STREAM_PATCH_RUNTIME.parent.mkdir(parents=True, exist_ok=True)
                STREAM_PATCH_RUNTIME.write_text(
                    "- insert:\n"
                    "    - id: assistant-stream-forwarder\n"
                    f"      name: {json.dumps(STREAM_FORWARDER.as_uri())}\n",
                    encoding="utf-8",
                )
                runtime_patches.append(str(STREAM_PATCH_RUNTIME))
            except OSError as exc:
                streaming_enabled = False
                print(f"[agent-platform] assistant-stream patch 生成失败:{exc}")
        self.streaming_enabled = streaming_enabled
        self._start_approval_bridge(runtime_patches, runtime_env)

        def make_harness() -> DeepSeekHarness:
            return DeepSeekHarness(
                DeepSeekHarnessConfig(
                    provider=PROVIDER,
                    model=MODEL,
                    cwd=str(WORKSPACE_DIR),
                    dsh_home=str(DSH_HOME_DIR),
                    api_key=api_key,
                    base_url=env.get("DEEPSEEK_BASE_URL") or None,
                    patches=tuple(runtime_patches),
                    env=runtime_env,
                )
            )

        self._runtime.configure(make_harness)
        try:
            self._runtime.start()
            print(
                f"[agent-platform] 已启动 harness runtime"
                f"(provider={PROVIDER}, model={MODEL})"
            )
            if SKILLS_PATCH.is_file():
                print(f"[agent-platform] 自定义 skill 目录:{SKILLS_DIR}")
            if streaming_enabled:
                print("[agent-platform] assistant-stream token 转发已启用")
        except Exception as exc:  # noqa: BLE001
            self.mock_mode = True
            self.approval_enabled = False
            self.startup_error = f"{type(exc).__name__}: {exc}"
            self._stop_approval_server()
            print(f"[agent-platform] runtime 启动失败,退回 Mock 模式:{exc}")

    def stop(self) -> None:
        self._started = False
        self._cancel_all_approvals()
        self._stop_approval_server()
        self._runtime.configure(None)
        self._runtime.close()

    def _start_approval_bridge(
        self,
        runtime_patches: list[str],
        runtime_env: dict[str, str],
    ) -> None:
        if not self.approval_enabled:
            return
        if not APPROVAL_BRIDGE_PLUGIN.is_file():
            self.approval_enabled = False
            print("[agent-platform] 未找到 approval-bridge 插件,人工审批已禁用")
            return
        server: ApprovalCallbackServer | None = None
        try:
            server = ApprovalCallbackServer(self._handle_approval_request)
            server.start()
            APPROVAL_PATCH_RUNTIME.parent.mkdir(parents=True, exist_ok=True)
            APPROVAL_PATCH_RUNTIME.write_text(
                "- insert:\n"
                "    - id: approval-bridge\n"
                f"      name: {json.dumps(APPROVAL_BRIDGE_PLUGIN.as_uri())}\n",
                encoding="utf-8",
            )
            runtime_patches.append(str(APPROVAL_PATCH_RUNTIME))
            runtime_env["AGENT_APPROVAL_URL"] = server.url
            runtime_env["AGENT_APPROVAL_TOKEN"] = server.token
            runtime_env["AGENT_APPROVAL_TIMEOUT_MS"] = str(
                int((self.approval_timeout + 10) * 1000)
            )
            runtime_env["AGENT_APPROVAL_TOOLS"] = os.environ.get(
                "DSH_APPROVAL_TOOLS", ""
            )
            self._approval_server = server
            print(
                f"[agent-platform] 人工审批桥已启用"
                f"(timeout={self.approval_timeout:.0f}s)"
            )
        except Exception as exc:  # noqa: BLE001
            if server is not None:
                server.stop()
            self.approval_enabled = False
            print(f"[agent-platform] 人工审批桥启动失败:{exc}")

    def _stop_approval_server(self) -> None:
        server = self._approval_server
        self._approval_server = None
        if server is not None:
            server.stop()

    def _ensure_runtime(self) -> DeepSeekHarness | None:
        if self.mock_mode:
            return None
        harness = self._runtime.ensure()
        if harness is not None:
            self.startup_error = None
        return harness

    # -- 对外状态 -----------------------------------------------------------

    def config(self) -> dict[str, Any]:
        return {
            "mock": self.mock_mode,
            "startupError": self.startup_error or self._runtime.last_error,
            "model": MODEL,
            "provider": PROVIDER,
            "workspace": str(WORKSPACE_DIR),
            "workflow": self.workflow.to_dict(),
            "runtimeAlive": self._runtime.alive,
            "streaming": self.streaming_enabled,
            "approval": {
                "enabled": bool(self.approval_enabled and self._approval_server is not None),
                "timeoutSeconds": self.approval_timeout,
            },
        }

    def agents(self) -> dict[str, Any]:
        """平台侧 agent 名册(不是 dsh 的 list_agents 工具)。"""
        workflow = self.workflow
        return {
            "defaultAgent": {
                "id": "assistant",
                "name": "Assistant",
                "emoji": "💬",
                "role": "平台默认对话 agent,普通对话模式",
                "writes": True,
            },
            "orchestrator": {
                "id": "platform",
                "name": "Platform",
                "emoji": "🛠️",
                "role": "平台编排器(内部 lead 模型负责路由,不计入团队角色)",
                "writes": False,
            },
            "workflow": workflow.to_dict(),
            "counts": {
                "modelAgents": 1 + len(workflow.agents),  # assistant + 团队角色
                "teamAgents": len(workflow.agents),
                "orchestrators": 1,
            },
        }

    # -- 会话 CRUD ----------------------------------------------------------

    def get_or_create_chat(self, chat_id: str) -> Chat:
        with self._chats_lock:
            chat = self._chats.get(chat_id)
            if chat is None:
                chat = Chat(id=chat_id, title="", created_at=time.time())
                self._chats[chat_id] = chat
            return chat

    def create_chat(self, title: str = "") -> dict[str, Any]:
        chat = Chat(
            id=f"chat-{uuid.uuid4().hex[:12]}",
            title=str(title or ""),
            created_at=time.time(),
        )
        with self._chats_lock:
            self._chats[chat.id] = chat
        return chat.summary()

    def list_chats(self) -> list[dict[str, Any]]:
        with self._chats_lock:
            chats = list(self._chats.values())
        return [
            chat.summary()
            for chat in sorted(chats, key=lambda c: c.created_at, reverse=True)
        ]

    def get_chat(self, chat_id: str) -> Chat:
        with self._chats_lock:
            chat = self._chats.get(chat_id)
        if chat is None:
            raise ChatNotFound("chat not found")
        return chat

    def get_chat_detail(self, chat_id: str) -> dict[str, Any]:
        chat = self.get_chat(chat_id)
        payload = chat.summary()
        payload["transcript"] = list(chat.transcript)
        return payload

    def rename_chat(self, chat_id: str, title: str) -> dict[str, Any]:
        """重命名会话;标题只在非空时覆盖,供侧边栏 inline rename 使用。"""
        chat = self.get_chat(chat_id)
        cleaned = str(title or "").strip()[:120]
        if not cleaned:
            raise ValueError("title 不能为空")
        chat.title = cleaned
        return chat.summary()

    def delete_chat(self, chat_id: str) -> None:
        chat = self.get_chat(chat_id)
        if not chat.lock.acquire(blocking=False):
            raise ChatBusy("会话正在运行,无法删除")
        chat.lock.release()
        with self._chats_lock:
            self._chats.pop(chat_id, None)

    # -- turn 生命周期 ------------------------------------------------------

    def stop_all(self) -> bool:
        """停止全部:标记所有会话并硬中断共享 runtime。"""
        with self._chats_lock:
            chats = list(self._chats.values())
        for chat in chats:
            chat.stop_requested = True
        self._cancel_all_approvals()
        return self._runtime.stop_all()

    # -- 人工审批(HITL) ---------------------------------------------------

    def list_approvals(self) -> list[dict[str, Any]]:
        with self._approvals_lock:
            return [approval.to_dict() for approval in self._approvals.values()]

    def resolve_approval(self, approval_id: str, approve: bool) -> str:
        with self._approvals_lock:
            approval = self._approvals.get(approval_id)
        if approval is None:
            raise ApprovalNotFound("approval not found")
        return self._settle_approval(
            approval, "allowed-once" if approve else "rejected"
        )

    def _handle_approval_request(self, payload: dict[str, Any]) -> dict[str, Any]:
        """由回调 server 调用:把审批请求路由到对应 chat 的 SSE 队列并等待。"""
        session_id = str(payload.get("sessionId") or "")
        tool_name = str(payload.get("toolName") or "tool")[:120]
        raw_call_id = payload.get("callId")
        call_id = str(raw_call_id) if raw_call_id else None
        reason = str(payload.get("reason") or "")[:1000]

        chat_id = self._find_chat_for_session(session_id)
        with self._approvals_lock:
            events = self._active_turns.get(chat_id) if chat_id else None
        if events is None:
            print(
                f"[agent-platform] 审批无法路由:session={session_id or '?'} "
                f"tool={tool_name}"
            )
            return {"outcome": "unavailable", "reason": "no active turn"}

        approval = PendingApproval(
            id=f"approval-{uuid.uuid4().hex[:12]}",
            chat_id=chat_id,
            queue=events,
            tool_name=tool_name,
            call_id=call_id,
            reason=reason,
            created_at=time.time(),
        )
        with self._approvals_lock:
            self._approvals[approval.id] = approval
        print(
            f"[agent-platform] 人工审批请求 {approval.id}:"
            f" {tool_name} ({chat_id})"
        )
        events.put(
            {
                "type": "approval_request",
                "approvalId": approval.id,
                "chatId": chat_id,
                "toolName": tool_name,
                "callId": call_id,
                "reason": reason,
                "timeoutSeconds": self.approval_timeout,
            }
        )

        if not approval.event.wait(self.approval_timeout):
            outcome = self._settle_approval(approval, "rejected")
        else:
            outcome = approval.outcome or "rejected"
        with self._approvals_lock:
            self._approvals.pop(approval.id, None)
        return {"outcome": outcome, "id": approval.id}

    def _find_chat_for_session(self, session_id: str) -> str | None:
        if session_id:
            with self._chats_lock:
                chats = list(self._chats.values())
            for chat in chats:
                if (
                    session_id
                    in {
                        chat.runtime_sid,
                        chat.coder_sid,
                        chat.reviewer_sid,
                        chat.lead_sid,
                    }
                    or session_id in chat.agent_sids.values()
                    or session_id in chat.session_ids
                ):
                    return chat.id
        with self._approvals_lock:
            active = list(self._active_turns)
        if len(active) == 1:
            return active[0]
        return None

    def _settle_approval(self, approval: PendingApproval, outcome: str) -> str:
        with self._approvals_lock:
            if approval.outcome is not None:
                return approval.outcome
            approval.outcome = outcome
        approval.event.set()
        approval.queue.put(
            {
                "type": "approval_resolved",
                "approvalId": approval.id,
                "outcome": outcome,
            }
        )
        return outcome

    def _cancel_all_approvals(self) -> None:
        with self._approvals_lock:
            pending = list(self._approvals.values())
        for approval in pending:
            self._settle_approval(approval, "rejected")

    def _close_turn(self, chat_id: str, events: "queue.Queue[Any]") -> None:
        with self._approvals_lock:
            if self._active_turns.get(chat_id) is events:
                self._active_turns.pop(chat_id, None)
            pending = [
                approval
                for approval in self._approvals.values()
                if approval.chat_id == chat_id
            ]
        for approval in pending:
            self._settle_approval(approval, "rejected")

    def start_turn(self, chat_id: str, text: str, *, team: bool = False) -> TurnStream:
        """占用会话并异步执行一轮 turn,返回事件流。

        异常语义:
        - ``ChatBusy``:上一条消息还在处理中;
        - ``AgentUnavailable``:真实模式下 runtime 无法启动;
        - 加锁后会用 ``TurnStream`` 阻塞读取事件。
        """
        chat = self.get_or_create_chat(chat_id)
        if not chat.lock.acquire(blocking=False):
            raise ChatBusy("上一条消息还在处理中")
        chat.stop_requested = False

        harness: DeepSeekHarness | None = None
        if not self.mock_mode:
            harness = self._ensure_runtime()
            if harness is None:
                self._release(chat)
                raise AgentUnavailable("agent runtime 未运行,请查看服务端日志")

        events: "queue.Queue[Any]" = queue.Queue()
        with self._approvals_lock:
            self._active_turns[chat_id] = events
        if self.mock_mode or harness is None:
            run: Callable[[], None] = (
                partial(run_mock_team_turn, text, chat, events, self.workflow)
                if team
                else partial(run_mock_turn, text, chat, events)
            )
        else:
            run = (
                partial(
                    run_team_turn,
                    text,
                    chat,
                    events,
                    harness=harness,
                    workflow=self.workflow,
                )
                if team
                else partial(
                    run_real_turn,
                    text,
                    chat,
                    events,
                    harness=harness,
                    workflow=self.workflow,
                )
            )

        thread = threading.Thread(
            target=self._worker,
            args=(run, chat, events),
            name=f"turn-{chat_id[:8]}",
            daemon=True,
        )
        try:
            thread.start()
        except Exception:
            self._close_turn(chat_id, events)
            self._release(chat)
            raise
        return TurnStream(events)

    def _worker(
        self, run: Callable[[], None], chat: Chat, events: "queue.Queue[Any]"
    ) -> None:
        """运行一轮 turn;所有退出路径都释放会话锁并结束事件流。"""
        try:
            run()
        except BaseException as exc:  # noqa: BLE001
            events.put({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
        finally:
            self._close_turn(chat.id, events)
            self._release(chat)
            events.put(_STREAM_END)

    @staticmethod
    def _release(chat: Chat) -> None:
        try:
            chat.lock.release()
        except RuntimeError:  # pragma: no cover - 并发防御
            pass
