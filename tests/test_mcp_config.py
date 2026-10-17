from __future__ import annotations

import unittest

from agent_platform.main import MCP_EXAMPLE_PATCH


class McpConfigTest(unittest.TestCase):
    def test_example_patch_is_valid_example(self) -> None:
        self.assertTrue(MCP_EXAMPLE_PATCH.is_file())
        text = MCP_EXAMPLE_PATCH.read_text(encoding="utf-8")
        self.assertIn("@deepseek-ai/dsh-mcp-client", text)
        self.assertIn("serverName", text)
        self.assertIn("transport", text)


if __name__ == "__main__":
    unittest.main()
