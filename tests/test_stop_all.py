from __future__ import annotations

import unittest
from types import SimpleNamespace

from agent_platform.agent.runtime import RuntimeManager
from agent_platform.agent.service import AgentService
from agent_platform.workflows import default_workflow


class _Proc:
    def __init__(self) -> None:
        self.terminated = False
        self.killed = False

    def poll(self) -> None:
        return None

    def terminate(self) -> None:
        self.terminated = True

    def wait(self, timeout: float | None = None) -> int:
        return 0

    def kill(self) -> None:
        self.killed = True


def _service(harness: object | None = None) -> tuple[AgentService, RuntimeManager]:
    runtime = RuntimeManager(harness=harness, log=lambda _message: None)  # type: ignore[arg-type]
    return (
        AgentService(runtime=runtime, workflow=default_workflow()),
        runtime,
    )


class StopAllTest(unittest.TestCase):
    def test_stop_all_sets_flags_and_terminates_runtime(self) -> None:
        proc = _Proc()
        harness = SimpleNamespace(client=SimpleNamespace(_proc=proc))
        service, runtime = _service(harness)
        chat = service.get_or_create_chat("chat-stop")

        stopped = service.stop_all()

        self.assertTrue(stopped)
        self.assertTrue(chat.stop_requested)
        self.assertTrue(proc.terminated)
        self.assertFalse(runtime.alive)

    def test_stop_all_without_runtime_still_marks_chats(self) -> None:
        service, runtime = _service()
        chat = service.get_or_create_chat("chat-stop")

        stopped = service.stop_all()

        self.assertFalse(stopped)
        self.assertTrue(chat.stop_requested)
        self.assertFalse(runtime.alive)


if __name__ == "__main__":
    unittest.main()
