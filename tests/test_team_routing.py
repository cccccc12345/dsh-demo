from __future__ import annotations

import queue
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from agent_platform.main import Chat, LeadDecision, _run_team_turn, state


def drain(q: queue.Queue) -> list[dict]:
    events: list[dict] = []
    while True:
        try:
            events.append(q.get_nowait())
        except queue.Empty:
            return events


class TeamRoutingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.previous_harness = state.harness
        # direct-answer / mocked-phase paths never touch the runtime object.
        state.harness = object()  # type: ignore[assignment]

    def tearDown(self) -> None:
        state.harness = self.previous_harness

    def test_general_question_skips_coder_and_reviewer(self) -> None:
        chat = Chat(id="chat-test", title="", created_at=time.time())
        q: queue.Queue = queue.Queue()
        answer_result = SimpleNamespace(final_response="直接回答", finish_reason="completed")
        with (
            patch(
                "agent_platform.main._run_lead_decision",
                return_value=LeadDecision(route="answer", plan="", answer="直接回答"),
            ),
            patch("agent_platform.main._run_phase") as run_phase,
        ):
            run_phase.return_value = ("answer-sid", answer_result)
            _run_team_turn("你有哪些 agent?", chat, q)

        self.assertIsNone(run_phase.call_args.args[3])  # agent=None => 主流式
        events = drain(q)
        self.assertNotIn("phase", [event.get("type") for event in events])
        self.assertEqual(events[-1]["finish_reason"], "team:answer")
        self.assertEqual(events[-1]["response"], "直接回答")
        self.assertEqual(chat.transcript[-1]["text"], "直接回答")

    def test_inspect_route_skips_reviewer(self) -> None:
        chat = Chat(id="chat-test", title="", created_at=time.time())
        q: queue.Queue = queue.Queue()
        inspect_result = SimpleNamespace(
            final_response="文件里实现了四则运算", finish_reason="completed"
        )
        with (
            patch(
                "agent_platform.main._run_lead_decision",
                return_value=LeadDecision(route="inspect", plan="读文件", answer=""),
            ),
            patch("agent_platform.main._run_phase") as run_phase,
        ):
            run_phase.return_value = ("inspector-sid", inspect_result)
            _run_team_turn("解释 simple_calculator.py", chat, q)

        self.assertIsNone(run_phase.call_args.args[3])  # agent=None => 主对话流
        events = drain(q)
        self.assertNotIn("phase", [event.get("type") for event in events])
        self.assertEqual(events[-1]["finish_reason"], "team:inspect")
        self.assertEqual(chat.transcript[-1]["text"], "文件里实现了四则运算")

    def test_coding_route_passes_plan_to_coder(self) -> None:
        chat = Chat(id="chat-test", title="", created_at=time.time())
        q: queue.Queue = queue.Queue()
        coder_result = SimpleNamespace(final_response="coder 完成", finish_reason="completed")
        reviewer_result = SimpleNamespace(
            final_response="结论:APPROVE\n无严重问题", finish_reason="completed"
        )
        with (
            patch(
                "agent_platform.main._run_lead_decision",
                return_value=LeadDecision(route="coding", plan="先读文件再实现", answer=""),
            ),
            patch("agent_platform.main._run_phase") as run_phase,
        ):
            run_phase.side_effect = [("coder-sid", coder_result), ("reviewer-sid", reviewer_result)]
            _run_team_turn("实现一个功能", chat, q)

        coder_prompt = run_phase.call_args_list[0].args[5]
        self.assertIn("lead 计划:先读文件再实现", coder_prompt)
        events = drain(q)
        self.assertIn(("coder", "start"), [(e.get("agent"), e.get("stage")) for e in events if e.get("type") == "phase"])
        self.assertIn(("reviewer", "review"), [(e.get("agent"), e.get("stage")) for e in events if e.get("type") == "phase"])
        self.assertEqual(events[-1]["finish_reason"], "team:APPROVE")


if __name__ == "__main__":
    unittest.main()
