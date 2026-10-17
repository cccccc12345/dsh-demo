from __future__ import annotations

import unittest

from deepseek_harness.models import Notification

from agent_platform.main import STREAM_FORWARDER, translate_notification


def stream(frame: dict, session_id: str = "session-root") -> dict | None:
    return translate_notification(
        Notification(
            method="agent/assistant-stream",
            payload={"sessionId": session_id, "frame": frame},
        ),
        root_sid="session-root",
    )


class StreamingTranslationTest(unittest.TestCase):
    def test_stream_forwarder_is_packaged(self) -> None:
        self.assertTrue(STREAM_FORWARDER.is_file())
        self.assertIn("agent/assistant-stream", STREAM_FORWARDER.read_text(encoding="utf-8"))

    def test_stream_lifecycle(self) -> None:
        start = stream(
            {"type": "start", "attemptId": "session-root:1", "turn": 1, "step": 1}
        )
        self.assertEqual(start["type"], "assistant_stream_start")
        self.assertEqual(start["streamId"], "session-root:1")

        delta = stream(
            {
                "type": "chunk",
                "attemptId": "session-root:1",
                "chunk": {"type": "text-delta", "text": "pong"},
            }
        )
        self.assertEqual(delta, {"type": "assistant_delta", "streamId": "session-root:1", "text": "pong"})

        end = stream({"type": "end", "attemptId": "session-root:1"})
        self.assertEqual(end["type"], "assistant_stream_end")

    def test_stream_is_scoped_to_child_session(self) -> None:
        event = stream(
            {
                "type": "chunk",
                "attemptId": "session-child:1",
                "chunk": {"type": "text-delta", "text": "child"},
            },
            session_id="session-child",
        )
        self.assertEqual(event["scope"], "child")

    def test_non_text_chunks_are_ignored(self) -> None:
        self.assertIsNone(
            stream(
                {
                    "type": "chunk",
                    "attemptId": "session-root:1",
                    "chunk": {"type": "reasoning-delta", "text": "thinking"},
                }
            )
        )

    def test_usage_chunk_is_translated(self) -> None:
        event = stream(
            {
                "type": "chunk",
                "attemptId": "session-root:1",
                "chunk": {
                    "type": "usage",
                    "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
                },
            }
        )
        self.assertEqual(event["type"], "usage")
        self.assertEqual(event["usage"]["outputTokens"], 5)


if __name__ == "__main__":
    unittest.main()
