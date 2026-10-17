from __future__ import annotations

import unittest

from agent_platform.main import (
    _clean_title,
    _parse_lead_decision,
    _platform_prompt,
    _team_prompt,
)


class PromptTest(unittest.TestCase):
    def test_platform_prompt_puts_user_text_first(self) -> None:
        prompt = _platform_prompt("帮我修一个 bug")
        self.assertTrue(prompt.startswith("帮我修一个 bug"))
        self.assertIn("[平台上下文]", prompt)
        self.assertIn("list_agents", prompt)

    def test_team_prompt_puts_task_before_roster(self) -> None:
        prompt = _team_prompt("coder", "角色说明", "任务:实现功能")
        self.assertTrue(prompt.startswith("任务:实现功能"))
        self.assertIn("角色说明", prompt)
        self.assertIn("[平台团队上下文]", prompt)

    def test_platform_context_is_not_used_as_title(self) -> None:
        self.assertEqual(
            _clean_title("[平台上下文] 你是平台默认对话", "修复登录问题"),
            "修复登录问题",
        )
        self.assertEqual(_clean_title("修复登录问题", "兜底标题"), "修复登录问题")

    def test_lead_decision_parses_json_and_fences(self) -> None:
        answer = _parse_lead_decision(
            '{"route":"answer","plan":"","answer":"直接回答"}'
        )
        self.assertIsNotNone(answer)
        self.assertEqual(answer.route, "answer")
        self.assertEqual(answer.answer, "直接回答")

        coding = _parse_lead_decision(
            '```json\n{"route":"coding","plan":"改文件","answer":""}\n```'
        )
        self.assertIsNotNone(coding)
        self.assertEqual(coding.route, "coding")
        self.assertEqual(coding.plan, "改文件")

        inspect = _parse_lead_decision(
            '{"route":"inspect","plan":"读文件","answer":""}'
        )
        self.assertIsNotNone(inspect)
        self.assertEqual(inspect.route, "inspect")

    def test_lead_decision_rejects_invalid_payload(self) -> None:
        self.assertIsNone(_parse_lead_decision("not json"))
        self.assertIsNone(_parse_lead_decision('{"route":"answer"}'))


if __name__ == "__main__":
    unittest.main()
