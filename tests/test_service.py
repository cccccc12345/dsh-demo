from __future__ import annotations

import queue
import unittest
from unittest.mock import patch

from agent_platform.agent.runtime import RuntimeManager
from agent_platform.agent.service import AgentService, ChatBusy, ChatNotFound
from agent_platform.workflows import default_workflow


def _fast_mock_turn(text: str, chat, events: queue.Queue) -> None:
    chat.add_user(text)
    events.put({"type": "user_echo", "text": text})
    events.put({"type": "end", "response": "ok", "finish_reason": "mock"})


class AgentServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.service = AgentService(
            runtime=RuntimeManager(log=lambda _message: None),
            workflow=default_workflow(),
        )
        self.service.mock_mode = True

    def test_start_turn_streams_events_and_releases_chat(self) -> None:
        with patch(
            "agent_platform.agent.service.run_mock_turn", _fast_mock_turn
        ):
            stream = self.service.start_turn("chat-1", "hi")

        events = []
        for _ in range(10):
            try:
                event = stream.next_event(timeout=1.0)
            except queue.Empty as exc:  # pragma: no cover - 超时即失败
                self.fail(f"turn 未在超时内结束: {exc}")
            if event is None:
                break
            events.append(event)

        self.assertEqual([event["type"] for event in events], ["user_echo", "end"])
        self.assertFalse(self.service.get_chat("chat-1").lock.locked())

    def test_busy_chat_rejects_second_turn(self) -> None:
        chat = self.service.get_or_create_chat("chat-busy")
        chat.lock.acquire()
        try:
            with self.assertRaises(ChatBusy):
                self.service.start_turn("chat-busy", "hi")
        finally:
            chat.lock.release()

    def test_missing_chat_raises(self) -> None:
        with self.assertRaises(ChatNotFound):
            self.service.get_chat("chat-missing")

    def test_rename_chat_trims_title_and_rejects_empty(self) -> None:
        chat = self.service.create_chat("旧标题")
        renamed = self.service.rename_chat(chat["id"], "  新标题  ")
        self.assertEqual(renamed["title"], "新标题")
        self.assertEqual(self.service.get_chat(chat["id"]).title, "新标题")
        with self.assertRaises(ValueError):
            self.service.rename_chat(chat["id"], "   ")


if __name__ == "__main__":
    unittest.main()
