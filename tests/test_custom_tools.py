from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from agent_platform.agent.config import LOCAL_TOOLS_DIR, discover_tool_plugins

NODE = shutil.which("node")


class LocalToolPluginTest(unittest.TestCase):
    def test_demo_plugin_is_packaged(self) -> None:
        plugins = discover_tool_plugins()
        names = [plugin.parent.name for plugin in plugins]
        self.assertIn("demo-tools", names)

        source = (LOCAL_TOOLS_DIR / "demo-tools" / "index.js").read_text(
            encoding="utf-8"
        )
        self.assertIn("ctx.tools.register", source)
        self.assertIn("name: 'text_stats'", source)
        self.assertIn("parameters:", source)

    def test_discovery_only_accepts_plugin_directories(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            for name in ("b-tool", "a-tool"):
                plugin = base / name
                plugin.mkdir()
                (plugin / "index.js").write_text("export {};\n", encoding="utf-8")
            ignored = base / "ignored"
            ignored.mkdir()
            (ignored / "other.js").write_text("export {};\n", encoding="utf-8")

            found = discover_tool_plugins(base)

        self.assertEqual([path.parent.name for path in found], ["a-tool", "b-tool"])

    @unittest.skipUnless(NODE, "需要 node 才能执行插件逻辑")
    def test_demo_tool_registers_and_executes(self) -> None:
        plugin = LOCAL_TOOLS_DIR / "demo-tools" / "index.js"
        script = f"""
import {{ apply }} from {json.dumps(plugin.as_uri())};
const tools = new Map();
let approvalOutcome = "allowed-once";
let approvalCalls = 0;
const ctx = {{
  tools: {{
    register(definition) {{
      tools.set(definition.name, definition);
      return () => {{}};
    }},
  }},
  approval: {{
    async request() {{
      approvalCalls += 1;
      return approvalOutcome;
    }},
  }},
}};
apply(ctx);
if (!tools.has("text_stats")) throw new Error("缺少 text_stats");
if (!tools.has("guarded_echo")) throw new Error("缺少 guarded_echo");

const textTool = tools.get("text_stats");
const args = {{ text: "hello world" }};
const value = await textTool.execute(args);
const rendered = textTool.output.render(args, value);

const guarded = tools.get("guarded_echo");
const exec = {{ agent: {{}}, callId: "call-1", signal: new AbortController().signal }};
const approved = await guarded.execute({{ text: "ok", reason: "test" }}, exec);
let rejectedError = "";
approvalOutcome = "rejected";
try {{
  await guarded.execute({{ text: "no", reason: "test" }}, exec);
}} catch (error) {{
  rejectedError = error.message;
}}
console.log(JSON.stringify({{
  name: textTool.name,
  value,
  rendered,
  approved,
  approvalCalls,
  rejectedError,
}}));
"""
        result = subprocess.run(
            [NODE, "--input-type=module", "-e", script],
            capture_output=True,
            text=True,
            timeout=30,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(payload["name"], "text_stats")
        self.assertEqual(payload["value"], {"characters": 11, "words": 2})
        self.assertEqual(
            payload["rendered"],
            [{"type": "text", "text": "字符数:11;单词数:2"}],
        )
        self.assertEqual(payload["approved"], "已批准:ok")
        self.assertEqual(payload["approvalCalls"], 2)
        self.assertIn("rejected", payload["rejectedError"])


if __name__ == "__main__":
    unittest.main()
