from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parents[1] / "agent_platform"
PLUGIN = PACKAGE_DIR / "dsh-plugins" / "approval-bridge" / "index.js"
NODE = shutil.which("node")


class ApprovalBridgePluginTest(unittest.TestCase):
    def test_plugin_is_packaged(self) -> None:
        source = PLUGIN.read_text(encoding="utf-8")
        self.assertIn("approval/request", source)
        self.assertIn("AGENT_APPROVAL_URL", source)
        self.assertIn("allowed-once", source)

    @unittest.skipUnless(NODE, "需要 node 才能执行插件逻辑")
    def test_plugin_forwards_and_returns_decision(self) -> None:
        script = f"""
import http from "node:http";
import {{ apply }} from {json.dumps(PLUGIN.as_uri())};

let listener;
let preExecute;
const ctx = {{
  on(event, handler) {{
    if (event === "approval/request") listener = handler;
    if (event === "tools/pre-execute") preExecute = handler;
  }},
}};
process.env.AGENT_APPROVAL_TOOLS = "bash";
apply(ctx);
if (!listener) throw new Error("没有注册 approval/request 监听器");
if (!preExecute) throw new Error("没有注册 tools/pre-execute 监听器");
const gate = await preExecute({{ name: "bash" }}, async () => ({{ kind: "allow" }}));
const pass = await preExecute({{ name: "read" }}, async () => ({{ kind: "allow" }}));

const server = http.createServer((req, res) => {{
  let body = "";
  req.on("data", (chunk) => {{ body += chunk; }});
  req.on("end", () => {{
    const payload = JSON.parse(body);
    res.writeHead(200, {{ "content-type": "application/json" }});
    res.end(JSON.stringify({{
      outcome: payload.toolName === "guarded_echo" ? "allowed-once" : "rejected",
    }}));
  }});
}});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
process.env.AGENT_APPROVAL_URL = `http://127.0.0.1:${{port}}/approval`;
process.env.AGENT_APPROVAL_TOKEN = "test-token";
process.env.AGENT_APPROVAL_TIMEOUT_MS = "10000";

const req = {{
  agent: {{ session: {{ id: "session-1" }} }},
  toolName: "guarded_echo",
  callId: "call-1",
  reason: "test",
  signal: new AbortController().signal,
}};
const outcome = await listener(req, async () => "unavailable");

const missingUrlOutcome = await (async () => {{
  delete process.env.AGENT_APPROVAL_URL;
  return listener(req, async () => "unavailable");
}})();

server.close();
console.log(JSON.stringify({{
  outcome,
  missingUrlOutcome,
  gateKind: gate.kind,
  passKind: pass.kind,
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
        self.assertEqual(payload["outcome"], "allowed-once")
        self.assertEqual(payload["missingUrlOutcome"], "unavailable")
        self.assertEqual(payload["gateKind"], "ask")
        self.assertEqual(payload["passKind"], "allow")


if __name__ == "__main__":
    unittest.main()
