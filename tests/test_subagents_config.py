from __future__ import annotations

import unittest

from agent_platform.main import SUBAGENTS_EXAMPLE_PATCH


class SubagentsConfigTest(unittest.TestCase):
    def test_example_patch_has_named_tools(self) -> None:
        self.assertTrue(SUBAGENTS_EXAMPLE_PATCH.is_file())
        text = SUBAGENTS_EXAMPLE_PATCH.read_text(encoding="utf-8")
        self.assertIn("dsh-tool-subagent", text)
        for tool in ("researcher", "coder", "reviewer"):
            self.assertIn(f"toolName: {tool}", text)
        self.assertIn("backgroundMode: continuable", text)


if __name__ == "__main__":
    unittest.main()
