"""团队模式:coder + reviewer 两个角色 agent,由平台侧编排。

lead 先路由:普通问答直接回答、只读调查走 investigator、需要改文件才进入
coder → reviewer 流程。这里只依赖 runtime 与 prompt,不依赖 Web 层。
"""
from __future__ import annotations

import json
import queue
import re
import time
from dataclasses import dataclass
from typing import Any

from deepseek_harness import DeepSeekHarness
from deepseek_harness.errors import JsonRpcError, TransportClosedError

from agent_platform.workflows import WorkflowSpec

from .events import make_notification_handler
from .models import Chat
from .prompts import team_prompt
from .turns import finish_stopped

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


def lead_prompt(chat: Chat, text: str, workflow: WorkflowSpec) -> str:
    return (
        f"{_LEAD_BRIEF}\n\n"
        f"{workflow.team_context('lead')}\n\n"
        "[最近对话]\n"
        f"{_lead_history(chat)}\n\n"
        "[当前请求]\n"
        f"{text}"
    )


def parse_lead_decision(raw: str) -> LeadDecision | None:
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


def run_lead_decision(
    harness: DeepSeekHarness, chat: Chat, text: str, workflow: WorkflowSpec
) -> LeadDecision | None:
    """先让 lead 判断请求类型;失败返回 None,由调用方回退旧流程。"""
    prompt = lead_prompt(chat, text, workflow)
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
    return parse_lead_decision(result.final_response)


def run_phase(
    harness: DeepSeekHarness,
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
    on_notification = make_notification_handler(
        chat,
        q,
        root_sid=session.id,
        fallback_title=fallback_title,
        agent=agent,
    )
    result = session.run(prompt, on_notification=on_notification)
    if result.finish_reason == "error" and not result.final_response:
        raise RuntimeError(f"{agent or 'investigator'} 阶段失败(turn 以错误结束,且没有文本产出)")
    return session.id, result


def review_verdict(review_text: str) -> str:
    upper = review_text.upper()
    if "NEEDS_CHANGES" in upper:
        return "NEEDS_CHANGES"
    return "APPROVE"  # 未明确表态时宽松处理


def run_team_turn(
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
        # 先让 lead 判断:普通问题直接回答,只有编码任务才进入 coder/reviewer 流程。
        decision: LeadDecision | None = None
        try:
            decision = run_lead_decision(harness, chat, text, workflow)
        except Exception as exc:  # noqa: BLE001 - 路由失败不应拖垮整轮
            chat.add_system(
                f"⚠️ 团队路由失败,已回退 coder/reviewer:{type(exc).__name__}: {exc}"
            )
            q.put({"type": "reasoning", "text": "团队路由失败,回退 coder/reviewer 流程。"})

        if chat.stop_requested:
            finish_stopped(chat, q)
            return

        if decision is not None and decision.route == "answer":
            q.put({"type": "reasoning", "text": "团队路由:直接回答(无需写代码/审查)"})
            # 路由调用本身是 JSON,不适合展示;再跑一轮自然语言回答以支持 token 流式。
            answer_prompt = (
                "请直接、自然地回答用户的最新请求。不要输出 JSON,不要提到路由或平台内部判断。"
                "不要调用工具;如果必须读取工作区才能回答,说明这应该走 inspect 路由。\n\n"
                f"用户请求:{text}"
            )
            sid, answer_result = run_phase(
                harness, chat, q, None, chat.lead_sid, answer_prompt, text
            )
            chat.lead_sid = sid
            if chat.stop_requested:
                finish_stopped(chat, q)
                return
            answer = answer_result.final_response or decision.answer
            if not chat.title:
                chat.title = " ".join(text.split())[:18]
                q.put({"type": "chat_title", "title": chat.title})
            chat.add_assistant(answer)
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
            prompt = team_prompt("assistant", _INSPECTOR_BRIEF, body, workflow)
            sid, inspect_result = run_phase(
                harness, chat, q, None, chat.coder_sid, prompt, text
            )
            chat.coder_sid = sid
            if chat.stop_requested:
                finish_stopped(chat, q)
                return
            answer = inspect_result.final_response or "(investigator 未产出文本)"
            if not chat.title:
                chat.title = " ".join(text.split())[:18]
                q.put({"type": "chat_title", "title": chat.title})
            chat.add_assistant(answer)
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

        max_rounds = workflow.max_rounds  # reviewer 打回 coder 的最大修复轮数
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
                prompt = team_prompt("coder", _CODER_BRIEF, body, workflow)
                sid, coder_result = run_phase(
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
                prompt = team_prompt("coder", _CODER_BRIEF, fix_body, workflow)
                sid, coder_result = run_phase(
                    harness, chat, q, "coder", chat.coder_sid, prompt, text
                )
            chat.coder_sid = sid
            if chat.stop_requested:
                finish_stopped(chat, q)
                return
            coder_report = coder_result.final_response or "(coder 未产出文本)"
            chat.add_assistant(coder_result.final_response or "", agent="coder")

            q.put({"type": "phase", "agent": "reviewer", "stage": "review", "round": round_no})
            review_prompt = team_prompt(
                "reviewer",
                _REVIEWER_BRIEF,
                f"原任务:{text}\n\ncoder 汇报:{coder_report}\n\n"
                "请根据 coder 实际写入工作区的文件完成审查,按上面的输出规范给出结论。",
                workflow,
            )
            sid, reviewer_result = run_phase(
                harness, chat, q, "reviewer", chat.reviewer_sid, review_prompt, text
            )
            chat.reviewer_sid = sid
            if chat.stop_requested:
                finish_stopped(chat, q)
                return
            review_out = reviewer_result.final_response or "(reviewer 未产出文本)"
            verdict = review_verdict(review_out)
            chat.add_assistant(review_out, agent="reviewer")
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
        chat.add_assistant(summary)
        q.put({"type": "end", "response": summary, "finish_reason": f"team:{verdict}"})
    except TransportClosedError:
        if chat.stop_requested:
            finish_stopped(chat, q)
        else:
            message = "DeepSeek Harness runtime 已退出,请重试"
            chat.add_system(f"⚠️ {message}")
            q.put({"type": "error", "message": message})
    except Exception as exc:  # noqa: BLE001
        message = f"{type(exc).__name__}: {exc}"
        chat.add_system(f"⚠️ {message}")
        q.put({"type": "error", "message": message})


def run_mock_team_turn(text: str, chat: Chat, q: "queue.Queue[Any]") -> None:
    chat.add_user(text)
    q.put({"type": "user_echo", "text": text})
    time.sleep(0.2)
    q.put({"type": "phase", "agent": "coder", "stage": "start", "round": 0})
    time.sleep(0.4)
    q.put(
        {
            "type": "tool_call",
            "turn": 1,
            "step": 1,
            "callId": "mock-c1",
            "name": "write",
            "detail": '{"file_path": "mock/app.py"}',
        }
    )
    time.sleep(0.4)
    coder_text = "已编写 `mock/app.py`(mock 模式示例)。"
    q.put({"type": "message", "text": coder_text, "reasoning": "", "agent": "coder"})
    chat.add_assistant(coder_text, agent="coder")
    time.sleep(0.3)
    q.put({"type": "phase", "agent": "reviewer", "stage": "review", "round": 0})
    time.sleep(0.4)
    review_text = "结论:APPROVE\n无严重问题(mock 模式剧本)。"
    q.put({"type": "message", "text": review_text, "reasoning": "", "agent": "reviewer"})
    chat.add_assistant(review_text, agent="reviewer")
    q.put({"type": "verdict", "verdict": "APPROVE", "round": 0})
    summary = "## 团队任务完成(mock)\n\n- **coder 汇报:** " + coder_text + "\n- **reviewer 结论:** APPROVE"
    chat.add_assistant(summary)
    q.put({"type": "end", "response": summary, "finish_reason": "team:APPROVE"})
