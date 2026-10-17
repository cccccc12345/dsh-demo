from __future__ import annotations

import unittest
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parents[1] / "agent_platform"


class ModuleBoundaryTest(unittest.TestCase):
    def test_agent_core_does_not_import_web_frameworks(self) -> None:
        forbidden = ("fastapi", "starlette", "uvicorn")
        for path in (PACKAGE_DIR / "agent").rglob("*.py"):
            source = path.read_text(encoding="utf-8")
            for module in forbidden:
                self.assertNotIn(f"import {module}", source, f"{path} 不应依赖 {module}")
                self.assertNotIn(f"from {module}", source, f"{path} 不应依赖 {module}")

    def test_web_layer_does_not_touch_runtime_sdk(self) -> None:
        for path in (PACKAGE_DIR / "web").rglob("*.py"):
            source = path.read_text(encoding="utf-8")
            self.assertNotIn("deepseek_harness", source, f"{path} 不应直接依赖 runtime SDK")

    def test_main_is_thin_entrypoint(self) -> None:
        source = (PACKAGE_DIR / "main.py").read_text(encoding="utf-8")
        self.assertIn("create_app", source)
        self.assertNotIn("FastAPI(", source)
        self.assertNotIn("DeepSeekHarness", source)
        self.assertLessEqual(len(source.splitlines()), 30)


if __name__ == "__main__":
    unittest.main()
