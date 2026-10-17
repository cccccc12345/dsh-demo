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
    DSH_HOME_DIR,
    MCP_PATCH,
    MODEL,
    PROVIDER,
    ROOT,
    SKILLS_DIR,
    SKILLS_PATCH,
    STREAM_FORWARDER,
    STREAM_PATCH_RUNTIME,
    SUBAGENTS_PATCH,
    WORKFLOWS_FILE,
    WORKSPACE_DIR,
    key_is_placeholder,
    load_env_file,
)
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
    ) -> None:
        self._runtime = runtime or RuntimeManager()
        self.workflow = workflow or load_workflow(WORKFLOWS_FILE)
        self._chats: dict[str, Chat] = {}
        self._chats_lock = threading.Lock()
        self.mock_mode = True
        self.startup_error: str | None = None
        self.streaming_enabled = False
        self._started = False

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
            self._runtime.configure(None)
            print("[agent-platform] Mock 模式:DEEPSEEK_API_KEY 缺失或为占位符")
            return

        self.mock_mode = False
        # 自定义 skill 根 + assistant-stream 转发插件都通过 patch 注入 runtime。
        runtime_patches: list[str] = []
        runtime_env: dict[str, str] = {}
        if SKILLS_PATCH.is_file():
            runtime_patches.append(str(SKILLS_PATCH))
            runtime_env["DSH_SKILLS_DIR"] = str(SKILLS_DIR)
        if MCP_PATCH.is_file():
            runtime_patches.append(str(MCP_PATCH))
        if SUBAGENTS_PATCH.is_file():
            runtime_patches.append(str(SUBAGENTS_PATCH))
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
            self.startup_error = f"{type(exc).__name__}: {exc}"
            print(f"[agent-platform] runtime 启动失败,退回 Mock 模式:{exc}")

    def stop(self) -> None:
        self._started = False
        self._runtime.configure(None)
        self._runtime.close()

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
        return self._runtime.stop_all()

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
        if self.mock_mode or harness is None:
            run: Callable[[], None] = (
                partial(run_mock_team_turn, text, chat, events)
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

        threading.Thread(
            target=self._worker,
            args=(run, chat, events),
            name=f"turn-{chat_id[:8]}",
            daemon=True,
        ).start()
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
            self._release(chat)
            events.put(_STREAM_END)

    @staticmethod
    def _release(chat: Chat) -> None:
        try:
            chat.lock.release()
        except RuntimeError:  # pragma: no cover - 并发防御
            pass
