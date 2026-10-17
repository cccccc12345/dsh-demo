"""共享 dsh runtime 的生命周期管理(启动 / 自动重启 / 停止全部)。

这一层只认识 ``DeepSeekHarness``,不依赖 Web 层。
"""
from __future__ import annotations

import subprocess
import threading
from typing import Callable

from deepseek_harness import DeepSeekHarness


def harness_alive(harness: DeepSeekHarness | None) -> bool:
    """检查 SDK 持有的 runtime 子进程是否仍存活。

    不额外发 JSON-RPC 请求:进程已退出时直接看 Popen.poll() 即可。
    """
    if harness is None:
        return False
    proc = getattr(getattr(harness, "client", None), "_proc", None)
    return proc is not None and proc.poll() is None


class RuntimeManager:
    """管理一个被所有会话共享的 runtime 子进程。"""

    def __init__(
        self,
        harness: DeepSeekHarness | None = None,
        factory: Callable[[], DeepSeekHarness] | None = None,
        *,
        log: Callable[[str], None] = print,
    ) -> None:
        self._harness = harness
        self._factory = factory
        self._lock = threading.Lock()
        self._log = log
        self.shutting_down = False
        self.last_error: str | None = None

    @property
    def alive(self) -> bool:
        return harness_alive(self._harness)

    def configure(self, factory: Callable[[], DeepSeekHarness] | None) -> None:
        self._factory = factory

    def reset(self) -> None:
        """允许 service 在 stop 后重新 start。"""
        self.shutting_down = False
        self.last_error = None

    def start(self) -> DeepSeekHarness:
        """首次启动;失败时异常上抛,由 AgentService 决定是否回退 Mock。"""
        if self._factory is None:
            raise RuntimeError("runtime factory 未配置")
        harness = self._factory()
        harness.start()
        self._harness = harness
        self.last_error = None
        return harness

    def ensure(self) -> DeepSeekHarness | None:
        """runtime 意外退出时自动重启一次;失败返回 None。"""
        if self.alive:
            return self._harness
        if self.shutting_down or self._factory is None:
            return None
        with self._lock:
            if self.alive:
                return self._harness
            old = self._harness
            self._harness = None
            self._close(old)
            try:
                harness = self._factory()
                harness.start()
                self._harness = harness
                self.last_error = None
                self._log("[agent-platform] runtime 已重新启动")
                return harness
            except Exception as exc:  # noqa: BLE001
                self._harness = None
                self.last_error = f"{type(exc).__name__}: {exc}"
                self._log(f"[agent-platform] runtime 重启失败:{exc}")
                return None

    def stop_all(self) -> bool:
        """硬中断共享 runtime;下一次 ensure/start 会重新拉起。"""
        with self._lock:
            harness = self._harness
            self._harness = None
            if harness is None:
                return False
            proc = getattr(getattr(harness, "client", None), "_proc", None)
            if proc is None or proc.poll() is not None:
                return False
            try:
                proc.terminate()
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                return True
            except Exception as exc:  # noqa: BLE001
                self._log(f"[agent-platform] 停止 runtime 失败:{exc}")
                return False

    def close(self) -> None:
        self.shutting_down = True
        with self._lock:
            harness = self._harness
            self._harness = None
        if harness is not None:
            self._close(harness)

    def _close(self, harness: DeepSeekHarness | None) -> None:
        if harness is None:
            return
        try:
            harness.close()
        except Exception:  # noqa: BLE001 - 旧 runtime 已经退出
            pass
