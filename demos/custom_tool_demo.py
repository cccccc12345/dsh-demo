"""端到端演示:让模型调用本地原生工具 ``text_stats``。

用法(在仓库根目录):

    .venv/bin/python -m demos.custom_tool_demo

需要 `.env` 里有真实的 ``DEEPSEEK_API_KEY``;Mock 模式不会启动 runtime,
也就看不到工具调用。
"""
from __future__ import annotations

import queue
import sys
from pathlib import Path

# 支持 `python demos/custom_tool_demo.py` 直接运行。
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agent_platform.agent.service import AgentService

PROMPT = (
    "请调用 text_stats 工具统计下面这段话的字符数和单词数。"
    "必须使用工具,不要自己计算:\n\n"
    "DeepSeek Harness 的 function calling demo 很好用!"
)

APPROVAL_PROMPT = (
    "请调用 guarded_echo 工具,text 使用 'HITL works!',"
    "reason 写 '演示人工审批'。必须调用工具,不要直接回答。"
)


def main() -> int:
    approval_mode = "--approval" in sys.argv[1:]
    service = AgentService()
    service.start()
    saw_tool = False
    try:
        if service.mock_mode:
            print("当前是 Mock 模式,不会启动 runtime,也就没有本地工具。")
            if service.startup_error:
                print(f"runtime 启动错误:{service.startup_error}")
            print("请在 .env 填入真实 DEEPSEEK_API_KEY 后重试。")
            return 1

        if approval_mode:
            print("HITL 审批 demo:模型调用 guarded_echo 后,这里会请求你批准。")
        print("runtime 已启动,发送 demo 请求……")
        stream = service.start_turn(
            "demo-custom-tool", APPROVAL_PROMPT if approval_mode else PROMPT
        )
        while True:
            try:
                event = stream.next_event(timeout=60)
            except queue.Empty:
                continue
            if event is None:
                break
            kind = event.get("type")
            if kind == "tool_call":
                saw_tool = True
                print(f"\n[tool_call] {event.get('name')} {event.get('detail') or ''}")
            elif kind == "tool_result":
                print(
                    f"[tool_result] isError={event.get('isError')} "
                    f"{event.get('text') or ''}"
                )
            elif kind == "approval_request":
                approval_id = str(event.get("approvalId") or "")
                print(
                    f"\n[approval] {event.get('toolName')} 请求审批:"
                    f"{event.get('reason') or '(无原因)'}"
                )
                try:
                    answer = input("批准? [y/N] ").strip().lower()
                except EOFError:
                    answer = "n"
                decision = "approve" if answer in {"y", "yes"} else "reject"
                try:
                    outcome = service.resolve_approval(
                        approval_id, decision == "approve"
                    )
                    print(f"[approval] 已提交:{outcome}")
                except Exception as exc:  # noqa: BLE001
                    print(f"[approval] 提交失败:{type(exc).__name__}: {exc}")
            elif kind == "approval_resolved":
                print(f"[approval] 结果:{event.get('outcome')}")
            elif kind == "error":
                print(f"\n[error] {event.get('message')}")
            elif kind == "end":
                print(f"\n[final]\n{event.get('response') or '(无文本)'}")
                print(f"[finish_reason] {event.get('finish_reason')}")

        if not saw_tool:
            print(
                "\n模型这次没有调用工具。可以再问一次,"
                "或检查 runtime 日志里是否成功加载了本地工具插件。"
            )
            return 2
        return 0
    except KeyboardInterrupt:
        return 130
    finally:
        service.stop()


if __name__ == "__main__":
    raise SystemExit(main())
