"""普通对话 turn:Mock 剧本回放 + 真实 harness turn。"""
from __future__ import annotations

import json
import queue
import time
from typing import Any

from deepseek_harness import DeepSeekHarness
from deepseek_harness.errors import JsonRpcError, TransportClosedError

from agent_platform.workflows import WorkflowSpec

from .events import make_notification_handler
from .models import Chat
from .prompts import platform_prompt, rebuild_context_prompt

_MOCK_NOTE = (
    "\n\n---\n**Mock 模式**未检测到有效的 `DEEPSEEK_API_KEY`(.env 里还是占位符),"
    "以上为本地剧本回放。把真实 key 填入 `.env` 后重启服务,即可切换为真实 agent。"
)


def finish_stopped(chat: Chat, q: "queue.Queue[Any]") -> None:
    chat.add_system("⏹️ 已停止全部任务")
    q.put({"type": "end", "response": "", "finish_reason": "stopped"})


def run_mock_turn(text: str, chat: Chat, q: "queue.Queue[Any]") -> None:
    chat.add_user(text)
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
    chat.add_assistant(final_text)
    q.put({"type": "end", "response": final_text, "finish_reason": "mock"})


def run_real_turn(
    text: str,
    chat: Chat,
    q: "queue.Queue[Any]",
    *,
    harness: DeepSeekHarness,
    workflow: WorkflowSpec,
) -> None:
    chat.add_user(text)
    q.put({"type": "user_echo", "text": text})
    if chat.stop_requested:
        finish_stopped(chat, q)
        return
    try:
        if chat.runtime_sid is None:
            # 全新随机 runtime session id,绝不与磁盘持久化的旧会话撞车
            session = harness.start_session()
            chat.runtime_sid = session.id
            result = session.run(
                platform_prompt(text, workflow),
                on_notification=make_notification_handler(
                    chat, q, root_sid=session.id, fallback_title=text
                ),
            )
        else:
            try:
                session = harness.start_session(chat.runtime_sid)
                result = session.run(
                    platform_prompt(text, workflow),
                    on_notification=make_notification_handler(
                        chat, q, root_sid=session.id, fallback_title=text
                    ),
                )
            except JsonRpcError as exc:
                if "already exists" not in str(exc).lower():
                    raise
                # runtime 重启恢复的遗留会话不可续:新开会话 + 注入最近对话
                session = harness.start_session()
                chat.runtime_sid = session.id
                chat.add_system(
                    "**runtime 会话已失效**(服务重启),已自动新建会话并把最近对话注入为上下文。"
                )
                result = session.run(
                    f"{workflow.platform_context()}\n\n---\n"
                    f"{rebuild_context_prompt(chat, text)}",
                    on_notification=make_notification_handler(
                        chat, q, root_sid=session.id, fallback_title=text
                    ),
                )
        final_response = result.final_response
        if final_response:
            chat.add_assistant(final_response)
        else:
            note = f"⚠️ turn 已结束但没有文本回复(finish_reason: {result.finish_reason})"
            chat.add_system(note)
        q.put(
            {
                "type": "end",
                "response": final_response,
                "finish_reason": result.finish_reason,
            }
        )
    except TransportClosedError:
        if chat.stop_requested:
            finish_stopped(chat, q)
        else:
            message = "DeepSeek Harness runtime 已退出,请重试"
            chat.add_system(f"⚠️ {message}")
            q.put({"type": "error", "message": message})
    except Exception as exc:  # noqa: BLE001 - 一切异常都要送到浏览器并留痕
        message = f"{type(exc).__name__}: {exc}"
        chat.add_system(f"⚠️ {message}")
        q.put({"type": "error", "message": message})
