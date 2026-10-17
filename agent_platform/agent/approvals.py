"""人工审批桥的基础设施:待审批请求 + 本地回调 HTTP server。

runtime 里的 ``approval-bridge`` 插件在 dsh 触发 ``approval/request`` 时,
会 POST 到这里的回调 server。server 把请求交给 AgentService,等待浏览器
(或 demo 脚本)做出决定,再把 ``allowed-once`` / ``rejected`` 返回给插件。
"""
from __future__ import annotations

import json
import queue
import secrets
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

APPROVAL_OUTCOMES = ("allowed-once", "rejected", "cancelled", "unavailable")
_MAX_BODY_BYTES = 64 * 1024


@dataclass
class PendingApproval:
    """一条等待人工决定的审批请求。"""

    id: str
    chat_id: str
    queue: "queue.Queue[Any]"
    tool_name: str
    call_id: str | None
    reason: str
    created_at: float
    event: threading.Event = field(default_factory=threading.Event)
    outcome: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "chatId": self.chat_id,
            "toolName": self.tool_name,
            "callId": self.call_id,
            "reason": self.reason,
            "createdAt": int(self.created_at * 1000),
        }


class ApprovalCallbackServer:
    """只监听 127.0.0.1 的审批回调 server。

    每个请求由独立线程处理,所以多个 chat 的审批可以并行等待。
    """

    def __init__(
        self,
        handler: Callable[[dict[str, Any]], dict[str, Any]],
        *,
        host: str = "127.0.0.1",
    ) -> None:
        self.token = secrets.token_urlsafe(32)
        self._handler = handler
        parent = self

        class _Server(ThreadingHTTPServer):
            daemon_threads = True
            allow_reuse_address = True

        class _Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
                if self.path.split("?", 1)[0] != "/approval":
                    self._send(404, {"outcome": "unavailable", "error": "not found"})
                    return
                token = self.headers.get("x-approval-token") or ""
                if not secrets.compare_digest(
                    token.encode("utf-8"), parent.token.encode("utf-8")
                ):
                    self._send(403, {"outcome": "unavailable", "error": "forbidden"})
                    return
                try:
                    length = int(self.headers.get("content-length") or "0")
                except ValueError:
                    length = 0
                if length <= 0 or length > _MAX_BODY_BYTES:
                    self._send(400, {"outcome": "unavailable", "error": "invalid body"})
                    return
                try:
                    payload = json.loads(self.rfile.read(length).decode("utf-8"))
                    if not isinstance(payload, dict):
                        raise ValueError("payload must be an object")
                    result = parent._handler(payload)
                    status = 200
                except Exception as exc:  # noqa: BLE001 - 回调失败必须 fail closed
                    result = {
                        "outcome": "unavailable",
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                    status = 500
                self._send(status, result)

            def _send(self, status: int, payload: dict[str, Any]) -> None:
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                try:
                    self.send_response(status)
                    self.send_header("content-type", "application/json; charset=utf-8")
                    self.send_header("content-length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, _format: str, *args: Any) -> None:
                return

        self._httpd = _Server((host, 0), _Handler)
        self._thread = threading.Thread(
            target=self._httpd.serve_forever,
            name="approval-callback",
            daemon=True,
        )

    @property
    def url(self) -> str:
        host, port = self._httpd.server_address[:2]
        return f"http://{host}:{port}/approval"

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        try:
            self._httpd.shutdown()
        finally:
            self._httpd.server_close()
            self._thread.join(timeout=2)
