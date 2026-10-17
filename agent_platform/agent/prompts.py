"""平台注入 prompt 的拼接逻辑(纯文本,无运行时依赖)。"""
from __future__ import annotations

from agent_platform.workflows import WorkflowSpec

from .models import Chat

_TITLE_NOISE = (
    "[平台上下文]",
    "[平台团队上下文]",
    "平台上下文",
    "平台团队上下文",
    "团队名册",
    "当前工作流",
    "你是团队中的",
)

_REBUILD_MAX_ENTRIES = 12


def clean_title(title: object, fallback: str) -> str:
    """会话标题兜底:注入的平台上下文不应成为标题。"""
    clean = str(title or "").strip()
    if clean and not any(noise in clean for noise in _TITLE_NOISE):
        return clean
    fallback = " ".join(fallback.split())
    return fallback[:18]


def rebuild_context_prompt(chat: Chat, user_text: str) -> str:
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


def platform_prompt(text: str, workflow: WorkflowSpec) -> str:
    """普通对话:在用户消息后附平台名册,让模型知道平台还有哪些角色。

    用户原文放在最前面,避免 runtime 的会话标题模型把平台上下文当成主题。
    注入的是平台元信息,不是用户输入;UI 的 user_echo 仍然只回显原始文本。
    """
    return f"{text}\n\n---\n{workflow.platform_context()}"


def team_prompt(
    agent: str, brief: str, body: str, workflow: WorkflowSpec
) -> str:
    """团队角色:本轮任务/审查材料在前,角色 brief 和名册在后。"""
    return f"{body}\n\n{brief}\n\n{workflow.team_context(agent)}"
