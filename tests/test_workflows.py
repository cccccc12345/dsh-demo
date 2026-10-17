from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agent_platform.workflows import default_workflow, load_workflow


class WorkflowTest(unittest.TestCase):
    def test_default_roster_explains_list_agents(self) -> None:
        workflow = default_workflow()
        context = workflow.team_context("coder")
        self.assertIn("2 个模型 agent", context)
        self.assertIn("Reviewer", context)
        self.assertIn("(你)", context)
        self.assertIn("list_agents", context)
        self.assertIn("不能用来判断团队人数", context)

    def test_custom_workflow_overrides_names_and_rounds(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "workflows.json"
            path.write_text(
                json.dumps(
                    {
                        "name": "Custom Team",
                        "maxRounds": 2,
                        "agents": [
                            {"id": "coder", "name": "Builder", "emoji": "🛠"},
                            {"id": "reviewer", "name": "Auditor", "emoji": "🧐"},
                        ],
                    }
                ),
                encoding="utf-8",
            )
            workflow = load_workflow(path)
        self.assertEqual(workflow.name, "Custom Team")
        self.assertEqual(workflow.max_rounds, 2)
        self.assertEqual([agent.name for agent in workflow.agents], ["Builder", "Auditor"])

    def test_invalid_workflow_falls_back_to_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "workflows.json"
            path.write_text(
                json.dumps({"agents": [{"id": "intruder"}]}),
                encoding="utf-8",
            )
            workflow = load_workflow(path)
        self.assertEqual(workflow.id, default_workflow().id)
        self.assertEqual(workflow.max_rounds, 1)


if __name__ == "__main__":
    unittest.main()
