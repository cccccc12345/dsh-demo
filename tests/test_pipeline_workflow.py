from __future__ import annotations

import json
import queue
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from agent_platform.agent.models import Chat
from agent_platform.agent.team import (
    pipeline_stage_prompt,
    run_mock_team_turn,
    run_team_turn,
)
from agent_platform.workflows import load_workflow

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = load_workflow(ROOT / "workflows.json")


def drain(q: queue.Queue) -> list[dict]:
    events: list[dict] = []
    while True:
        try:
            events.append(q.get_nowait())
        except queue.Empty:
            return events


class RepoWorkflowTest(unittest.TestCase):
    def test_repo_workflow_is_four_stage_pipeline(self) -> None:
        self.assertTrue(WORKFLOW.is_pipeline)
        self.assertEqual(
            [agent.id for agent in WORKFLOW.agents],
            ["data-analysis", "testcase-table", "testcase-dedup", "test-code"],
        )
        self.assertEqual(
            [agent.name for agent in WORKFLOW.agents],
            ["数据分析", "测试用例表格生成", "用例去重", "测试代码生成"],
        )
        self.assertTrue(all(agent.brief for agent in WORKFLOW.agents))
        self.assertEqual(WORKFLOW.to_dict()["type"], "pipeline")


class PipelineTurnTest(unittest.TestCase):
    def _run(self, outputs: list[str]) -> tuple[Chat, queue.Queue, list[dict], list]:
        chat = Chat(id="chat-pipeline", title="", created_at=0)
        q: queue.Queue = queue.Queue()
        side_effect = [
            (f"{agent.id}-sid", SimpleNamespace(final_response=output, finish_reason="completed"))
            for agent, output in zip(WORKFLOW.agents, outputs)
        ]
        with (
            patch("agent_platform.agent.team.run_phase") as run_phase,
            patch("agent_platform.agent.team.run_lead_decision") as run_lead,
        ):
            run_phase.side_effect = side_effect
            run_team_turn(
                "为登录接口生成测试",
                chat,
                q,
                harness=object(),
                workflow=WORKFLOW,
            )
        run_lead.assert_not_called()
        return chat, q, drain(q), list(run_phase.call_args_list)

    def test_agents_run_in_order_and_outputs_are_passed_downstream(self) -> None:
        chat, _q, events, calls = self._run(
            ["分析完成", "生成 12 条用例", "去重后 9 条", "测试通过"]
        )

        phases = [event for event in events if event.get("type") == "phase"]
        self.assertEqual(
            [(event["agent"], event["stage"]) for event in phases],
            [
                (agent.id, stage)
                for agent in WORKFLOW.agents
                for stage in ("start", "done")
            ],
        )
        self.assertTrue(all(event["total"] == 4 for event in phases))

        self.assertEqual(len(calls), 4)
        self.assertEqual(
            [call.args[3] for call in calls],
            [agent.id for agent in WORKFLOW.agents],
        )
        self.assertIn("流水线起点", calls[0].args[5])
        self.assertIn("分析完成", calls[1].args[5])
        self.assertIn("生成 12 条用例", calls[2].args[5])
        self.assertIn("去重后 9 条", calls[3].args[5])
        self.assertIn("test-artifacts/03-test-cases-final.csv", calls[3].args[5])

        previous = None
        for index, agent in enumerate(WORKFLOW.agents, start=1):
            prompt = pipeline_stage_prompt(
                WORKFLOW, agent, index, len(WORKFLOW.agents), "为登录接口生成测试", previous
            )
            if previous is None:
                self.assertIn("流水线起点", prompt)
            else:
                self.assertIn(previous[1], prompt)
                self.assertIn("上游产物文件", prompt)
            self.assertIn(f"第 {index}/4 阶段", prompt)
            previous = (agent, f"阶段{index}结论")

        self.assertEqual(events[-1]["finish_reason"], "workflow:completed")
        self.assertIn(WORKFLOW.name, events[-1]["response"])
        self.assertIn("测试通过", events[-1]["response"])
        self.assertEqual(
            [entry.get("agent") for entry in chat.transcript if entry["role"] == "assistant"],
            [*[agent.id for agent in WORKFLOW.agents], None],
        )
        self.assertEqual(
            chat.agent_sids,
            {
                "data-analysis": "data-analysis-sid",
                "testcase-table": "testcase-table-sid",
                "testcase-dedup": "testcase-dedup-sid",
                "test-code": "test-code-sid",
            },
        )

    def test_stop_after_a_stage_ends_cleanly(self) -> None:
        chat = Chat(id="chat-stop", title="", created_at=0)
        q: queue.Queue = queue.Queue()
        result = SimpleNamespace(final_response="第一阶段", finish_reason="completed")

        def stop_after_first(*_args, **_kwargs):
            chat.stop_requested = True
            return "stage-sid", result

        with patch("agent_platform.agent.team.run_phase", side_effect=stop_after_first):
            run_team_turn(
                "生成测试", chat, q, harness=object(), workflow=WORKFLOW
            )

        events = drain(q)
        self.assertEqual(events[-1]["finish_reason"], "stopped")
        self.assertEqual(
            [event["agent"] for event in events if event.get("type") == "phase"],
            ["data-analysis"],
        )

    def test_mock_pipeline_replays_all_stages(self) -> None:
        chat = Chat(id="chat-mock", title="", created_at=0)
        q: queue.Queue = queue.Queue()
        with patch("agent_platform.agent.team.time.sleep"):
            run_mock_team_turn("生成测试", chat, q, WORKFLOW)

        events = drain(q)
        starts = [
            event["agent"]
            for event in events
            if event.get("type") == "phase" and event.get("stage") == "start"
        ]
        self.assertEqual(starts, [agent.id for agent in WORKFLOW.agents])
        self.assertEqual(events[-1]["finish_reason"], "workflow:completed")


class PipelineConfigTest(unittest.TestCase):
    def _load(self, payload: dict) -> object:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "workflows.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            return load_workflow(path)

    def test_duplicate_agent_ids_fall_back_to_default(self) -> None:
        workflow = self._load(
            {
                "type": "pipeline",
                "agents": [
                    {"id": "a", "role": "第一段"},
                    {"id": "a", "role": "重复"},
                ],
            }
        )
        self.assertFalse(workflow.is_pipeline)
        self.assertEqual(workflow.id, "coder-reviewer")

    def test_pipeline_requires_role(self) -> None:
        workflow = self._load(
            {"type": "pipeline", "agents": [{"id": "a", "name": "A"}]}
        )
        self.assertFalse(workflow.is_pipeline)

    def test_unknown_type_falls_back_to_default(self) -> None:
        workflow = self._load({"type": "dag", "agents": []})
        self.assertFalse(workflow.is_pipeline)
        self.assertEqual(workflow.id, "coder-reviewer")


if __name__ == "__main__":
    unittest.main()
