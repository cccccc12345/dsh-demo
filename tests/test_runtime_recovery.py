from __future__ import annotations

import unittest
from types import SimpleNamespace

from agent_platform.main import _ensure_harness, _harness_alive, state


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
    def setUp(self) -> None:
        self.previous = (
            state.harness,
            state.harness_factory,
            state.mock_mode,
            state.shutting_down,
            state.startup_error,
        )

    def tearDown(self) -> None:
        (
            state.harness,
            state.harness_factory,
            state.mock_mode,
            state.shutting_down,
            state.startup_error,
        ) = self.previous

    def test_alive_detection(self) -> None:
        self.assertTrue(_harness_alive(_Harness(None)))
        self.assertFalse(_harness_alive(_Harness(0)))
        self.assertFalse(_harness_alive(None))

    def test_dead_runtime_is_restarted(self) -> None:
        dead = _Harness(0)
        live = _Harness(None)
        state.harness = dead  # type: ignore[assignment]
        state.harness_factory = lambda: live  # type: ignore[assignment]
        state.mock_mode = False
        state.shutting_down = False

        result = _ensure_harness()

        self.assertIs(result, live)
        self.assertTrue(live.started)
        self.assertTrue(dead.closed)
        self.assertIs(state.harness, live)

    def test_mock_mode_never_starts_runtime(self) -> None:
        state.harness = None
        state.harness_factory = lambda: self.fail("should not start")  # type: ignore[assignment]
        state.mock_mode = True
        state.shutting_down = False

        self.assertIsNone(_ensure_harness())


if __name__ == "__main__":
    unittest.main()
