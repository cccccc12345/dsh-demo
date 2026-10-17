"""runtime 通知 → 前端事件 的翻译层。

只处理普通 dict/JSON,不依赖 FastAPI;Web 层负责把事件编码成 SSE。
"""
from __future__ import annotations

import json
import queue
from typing import Any, Callable

from deepseek_harness import Notification

from .models import Chat
from .prompts import clean_title


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
                    {
                        "name": str(name),
                        "detail": "" if detail is None else str(detail)[:300],
                    }
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


def make_notification_handler(
    chat: Chat,
    q: "queue.Queue[Any]",
    *,
    root_sid: str,
    fallback_title: str = "",
    agent: str | None = None,
) -> Callable[[Notification], None]:
    """构造单个 turn 的通知回调:翻译、修标题、按需打 agent 标签后入队。"""

    def on_notification(notification: Notification) -> None:
        item = translate_notification(notification, root_sid=root_sid)
        if item is None:
            return
        if item.get("type") == "chat_title":
            item["title"] = clean_title(item.get("title"), fallback_title)
            if item.get("scope") != "child" and not chat.title:
                chat.title = item["title"]
        if agent is not None:
            item["agent"] = agent
        q.put(item)

    return on_notification
