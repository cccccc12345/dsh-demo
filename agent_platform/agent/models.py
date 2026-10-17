"""Agent 域的会话模型(纯数据,不依赖 Web)。"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Chat:
    """一个平台会话,持有 transcript 与 runtime 侧 session id。"""

    id: str
    title: str
    created_at: float
    transcript: list[dict[str, Any]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    # runtime 侧 session id。随机生成,与平台 chat id 解耦:
    # - 同一 server 进程内多轮复用它(runtime 支持同进程续聊)
    # - server 重启后它自然为 None,用全新 runtime 会话,永不与磁盘遗留撞车
    runtime_sid: str | None = None
    # 团队模式的角色会话 id(coder / reviewer 各自独立上下文,可跨轮复用)
    coder_sid: str | None = None
    reviewer_sid: str | None = None
    # 团队 lead(路由/直答)会话;和 coder/reviewer 分开,避免内部 JSON 污染角色上下文
    lead_sid: str | None = None
    # 本 chat 见过的 runtime session id(含 subagent 子会话),用于把审批请求路由回正确会话
    session_ids: set[str] = field(default_factory=set)
    # 全局"停止全部"会置位;worker 看到后输出干净的 stopped 结束事件
    stop_requested: bool = False

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title or "新会话",
            "createdAt": int(self.created_at * 1000),
            "messageCount": len(self.transcript),
        }

    # -- transcript 写入统一走这里,避免各处漏字段 -------------------------

    def add_user(self, text: str) -> None:
        self.transcript.append({"role": "user", "text": text, "ts": time.time()})

    def add_assistant(self, text: str, agent: str | None = None) -> None:
        if not text:
            return
        entry: dict[str, Any] = {
            "role": "assistant",
            "text": text,
            "ts": time.time(),
        }
        if agent is not None:
            entry["agent"] = agent
        self.transcript.append(entry)

    def add_system(self, text: str) -> None:
        self.transcript.append({"role": "system", "text": text, "ts": time.time()})
