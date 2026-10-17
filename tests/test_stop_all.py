from __future__ import annotations

import time
import unittest
from types import SimpleNamespace

from agent_platform.main import Chat, _stop_all_runtime, state


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


class StopAllTest(unittest.TestCase):
    def setUp(self) -> None:
        self.previous_harness = state.harness
        self.previous_chats = state.chats
        state.chats = {}

    def tearDown(self) -> None:
        state.harness = self.previous_harness
        state.chats = self.previous_chats

    def test_stop_all_sets_flags_and_terminates_runtime(self) -> None:
        chat = Chat(id="chat-stop", title="", created_at=time.time())
        state.chats = {chat.id: chat}
        proc = _Proc()
        state.harness = SimpleNamespace(client=SimpleNamespace(_proc=proc))  # type: ignore[assignment]

        stopped = _stop_all_runtime()

        self.assertTrue(stopped)
        self.assertTrue(chat.stop_requested)
        self.assertTrue(proc.terminated)
        self.assertIsNone(state.harness)

    def test_stop_all_without_runtime_still_marks_chats(self) -> None:
        chat = Chat(id="chat-stop", title="", created_at=time.time())
        state.chats = {chat.id: chat}
        state.harness = None

        stopped = _stop_all_runtime()

        self.assertFalse(stopped)
        self.assertTrue(chat.stop_requested)


if __name__ == "__main__":
    unittest.main()
