from __future__ import annotations

import json
import queue
import threading
import unittest
import urllib.error
import urllib.request

from agent_platform.agent.approvals import ApprovalCallbackServer
from agent_platform.agent.runtime import RuntimeManager
from agent_platform.agent.service import AgentService
from agent_platform.workflows import default_workflow


def _post(url: str, token: str, payload: dict) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "x-approval-token": token,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


class ApprovalCallbackServerTest(unittest.TestCase):
    def test_callback_round_trip(self) -> None:
        server = ApprovalCallbackServer(
            lambda payload: {"outcome": "allowed-once", "echo": payload["toolName"]}
        )
        server.start()
        try:
            result = _post(
                server.url,
                server.token,
                {"sessionId": "s1", "toolName": "bash", "reason": "test"},
            )
        finally:
            server.stop()

        self.assertEqual(result, {"outcome": "allowed-once", "echo": "bash"})

    def test_callback_rejects_bad_token(self) -> None:
        server = ApprovalCallbackServer(lambda _payload: {"outcome": "allowed-once"})
        server.start()
        try:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                _post(server.url, "wrong-token", {"toolName": "bash"})
        finally:
            server.stop()

        self.assertEqual(caught.exception.code, 403)


class ServiceApprovalTest(unittest.TestCase):
    def setUp(self) -> None:
        self.service = AgentService(
            runtime=RuntimeManager(log=lambda _message: None),
            workflow=default_workflow(),
            approval_enabled=True,
            approval_timeout=5,
        )
        self.chat = self.service.get_or_create_chat("chat-approval")
        self.chat.runtime_sid = "session-approval"
        self.events: queue.Queue = queue.Queue()
        self.service._active_turns[self.chat.id] = self.events

    def _start_request(self) -> tuple[threading.Thread, dict]:
        result: dict = {}

        def run() -> None:
            result.update(
                self.service._handle_approval_request(
                    {
                        "sessionId": "session-approval",
                        "toolName": "guarded_echo",
                        "callId": "call-1",
                        "reason": "请确认",
                    }
                )
            )

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        request_event = self.events.get(timeout=2)
        return thread, request_event

    def test_approve_round_trip(self) -> None:
        thread, event = self._start_request()
        self.assertEqual(event["type"], "approval_request")
        self.assertEqual(event["toolName"], "guarded_echo")
        self.assertEqual(event["reason"], "请确认")

        outcome = self.service.resolve_approval(event["approvalId"], True)
        thread.join(timeout=2)

        self.assertEqual(outcome, "allowed-once")
        resolved = self.events.get(timeout=2)
        self.assertEqual(resolved["type"], "approval_resolved")
        self.assertEqual(resolved["outcome"], "allowed-once")

    def test_timeout_rejects_and_notifies(self) -> None:
        self.service.approval_timeout = 0.1
        thread, event = self._start_request()
        thread.join(timeout=2)

        self.assertFalse(thread.is_alive())
        resolved = self.events.get(timeout=2)
        self.assertEqual(resolved["type"], "approval_resolved")
        self.assertEqual(resolved["outcome"], "rejected")
        self.assertFalse(event["approvalId"] in self.service._approvals)

    def test_unknown_approval_raises(self) -> None:
        from agent_platform.agent.service import ApprovalNotFound

        with self.assertRaises(ApprovalNotFound):
            self.service.resolve_approval("missing", True)


if __name__ == "__main__":
    unittest.main()
