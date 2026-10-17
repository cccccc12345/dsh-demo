from __future__ import annotations

import unittest

from agent_platform.main import SKILLS_DIR, SKILLS_PATCH


class SkillsConfigTest(unittest.TestCase):
    def test_custom_skill_root_is_wired(self) -> None:
        self.assertTrue(SKILLS_PATCH.is_file())
        patch = SKILLS_PATCH.read_text(encoding="utf-8")
        self.assertIn("customSkillDirs", patch)
        self.assertIn("DSH_SKILLS_DIR", patch)

    def test_example_skill_has_required_frontmatter(self) -> None:
        skill = SKILLS_DIR / "example" / "SKILL.md"
        self.assertTrue(skill.is_file())
        text = skill.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("---\n"))
        self.assertIn("name: example", text)
        self.assertIn("description:", text)


if __name__ == "__main__":
    unittest.main()
