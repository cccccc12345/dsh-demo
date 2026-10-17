"""Agent web 平台后端:FastAPI + SSE,底层走 deepseek-harness SDK。

- 共享一个 DeepSeekHarness runtime 子进程,每个"会话"对应一个 dsh session。
- 每条用户消息在一个工作线程里跑一轮 turn,通知被翻译成 SSE 事件推给浏览器。
- DEEPSEEK_API_KEY 是占位符/缺失时自动进入 Mock 模式(剧本回放,不发模型请求)。
"""
from __future__ import annotations

import asyncio
import json
import os
import queue
import re
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from deepseek_harness import DeepSeekHarness, DeepSeekHarnessConfig, Notification
from deepseek_harness.errors import JsonRpcError, TransportClosedError

from agent_platform.workflows import WorkflowSpec, load_workflow

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_DIR = ROOT / ".dsh-workspace"
DSH_HOME_DIR = ROOT / ".dsh-home"
STATIC_DIR = Path(__file__).resolve().parent / "static"
WORKFLOWS_FILE = ROOT / "workflows.json"
SKILLS_DIR = Path(__file__).resolve().parent / "skills"
SKILLS_PATCH = Path(__file__).resolve().parent / "dsh-patches" / "skills.yml"
MCP_PATCH = Path(__file__).resolve().parent / "dsh-patches" / "mcp.yml"
MCP_EXAMPLE_PATCH = Path(__file__).resolve().parent / "dsh-patches" / "mcp.example.yml"
SUBAGENTS_PATCH = Path(__file__).resolve().parent / "dsh-patches" / "agents.yml"
SUBAGENTS_EXAMPLE_PATCH = (
    Path(__file__).resolve().parent / "dsh-patches" / "agents.example.yml"
)
STREAM_FORWARDER = (
    Path(__file__).resolve().parent
    / "dsh-plugins"
    / "assistant-stream-forwarder"
    / "index.js"
)
STREAM_PATCH_RUNTIME = DSH_HOME_DIR / "patches" / "streaming.yml"

PROVIDER = os.environ.get("DSH_PROVIDER", "deepseek-official")
MODEL = os.environ.get("DSH_MODEL", "deepseek-v4-flash")

_POLL_TIMEOUT = 0.25
_SENTINEL: Any = object()


def load_env_file(path: Path) -> dict[str, str]:
    """解析 KEY=value / export KEY=value 风格的 .env 文件,进程环境变量优先。"""
    values: dict[str, str] = {}
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            line = line.removeprefix("export ").strip()
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
    for key, value in os.environ.items():
        if value:
            values[key] = value
    return values


def key_is_placeholder(api_key: str | None) -> bool:
    """占位 key 判定:缺失,或包含无法放进 HTTP 头的字符(中文/引号/空白等)。"""
    if not api_key:
        return True
    return any(not (c.isascii() and (c.isalnum() or c in "-_.~")) for c in api_key)


@dataclass
class Chat:
    id: str
    title: str
    created_at: float
    transcript: list[dict[str, Any]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)
    # runtime 侧 session id。随机生成,与平台 chat id 解耦:
    # - 同一 server 进程内多轮复用它(runtime 支持同进程续聊)
    # - server 重启后它自然为 None,用全新 runtime 会话,永不与磁盘遗留撞车
    runtime_sid: str | None = None
    # 团队模式的角色会话 id(coder / reviewer 各自独立上下文,可跨轮复用)
    coder_sid: str | None = None
    reviewer_sid: str | None = None
    # 团队 lead(路由/直答)会话;和 coder/reviewer 分开,避免内部 JSON 污染角色上下文
    lead_sid: str | None = None
    # 全局"停止全部"会置位;worker 看到后输出干净的 stopped 结束事件
    stop_requested: bool = False

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title or "新会话",
            "createdAt": int(self.created_at * 1000),
            "messageCount": len(self.transcript),
        }


class _State:
    """全局共享状态:harness、线程池、内存中的会话表。"""

    def __init__(self) -> None:
        self.harness: DeepSeekHarness | None = None
        self.executor: ThreadPoolExecutor | None = None
        self.chats: dict[str, Chat] = {}
        self.chats_lock = threading.Lock()
        self.mock_mode = True
        self.startup_error: str | None = None
        # runtime 意外退出(退出码 0、dev --reload、手动 kill)后用于自动重启。
        self.harness_factory: Callable[[], DeepSeekHarness] | None = None
        self.harness_lock = threading.Lock()
        self.shutting_down = False
        self.streaming_enabled = False
        # 平台侧 agent 名册:用于 prompt 注入和 /api/agents。
        # 不依赖 dsh runtime 的 list_agents(list_agents 只列已派生子代理)。
        self.workflow: WorkflowSpec = load_workflow(WORKFLOWS_FILE)


state = _State()


def _get_or_create_chat(chat_id: str) -> Chat:
    with state.chats_lock:
        chat = state.chats.get(chat_id)
        if chat is None:
            chat = Chat(id=chat_id, title="", created_at=time.time())
            state.chats[chat_id] = chat
        return chat


def _release_chat(chat: Chat) -> None:
    if chat.lock.locked():
        try:
            chat.lock.release()
        except RuntimeError:  # pragma: no cover - 并发防御
            pass


def _harness_alive(harness: DeepSeekHarness | None) -> bool:
    """检查 SDK 持有的 runtime 子进程是否仍存活。

    不额外发 JSON-RPC 请求:进程已退出时直接看 Popen.poll() 即可。
    """
    if harness is None:
        return False
    proc = getattr(getattr(harness, "client", None), "_proc", None)
    return proc is not None and proc.poll() is None


def _stop_all_runtime() -> bool:
    """停止全部:终止共享 runtime,下一次请求由 _ensure_harness 自动重启。

    SDK wire 没有 prompt-cancel 方法,所以"全部停止"用硬中断实现;
    所有 chat 会被标记 stop_requested,worker 收到 TransportClosedError
    后输出干净的 stopped 结束事件而不是错误框。
    """
    with state.chats_lock:
        chats = list(state.chats.values())
    for chat in chats:
        chat.stop_requested = True

    with state.harness_lock:
        harness = state.harness
        state.harness = None
        if harness is None:
            return False
        proc = getattr(getattr(harness, "client", None), "_proc", None)
        if proc is None or proc.poll() is not None:
            return False
        try:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            return True
        except Exception as exc:  # noqa: BLE001
            print(f"[agent-platform] 停止 runtime 失败:{exc}")
            return False


def _ensure_harness() -> DeepSeekHarness | None:
    """runtime 意外退出时自动重启一次;失败返回 None。"""
    if _harness_alive(state.harness):
        return state.harness
    if state.mock_mode or state.shutting_down or state.harness_factory is None:
        return None
    with state.harness_lock:
        if _harness_alive(state.harness):
            return state.harness
        old = state.harness
        state.harness = None
        if old is not None:
            try:
                old.close()
            except Exception:  # noqa: BLE001 - 旧 runtime 已经退出
                pass
        try:
            harness = state.harness_factory()
            harness.start()
            state.harness = harness
            state.startup_error = None
            print("[agent-platform] runtime 已重新启动")
            return harness
        except Exception as exc:  # noqa: BLE001
            state.harness = None
            state.startup_error = f"{type(exc).__name__}: {exc}"
            print(f"[agent-platform] runtime 重启失败:{exc}")
            return None


# ---------------------------------------------------------------------------
# 通知 → 浏览器事件的翻译
# ---------------------------------------------------------------------------

def _message_parts(owner: dict[str, Any]) -> tuple[str, str, list[dict[str, str]]]:
    """从消息对象里提取 (纯文本, 推理文本, 工具块列表)。"""
    content = owner.get("content")
    if isinstance(content, str):
        return content, "", []
    text_parts: list[str] = []
    reasoning_parts: list[str] = []
    tools: list[dict[str, str]] = []
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "text":
                text_parts.append(str(block.get("text") or ""))
            elif block_type == "reasoning":
                reasoning_parts.append(str(block.get("text") or ""))
            else:
                name = block.get("name") or (
                    block_type if isinstance(block_type, str) else "unknown"
                )
                detail = block.get("input") or block.get("command") or block.get("args")
                if isinstance(detail, (dict, list)):
                    detail = json.dumps(detail, ensure_ascii=False)
                tools.append(
                    {"name": str(name), "detail": "" if detail is None else str(detail)[:300]}
                )
    return "".join(text_parts), "".join(reasoning_parts), tools


def _tool_result_text(data: dict[str, Any]) -> tuple[str, bool]:
    """从 tool/result 事件的 message 里提取 (输出文本, isError)。"""
    message = data.get("message")
    owner = message if isinstance(message, dict) else {}
    is_error = False
    parts: list[str] = []
    content = owner.get("content")
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("isError"):
                is_error = True
            result_content = block.get("content")
            if isinstance(result_content, list):
                for part in result_content:
                    if isinstance(part, dict) and part.get("type") == "text":
                        parts.append(str(part.get("text") or ""))
    text = "\n".join(p for p in parts if p)
    if len(text) > 2000:
        text = text[:2000] + " …(截断)"
    return text, is_error


def _inline_json_arguments(raw: Any) -> str | None:
    """tool/call 的 arguments 是 JSON 字符串或对象,统一转紧凑字符串。"""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return raw
    if isinstance(raw, (dict, list)):
        return json.dumps(raw, ensure_ascii=False)
    return None if raw is None else str(raw)


def translate_notification(
    n: Notification, root_sid: str | None = None
) -> dict[str, Any] | None:
    """把 runtime 通知翻译成发给浏览器的精简事件;返回 None 表示忽略。

    root_sid:根会话 id。事件若来自会话树中的**子代理会话**(subagent),
    则在事件上附加 scope="child",前端据此放进子代理渠道而不是主管道。
    """
    item = _translate_one(n)
    if item is None:
        return None
    if (
        root_sid is not None
        and (
            n.method.startswith("subagent.")
            or str(n.payload.get("sessionId") or "") not in ("", root_sid)
        )
    ):
        item["scope"] = "child"
    return item


def _translate_one(n: Notification) -> dict[str, Any] | None:
    if n.method == "agent/assistant-stream":
        frame = n.payload.get("frame")
        if not isinstance(frame, dict):
            return None
        frame_type = frame.get("type")
        stream_id = str(frame.get("attemptId") or "")
        if frame_type == "start":
            return {
                "type": "assistant_stream_start",
                "streamId": stream_id,
                "turn": frame.get("turn"),
                "step": frame.get("step"),
            }
        if frame_type == "chunk":
            chunk = frame.get("chunk")
            if not isinstance(chunk, dict):
                return None
            if chunk.get("type") == "text-delta":
                text = str(chunk.get("text") or "")
                if text:
                    return {
                        "type": "assistant_delta",
                        "streamId": stream_id,
                        "text": text,
                    }
            if chunk.get("type") == "usage":
                usage = chunk.get("usage")
                if isinstance(usage, dict):
                    return {"type": "usage", "streamId": stream_id, "usage": usage}
            return None
        if frame_type == "end":
            return {"type": "assistant_stream_end", "streamId": stream_id}
        return None
    if n.method == "subagent.started":
        return {"type": "agent_spawn", "child": str(n.payload.get("childSessionId") or "")}
    if n.method == "subagent.finished":
        return {
            "type": "agent_done",
            "child": str(n.payload.get("childSessionId") or ""),
            "status": str(n.payload.get("status") or ""),
            "stop": str(n.payload.get("stopReason") or ""),
            "summary": str(n.payload.get("lastAssistantMessage") or "")[:200],
        }
    if n.method != "session.event":
        return None
        return None
    event = n.payload.get("event")
    if not isinstance(event, dict):
        return None
    event_type = event.get("type")
    data = event.get("data") if isinstance(event.get("data"), dict) else {}

    if event_type == "turn/start":
        return {"type": "turn_start", "turn": data.get("turn")}
    if event_type == "step/start":
        return {"type": "step_start", "turn": data.get("turn"), "step": data.get("step")}
    if event_type == "step/end":
        return {"type": "step_end", "turn": data.get("turn"), "step": data.get("step")}
    if event_type == "session/title":
        return {"type": "chat_title", "title": str(data.get("title") or "")}
    if event_type == "tool/call":
        return {
            "type": "tool_call",
            "turn": data.get("turn"),
            "step": data.get("step"),
            "callId": str(data.get("callId") or ""),
            "name": str(data.get("name") or "tool"),
            "detail": _inline_json_arguments(data.get("arguments")) or "",
        }
    if event_type == "tool/result":
        call_id = data.get("callId")
        if not isinstance(call_id, str) or not call_id:
            message = data.get("message")
            source = message.get("source") if isinstance(message, dict) else None
            call_id = source.get("callId") if isinstance(source, dict) else None
        text, is_error = _tool_result_text(data)
        return {
            "type": "tool_result",
            "callId": str(call_id or ""),
            "isError": is_error,
            "text": text,
        }
    if event_type == "assistant/message":
        message = data.get("message")
        owner = message if isinstance(message, dict) else data
        text, reasoning, _tools = _message_parts(owner)
        if text or reasoning:
            return {"type": "message", "text": text, "reasoning": reasoning}
        return None
    if event_type == "turn/end":
        reason = data.get("reason")
        kind = reason.get("kind") if isinstance(reason, dict) else None
        if kind == "error":
            error = reason.get("error") if isinstance(reason, dict) else None
            message = error.get("message") if isinstance(error, dict) else None
            return {"type": "error", "message": str(message or "模型请求失败")}
        return {"type": "turn_end", "reason": kind}
    return None


# ---------------------------------------------------------------------------
# Mock 模式:剧本回放
# ---------------------------------------------------------------------------

_MOCK_NOTE = (
    "\n\n---\n**Mock 模式**未检测到有效的 `DEEPSEEK_API_KEY`(.env 里还是占位符),"
    "以上为本地剧本回放。把真实 key 填入 `.env` 后重启服务,即可切换为真实 agent。"
)


def _run_mock_turn(text: str, chat: Chat, q: "queue.Queue[Any]") -> None:
    chat.transcript.append({"role": "user", "text": text, "ts": time.time()})
    q.put({"type": "user_echo", "text": text})
    time.sleep(0.25)
    q.put({"type": "turn_start", "turn": 1})
    time.sleep(0.25)
    q.put({"type": "step_start", "turn": 1, "step": 1})
    time.sleep(0.3)
    q.put(
        {
            "type": "message",
            "text": "",
            "reasoning": "第一次回复更加通用:分析用户请求并确认是否需要跑真实模型。",
        }
    )
    time.sleep(0.4)
    q.put(
        {
            "type": "tool_call",
            "turn": 1,
            "step": 1,
            "callId": "mock-call-1",
            "name": "bash",
            "detail": json.dumps({"command": "echo mock", "description": "演示工具调用"}),
            "text": "(mock)",
        }
    )
    time.sleep(0.4)
    q.put({"type": "tool_result", "callId": "mock-call-1", "isError": False, "text": "mock"})
    time.sleep(0.3)
    final_text = "pong!\n\n(收到:" + text[:60] + ")" + _MOCK_NOTE
    q.put({"type": "message", "text": final_text, "reasoning": ""})
    q.put({"type": "chat_title", "title": text[:18]})
    if chat.title == "":
        chat.title = text[:18]
    chat.transcript.append({"role": "assistant", "text": final_text, "ts": time.time()})
    q.put({"type": "end", "response": final_text, "finish_reason": "mock"})


# ---------------------------------------------------------------------------
# 真实模式:harness turn
# ---------------------------------------------------------------------------

_REBUILD_MAX_ENTRIES = 12


def _append_system(chat: Chat, text: str) -> None:
    """把系统级备注(错误/空回复提示)写进 transcript,刷新后仍可见。"""
    chat.transcript.append({"role": "system", "text": text, "ts": time.time()})


def _finish_stopped(chat: Chat, q: "queue.Queue[Any]") -> None:
    _append_system(chat, "⏹️ 已停止全部任务")
    q.put({"type": "end", "response": "", "finish_reason": "stopped"})


_TITLE_NOISE = (
    "[平台上下文]",
    "[平台团队上下文]",
    "平台上下文",
    "平台团队上下文",
    "团队名册",
    "当前工作流",
    "你是团队中的",
)


def _clean_title(title: Any, fallback: str) -> str:
    """会话标题兜底:注入的平台上下文不应成为标题。"""
    clean = str(title or "").strip()
    if clean and not any(noise in clean for noise in _TITLE_NOISE):
        return clean
    fallback = " ".join(fallback.split())
    return fallback[:18]


def _on_agent_notification(
    chat: Chat, q: "queue.Queue[Any]", fallback_title: str = ""
) -> Callable[[Notification], None]:
    def on_notification(notification: Notification) -> None:
        item = translate_notification(notification, root_sid=chat.runtime_sid)
        if item is not None:
            if item.get("type") == "chat_title":
                item["title"] = _clean_title(item.get("title"), fallback_title)
            q.put(item)
            if (
                item.get("type") == "chat_title"
                and item.get("scope") != "child"
                and not chat.title
            ):
                chat.title = item["title"]

    return on_notification


def _rebuild_context_prompt(chat: Chat, user_text: str) -> str:
    """runtime 重启后会话失效:把最近对话拼进首条 prompt,尽量延续上下文。"""
    history = [e for e in chat.transcript if e.get("role") in ("user", "assistant")]
    history = history[:-1]  # 排除刚 append 的本轮 user 消息
    sliced = history[-_REBUILD_MAX_ENTRIES:]
    if not sliced:
        return user_text
    lines = [f"{'用户' if e['role'] == 'user' else '助手'}:{e['text']}" for e in sliced]
    return (
        "[系统备注]服务端 runtime 已重启,之前的会话状态不可恢复;已为你新建会话,"
        "并把最近的对话记录附在下方作为背景,请不要重复展示它们。\n\n"
        + "\n\n".join(lines)
        + "\n\n---\n请忽略以上记录的口吻,继续处理用户的最新消息:"
        + user_text
    )


def _platform_prompt(text: str) -> str:
    """普通对话:在用户消息后附平台名册,让模型知道平台还有哪些角色。

    用户原文放在最前面,避免 runtime 的会话标题模型把平台上下文当成主题。
    注入的是平台元信息,不是用户输入;UI 的 user_echo 仍然只回显原始文本。
    """
    return f"{text}\n\n---\n{state.workflow.platform_context()}"


def _team_prompt(agent: str, brief: str, body: str) -> str:
    """团队角色:本轮任务/审查材料在前,角色 brief 和名册在后。"""
    return f"{body}\n\n{brief}\n\n{state.workflow.team_context(agent)}"


def _run_real_turn(text: str, chat: Chat, q: "queue.Queue[Any]") -> None:
    harness = state.harness
    assert harness is not None
    chat.transcript.append({"role": "user", "text": text, "ts": time.time()})
    q.put({"type": "user_echo", "text": text})
    if chat.stop_requested:
        _finish_stopped(chat, q)
        return
    try:
        if chat.runtime_sid is None:
            # 全新随机 runtime session id,绝不与磁盘持久化的旧会话撞车
            session = harness.start_session()
            chat.runtime_sid = session.id
            result = session.run(
                _platform_prompt(text),
                on_notification=_on_agent_notification(chat, q, fallback_title=text),
            )
        else:
            try:
                session = harness.start_session(chat.runtime_sid)
                result = session.run(
                    _platform_prompt(text),
                    on_notification=_on_agent_notification(chat, q, fallback_title=text),
                )
            except JsonRpcError as exc:
                if "already exists" not in str(exc).lower():
                    raise
                # runtime 重启恢复的遗留会话不可续:新开会话 + 注入最近对话
                session = harness.start_session()
                chat.runtime_sid = session.id
                _append_system(
                    chat,
                    "**runtime 会话已失效**(服务重启),已自动新建会话并把最近对话注入为上下文。",
                )
                result = session.run(
                    f"{state.workflow.platform_context()}\n\n---\n"
                    f"{_rebuild_context_prompt(chat, text)}",
                    on_notification=_on_agent_notification(chat, q, fallback_title=text),
                )
        final_response = result.final_response
        if final_response:
            chat.transcript.append(
                {"role": "assistant", "text": final_response, "ts": time.time()}
            )
        else:
            note = f"⚠️ turn 已结束但没有文本回复(finish_reason: {result.finish_reason})"
            _append_system(chat, note)
        q.put(
            {
                "type": "end",
                "response": final_response,
                "finish_reason": result.finish_reason,
            }
        )
    except TransportClosedError:
        if chat.stop_requested:
            _finish_stopped(chat, q)
        else:
            message = "DeepSeek Harness runtime 已退出,请重试"
            _append_system(chat, f"⚠️ {message}")
            q.put({"type": "error", "message": message})
    except Exception as exc:  # noqa: BLE001 - 一切异常都要送到浏览器并留痕
        message = f"{type(exc).__name__}: {exc}"
        _append_system(chat, f"⚠️ {message}")
        q.put({"type": "error", "message": message})


# ---------------------------------------------------------------------------
# 团队模式:coder + reviewer 两个角色 agent,平台侧编排
# ---------------------------------------------------------------------------

_CODER_BRIEF = (
    "你是团队中的 coder(实现工程师)。只在给定的工作目录里写代码与测试,"
    "不要启动 dev server 或任何长驻进程。写完用不超过 150 字总结:"
    "创建/修改了哪些文件、如何验证。"
)
_REVIEWER_BRIEF = (
    "你是团队中严格的 code reviewer。只读代码、不修改任何文件、"
    "不运行超过 5 秒的命令。检查正确性、边界条件、错误处理、可读性。"
    "输出规范:第一行必须是「结论:APPROVE」或「结论:NEEDS_CHANGES」;"
    "随后列问题清单(文件与原因);没有问题则写「无严重问题」。"
)

_INSPECTOR_BRIEF = (
    "你是团队中的 investigator(只读调查员)。只读工作区、运行短命令读取信息,"
    "不修改任何文件,不启动长驻进程。直接回答用户问题,引用文件路径和关键代码;"
    "不要为了回答而写代码文件,也不要输出 review 结论。"
)

_LEAD_BRIEF = (
    "你是平台编排器内部的 lead 模型,负责先理解用户请求,再决定走哪条路径。"
    "你不是团队名册中的第三个角色。\n"
    "路由规则:\n"
    "- answer:解释、问答、能力询问、闲聊、方案讨论,或无需读取工作区即可回答的内容。"
    "直接给出完整、自然的最终回答,不要走代码审查。\n"
    "- inspect:需要读取工作区文件/代码来回答或排查,但不需要修改任何文件。"
    "交给只读调查员;不要启动 reviewer。\n"
    "- coding:需要修改工作区文件、实现功能、修 bug、写/跑测试。"
    "给出简短实现计划,交给 coder;reviewer 会审查。\n"
    "不要为了走流程而把普通问题当成编码任务。\n"
    "你不要调用任何工具;如果必须读文件才能判断,选择 inspect。\n"
    "只输出严格 JSON,不要 markdown 代码块:\n"
    '{"route":"answer"|"inspect"|"coding","plan":"给执行角色的简短计划",'
    '"answer":"给用户的完整回答(route=answer 时)"}'
)


@dataclass(frozen=True)
class LeadDecision:
    route: str  # "answer" | "inspect" | "coding"
    plan: str
    answer: str


def _lead_history(chat: Chat, limit: int = 8, max_chars: int = 500) -> str:
    """给 lead 的最近对话摘要(排除本轮刚 append 的用户消息)。"""
    entries = [e for e in chat.transcript if e.get("role") in ("user", "assistant")][:-1]
    entries = entries[-limit:]
    if not entries:
        return "(无)"
    lines: list[str] = []
    for entry in entries:
        if entry["role"] == "user":
            who = "用户"
        elif entry.get("agent"):
            who = f"助手({entry['agent']})"
        else:
            who = "助手"
        text = " ".join(str(entry.get("text") or "").split())
        lines.append(f"{who}: {text[:max_chars]}")
    return "\n".join(lines)


def _lead_prompt(chat: Chat, text: str) -> str:
    return (
        f"{_LEAD_BRIEF}\n\n"
        f"{state.workflow.team_context('lead')}\n\n"
        "[最近对话]\n"
        f"{_lead_history(chat)}\n\n"
        "[当前请求]\n"
        f"{text}"
    )


def _parse_lead_decision(raw: str) -> LeadDecision | None:
    """解析 lead 的 JSON;容忍代码围栏和前后解释文字。"""
    text = (raw or "").strip()
    if not text:
        return None
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    data: Any = None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        if start >= 0:
            try:
                data, _ = json.JSONDecoder().raw_decode(text[start:])
            except json.JSONDecodeError:
                data = None
    if not isinstance(data, dict):
        return None
    route = str(data.get("route") or "").strip().lower()
    if route not in {"answer", "inspect", "coding"}:
        return None
    plan = str(data.get("plan") or "").strip()
    answer = str(data.get("answer") or "").strip()
    if route == "answer" and not answer:
        return None
    return LeadDecision(route=route, plan=plan, answer=answer)


def _run_lead_decision(
    harness: Any, chat: Chat, text: str
) -> LeadDecision | None:
    """先让 lead 判断请求类型;失败返回 None,由调用方回退旧流程。"""
    prompt = _lead_prompt(chat, text)
    session = harness.start_session(chat.lead_sid) if chat.lead_sid else harness.start_session()
    try:
        result = session.run(prompt)
    except JsonRpcError as exc:
        if "already exists" not in str(exc).lower():
            raise
        session = harness.start_session()
        result = session.run(prompt)
    chat.lead_sid = session.id
    if result.finish_reason == "error" and not result.final_response:
        return None
    return _parse_lead_decision(result.final_response)


def _run_phase(
    harness: Any,
    chat: Chat,
    q: "queue.Queue[Any]",
    agent: str | None,
    session_id: str | None,
    prompt: str,
    fallback_title: str,
) -> tuple[str, Any]:
    """执行一个角色 agent 的一轮 turn,返回 (runtime session id, RunResult)。

    agent 非空时给事件打标签(coder/reviewer),前端据此分渠道渲染;
    agent=None 表示只读调查,事件作为主对话流展示。
    """
    session = harness.start_session(session_id) if session_id else harness.start_session()

    def on_notification(notification: Notification) -> None:
        item = translate_notification(notification, root_sid=session.id)
        if item is not None:
            if item.get("type") == "chat_title":
                item["title"] = _clean_title(item.get("title"), fallback_title)
                if item.get("scope") != "child" and not chat.title:
                    chat.title = item["title"]
            if agent is not None:
                item["agent"] = agent
            q.put(item)

    result = session.run(prompt, on_notification=on_notification)
    if result.finish_reason == "error" and not result.final_response:
        raise RuntimeError(f"{agent or 'investigator'} 阶段失败(turn 以错误结束,且没有文本产出)")
    return session.id, result


def _append_agent(chat: Chat, agent: str, text: str) -> None:
    if text:
        chat.transcript.append(
            {"role": "assistant", "agent": agent, "text": text, "ts": time.time()}
        )


def _review_verdict(review_text: str) -> str:
    upper = review_text.upper()
    if "NEEDS_CHANGES" in upper:
        return "NEEDS_CHANGES"
    return "APPROVE"  # 未明确表态时宽松处理


def _run_team_turn(text: str, chat: Chat, q: "queue.Queue[Any]") -> None:
    harness = state.harness
    assert harness is not None
    chat.transcript.append({"role": "user", "text": text, "ts": time.time()})
    q.put({"type": "user_echo", "text": text})
    if chat.stop_requested:
        _finish_stopped(chat, q)
        return
    try:
        # 先让 lead 判断:普通问题直接回答,只有编码任务才进入 coder/reviewer 流程。
        decision: LeadDecision | None = None
        try:
            decision = _run_lead_decision(harness, chat, text)
        except Exception as exc:  # noqa: BLE001 - 路由失败不应拖垮整轮
            _append_system(
                chat,
                f"⚠️ 团队路由失败,已回退 coder/reviewer:{type(exc).__name__}: {exc}",
            )
            q.put({"type": "reasoning", "text": "团队路由失败,回退 coder/reviewer 流程。"})

        if chat.stop_requested:
            _finish_stopped(chat, q)
            return

        if decision is not None and decision.route == "answer":
            q.put({"type": "reasoning", "text": "团队路由:直接回答(无需写代码/审查)"})
            # 路由调用本身是 JSON,不适合展示;再跑一轮自然语言回答以支持 token 流式。
            answer_prompt = (
                "请直接、自然地回答用户的最新请求。不要输出 JSON,不要提到路由或平台内部判断。"
                "不要调用工具;如果必须读取工作区才能回答,说明这应该走 inspect 路由。\n\n"
                f"用户请求:{text}"
            )
            sid, answer_result = _run_phase(
                harness, chat, q, None, chat.lead_sid, answer_prompt, text
            )
            chat.lead_sid = sid
            if chat.stop_requested:
                _finish_stopped(chat, q)
                return
            answer = answer_result.final_response or decision.answer
            if not chat.title:
                chat.title = " ".join(text.split())[:18]
                q.put({"type": "chat_title", "title": chat.title})
            chat.transcript.append(
                {"role": "assistant", "text": answer, "ts": time.time()}
            )
            q.put(
                {
                    "type": "end",
                    "response": answer,
                    "finish_reason": "team:answer",
                }
            )
            return

        if decision is None:
            plan = ""
            q.put(
                {
                    "type": "reasoning",
                    "text": "团队路由未返回有效结果,回退 coder/reviewer 流程。",
                }
            )
        else:
            plan = decision.plan

        if decision is not None and decision.route == "inspect":
            q.put(
                {
                    "type": "reasoning",
                    "text": "团队路由:只读调查(不修改文件,无需 review)",
                }
            )
            body = f"任务:{text}"
            if plan:
                body += f"\n\nlead 计划:{plan}"
            prompt = _team_prompt("assistant", _INSPECTOR_BRIEF, body)
            sid, inspect_result = _run_phase(
                harness, chat, q, None, chat.coder_sid, prompt, text
            )
            chat.coder_sid = sid
            if chat.stop_requested:
                _finish_stopped(chat, q)
                return
            answer = inspect_result.final_response or "(investigator 未产出文本)"
            if not chat.title:
                chat.title = " ".join(text.split())[:18]
                q.put({"type": "chat_title", "title": chat.title})
            chat.transcript.append(
                {"role": "assistant", "text": answer, "ts": time.time()}
            )
            q.put(
                {
                    "type": "end",
                    "response": answer,
                    "finish_reason": "team:inspect",
                }
            )
            return

        if decision is not None:
            q.put(
                {
                    "type": "reasoning",
                    "text": "团队路由:需要实现" + (f"\n计划:{plan}" if plan else ""),
                }
            )

        max_rounds = state.workflow.max_rounds  # reviewer 打回 coder 的最大修复轮数
        round_no = 0
        coder_report = "(未执行)"
        review_out = "(未执行)"
        verdict = "NEEDS_CHANGES"
        while True:
            if round_no == 0:
                q.put({"type": "phase", "agent": "coder", "stage": "start", "round": 0})
                body = f"任务:{text}"
                if plan:
                    body += f"\n\nlead 计划:{plan}"
                prompt = _team_prompt("coder", _CODER_BRIEF, body)
                sid, coder_result = _run_phase(
                    harness, chat, q, "coder", chat.coder_sid, prompt, text
                )
            else:
                q.put({"type": "phase", "agent": "coder", "stage": "fix", "round": round_no})
                fix_body = (
                    "reviewer 对你的上一版实现提出了反馈,请修复:\n"
                    f"{review_out}\n\n(原任务:{text})\n\n"
                )
                if plan:
                    fix_body += f"lead 计划:{plan}\n\n"
                fix_body += "修复后同样用不超过 150 字总结改动。"
                prompt = _team_prompt("coder", _CODER_BRIEF, fix_body)
                sid, coder_result = _run_phase(
                    harness, chat, q, "coder", chat.coder_sid, prompt, text
                )
            chat.coder_sid = sid
            if chat.stop_requested:
                _finish_stopped(chat, q)
                return
            coder_report = coder_result.final_response or "(coder 未产出文本)"
            _append_agent(chat, "coder", coder_result.final_response or "")

            q.put({"type": "phase", "agent": "reviewer", "stage": "review", "round": round_no})
            review_prompt = _team_prompt(
                "reviewer",
                _REVIEWER_BRIEF,
                f"原任务:{text}\n\ncoder 汇报:{coder_report}\n\n"
                "请根据 coder 实际写入工作区的文件完成审查,按上面的输出规范给出结论。",
            )
            sid, reviewer_result = _run_phase(
                harness, chat, q, "reviewer", chat.reviewer_sid, review_prompt, text
            )
            chat.reviewer_sid = sid
            if chat.stop_requested:
                _finish_stopped(chat, q)
                return
            review_out = reviewer_result.final_response or "(reviewer 未产出文本)"
            verdict = _review_verdict(review_out)
            _append_agent(chat, "reviewer", review_out)
            q.put({"type": "verdict", "verdict": verdict, "round": round_no})

            if verdict == "APPROVE" or round_no >= max_rounds:
                break
            round_no += 1

        summary = (
            f"## 团队任务完成\n\n"
            f"- **coder 汇报:** {coder_report}\n"
            f"- **reviewer 结论:** {verdict}\n"
            f"- 经历 {round_no + 1} 轮审查,最终交付见工作区文件。"
        )
        chat.transcript.append({"role": "assistant", "text": summary, "ts": time.time()})
        q.put({"type": "end", "response": summary, "finish_reason": f"team:{verdict}"})
    except TransportClosedError:
        if chat.stop_requested:
            _finish_stopped(chat, q)
        else:
            message = "DeepSeek Harness runtime 已退出,请重试"
            _append_system(chat, f"⚠️ {message}")
            q.put({"type": "error", "message": message})
    except Exception as exc:  # noqa: BLE001
        message = f"{type(exc).__name__}: {exc}"
        _append_system(chat, f"⚠️ {message}")
        q.put({"type": "error", "message": message})


def _run_mock_team_turn(text: str, chat: Chat, q: "queue.Queue[Any]") -> None:
    chat.transcript.append({"role": "user", "text": text, "ts": time.time()})
    q.put({"type": "user_echo", "text": text})
    time.sleep(0.2)
    q.put({"type": "phase", "agent": "coder", "stage": "start", "round": 0})
    time.sleep(0.4)
    q.put({"type": "tool_call", "turn": 1, "step": 1, "callId": "mock-c1", "name": "write", "detail": '{"file_path": "mock/app.py"}'})
    time.sleep(0.4)
    coder_text = "已编写 `mock/app.py`(mock 模式示例)。"
    q.put({"type": "message", "text": coder_text, "reasoning": "", "agent": "coder"})
    _append_agent(chat, "coder", coder_text)
    time.sleep(0.3)
    q.put({"type": "phase", "agent": "reviewer", "stage": "review", "round": 0})
    time.sleep(0.4)
    review_text = "结论:APPROVE\n无严重问题(mock 模式剧本)。"
    q.put({"type": "message", "text": review_text, "reasoning": "", "agent": "reviewer"})
    _append_agent(chat, "reviewer", review_text)
    q.put({"type": "verdict", "verdict": "APPROVE", "round": 0})
    summary = "## 团队任务完成(mock)\n\n- **coder 汇报:** " + coder_text + "\n- **reviewer 结论:** APPROVE"
    chat.transcript.append({"role": "assistant", "text": summary, "ts": time.time()})
    q.put({"type": "end", "response": summary, "finish_reason": "team:APPROVE"})


# ---------------------------------------------------------------------------
# FastAPI 应用
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(_app: FastAPI):
    WORKSPACE_DIR.mkdir(exist_ok=True)
    DSH_HOME_DIR.mkdir(exist_ok=True)
    SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    env = load_env_file(ROOT / ".env")
    api_key = env.get("DEEPSEEK_API_KEY") or os.environ.get("DEEPSEEK_API_KEY")
    state.executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="harness-worker")
    state.shutting_down = False
    if key_is_placeholder(api_key):
        state.mock_mode = True
        state.harness_factory = None
        print("[agent-platform] Mock 模式:DEEPSEEK_API_KEY 缺失或为占位符")
        yield
        state.shutting_down = True
        state.executor.shutdown(wait=False)
        state.executor = None
        return
    state.mock_mode = False
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
    state.streaming_enabled = streaming_enabled

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

    state.harness_factory = make_harness
    try:
        harness = make_harness()
        harness.start()
        state.harness = harness
        print(f"[agent-platform] 已启动 harness runtime(provider={PROVIDER}, model={MODEL})")
        if SKILLS_PATCH.is_file():
            print(f"[agent-platform] 自定义 skill 目录:{SKILLS_DIR}")
        if streaming_enabled:
            print("[agent-platform] assistant-stream token 转发已启用")
    except Exception as exc:  # noqa: BLE001
        state.harness = None
        state.mock_mode = True
        state.startup_error = f"{type(exc).__name__}: {exc}"
        print(f"[agent-platform] runtime 启动失败,退回 Mock 模式:{exc}")
    yield
    state.shutting_down = True
    state.harness_factory = None
    if state.harness is not None:
        try:
            state.harness.close()
        except Exception:  # noqa: BLE001
            pass
        state.harness = None
    if state.executor is not None:
        state.executor.shutdown(wait=False)
        state.executor = None


app = FastAPI(title="DeepSeek Harness Agent 平台", lifespan=lifespan)


class MessageIn(BaseModel):
    text: str


@app.get("/api/config")
def api_config() -> dict[str, Any]:
    return {
        "mock": state.mock_mode,
        "startupError": state.startup_error,
        "model": MODEL,
        "provider": PROVIDER,
        "workspace": str(WORKSPACE_DIR),
        "workflow": state.workflow.to_dict(),
        "runtimeAlive": _harness_alive(state.harness),
        "streaming": state.streaming_enabled,
    }


@app.get("/api/agents")
def api_list_agents() -> dict[str, Any]:
    """平台侧 agent 名册(不是 dsh 的 list_agents 工具)。"""
    workflow = state.workflow
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


@app.post("/api/stop")
def api_stop_all() -> dict[str, Any]:
    """停止全部:硬中断共享 runtime;下一条消息会自动重启。"""
    stopped = _stop_all_runtime()
    return {
        "ok": True,
        "stopped": stopped,
        "message": "全部任务已停止;下一条消息会自动重启 runtime",
    }


@app.get("/api/chats")
def api_list_chats() -> list[dict[str, Any]]:
    with state.chats_lock:
        chats = list(state.chats.values())
    return [c.summary() for c in sorted(chats, key=lambda c: c.created_at, reverse=True)]


@app.post("/api/chats")
def api_create_chat(body: dict[str, Any] | None = None) -> dict[str, Any]:
    title = (body or {}).get("title") or ""
    chat = _get_or_create_chat(f"chat-{uuid.uuid4().hex[:12]}")
    if title:
        chat.title = str(title)
    return chat.summary()


@app.get("/api/chats/{chat_id}")
def api_get_chat(chat_id: str) -> dict[str, Any]:
    chat = state.chats.get(chat_id)
    if chat is None:
        raise HTTPException(404, "chat not found")
    payload = chat.summary()
    payload["transcript"] = chat.transcript
    return payload


@app.delete("/api/chats/{chat_id}")
def api_delete_chat(chat_id: str) -> dict[str, Any]:
    chat = state.chats.get(chat_id)
    if chat is None:
        raise HTTPException(404, "chat not found")
    if not chat.lock.acquire(blocking=False):
        raise HTTPException(409, "会话正在运行,无法删除")
    _release_chat(chat)
    with state.chats_lock:
        state.chats.pop(chat_id, None)
    return {"ok": True}


def _worker_wrapper(run: Callable[[], None], chat: Chat, q: "queue.Queue[Any]") -> None:
    """运行一轮 turn;负责在所有退出路径上释放会话锁并投递哨兵。"""
    try:
        run()
    except BaseException as exc:  # noqa: BLE001
        _release_chat(chat)
        q.put({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
        q.put(None)
        return
    _release_chat(chat)
    q.put(_SENTINEL)


def _stream_turn(
    chat_id: str,
    text: str,
    real_target: Callable[[str, Chat, "queue.Queue[Any]"], None],
    mock_target: Callable[[str, Chat, "queue.Queue[Any]"], None],
) -> StreamingResponse:
    """普通对话与团队任务共用的入口:锁 → 工作线程 → SSE。"""
    chat = _get_or_create_chat(chat_id)
    if not chat.lock.acquire(blocking=False):
        raise HTTPException(409, "上一条消息还在处理中")
    chat.stop_requested = False

    if not state.mock_mode and _ensure_harness() is None:
        _release_chat(chat)
        raise HTTPException(503, "agent runtime 未运行,请查看服务端日志")

    q: "queue.Queue[Any]" = queue.Queue()
    if state.mock_mode or state.harness is None:
        target: Callable[[], None] = lambda: mock_target(text, chat, q)
    else:
        target = lambda: real_target(text, chat, q)
    threading.Thread(
        target=_worker_wrapper,
        args=(target, chat, q),
        name=f"turn-{chat_id[:8]}",
        daemon=True,
    ).start()

    return StreamingResponse(
        _sse_stream(q),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/chats/{chat_id}/messages")
async def api_send_message(chat_id: str, body: MessageIn) -> StreamingResponse:
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "消息不能为空")
    return _stream_turn(chat_id, text, _run_real_turn, _run_mock_turn)


@app.post("/api/chats/{chat_id}/team")
async def api_team_task(chat_id: str, body: MessageIn) -> StreamingResponse:
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "任务不能为空")
    return _stream_turn(chat_id, text, _run_team_turn, _run_mock_team_turn)


def _sse_stream(q: "queue.Queue[Any]") -> Any:
    """把工作线程队列桥接成 SSE;浏览器断开时排空剩余事件避免阻塞 worker。"""
    loop = asyncio.get_running_loop()
    executor = state.executor

    async def generator():
        while True:
            try:
                item = await loop.run_in_executor(executor, q.get, True, _POLL_TIMEOUT)
            except queue.Empty:
                continue
            if item is _SENTINEL or item is None:
                break
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
        yield 'data: {"type":"done"}\n\n'

    return generator()


@app.get("/static/assets/{filename}")
def static_asset(filename: str) -> Response:
    """静态资源兜底:旧 index.html 引用已删除的 hash 时,让页面自动刷新。

    Vite 构建默认会清空 static/,浏览器若还拿着上一版 index.html,就会请求
    已删除的 index-*.js,表现为整页白屏。这里对缺失的 JS/CSS 返回一个
    刷新脚本/空样式,避免白屏,并让页面重新拿到当前 index。
    """
    assets_dir = (STATIC_DIR / "assets").resolve()
    path = (assets_dir / filename).resolve()
    if assets_dir not in path.parents:
        raise HTTPException(404, "asset not found")
    if path.is_file():
        return FileResponse(path)
    if filename.endswith(".js"):
        return Response(
            "window.location.replace(window.location.pathname + '?reload=' + Date.now());",
            media_type="application/javascript",
            headers={"Cache-Control": "no-store"},
        )
    if filename.endswith(".css"):
        return Response("", media_type="text/css", headers={"Cache-Control": "no-store"})
    raise HTTPException(404, "asset not found")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def index() -> FileResponse:
    # 前端产物带哈希、可长缓存;但 index.html 必须 no-store,
    # 避免浏览器拿着旧哈希引用导致新构建后整页 404 显空白。
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-store"})
