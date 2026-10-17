from __future__ import annotations

import unittest
from types import SimpleNamespace

from agent_platform.agent.runtime import RuntimeManager, harness_alive
from agent_platform.agent.service import AgentService


class _Proc:
    def __init__(self, returncode: int | None) -> None:
        self.returncode = returncode

    def poll(self) -> int | None:
        return self.returncode


class _Harness:
    def __init__(self, returncode: int | None = None) -> None:
        self.client = SimpleNamespace(_proc=_Proc(returncode))
        self.started = False
        self.closed = False

    def start(self) -> None:
        self.started = True

    def close(self) -> None:
        self.closed = True


class RuntimeRecoveryTest(unittest.TestCase):
    def test_alive_detection(self) -> None:
        self.assertTrue(harness_alive(_Harness(None)))
        self.assertFalse(harness_alive(_Harness(0)))
        self.assertFalse(harness_alive(None))

    def test_dead_runtime_is_restarted(self) -> None:
        dead = _Harness(0)
        live = _Harness(None)
        runtime = RuntimeManager(
            harness=dead, factory=lambda: live, log=lambda _message: None
        )

        result = runtime.ensure()

        self.assertIs(result, live)
        self.assertTrue(live.started)
        self.assertTrue(dead.closed)
        self.assertTrue(runtime.alive)

    def test_shutting_down_never_restarts_runtime(self) -> None:
        runtime = RuntimeManager(
            factory=lambda: self.fail("should not start"),
            log=lambda _message: None,
        )
        runtime.shutting_down = True

        self.assertIsNone(runtime.ensure())

    def test_mock_mode_never_starts_runtime(self) -> None:
        service = AgentService(
            runtime=RuntimeManager(
                factory=lambda: self.fail("should not start"),
                log=lambda _message: None,
            )
        )
        service.mock_mode = True

        self.assertIsNone(service._ensure_runtime())


if __name__ == "__main__":
    unittest.main()
