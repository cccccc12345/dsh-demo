"""Agent 核心侧的路径与环境配置。

这个模块不依赖 FastAPI/Starlette,可以直接在脚本、CLI 或 worker 进程里复用。
"""
from __future__ import annotations

import os
from pathlib import Path

# agent_platform/agent/config.py -> agent_platform -> 仓库根目录
PACKAGE_DIR = Path(__file__).resolve().parents[1]
ROOT = PACKAGE_DIR.parent

WORKSPACE_DIR = ROOT / ".dsh-workspace"
DSH_HOME_DIR = ROOT / ".dsh-home"
WORKFLOWS_FILE = ROOT / "workflows.json"
SKILLS_DIR = PACKAGE_DIR / "skills"
SKILLS_PATCH = PACKAGE_DIR / "dsh-patches" / "skills.yml"
MCP_PATCH = PACKAGE_DIR / "dsh-patches" / "mcp.yml"
MCP_EXAMPLE_PATCH = PACKAGE_DIR / "dsh-patches" / "mcp.example.yml"
SUBAGENTS_PATCH = PACKAGE_DIR / "dsh-patches" / "agents.yml"
SUBAGENTS_EXAMPLE_PATCH = PACKAGE_DIR / "dsh-patches" / "agents.example.yml"
STREAM_FORWARDER = (
    PACKAGE_DIR
    / "dsh-plugins"
    / "assistant-stream-forwarder"
    / "index.js"
)
STREAM_PATCH_RUNTIME = DSH_HOME_DIR / "patches" / "streaming.yml"

PROVIDER = os.environ.get("DSH_PROVIDER", "deepseek-official")
MODEL = os.environ.get("DSH_MODEL", "deepseek-v4-flash")


def load_env_file(path: Path) -> dict[str, str]:
    """解析 KEY=value / export KEY=value 风格的 .env 文件,进程环境变量优先。"""
    values: dict[str, str] = {}
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            line = line.removeprefix("export ").strip()
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
    for key, value in os.environ.items():
        if value:
            values[key] = value
    return values


def key_is_placeholder(api_key: str | None) -> bool:
    """占位 key 判定:缺失,或包含无法放进 HTTP 头的字符(中文/引号/空白等)。"""
    if not api_key:
        return True
    return any(not (c.isascii() and (c.isalnum() or c in "-_.~")) for c in api_key)
