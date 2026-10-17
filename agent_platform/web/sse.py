"""把 agent 的阻塞事件队列桥接成浏览器 SSE。"""
from __future__ import annotations

import asyncio
import json
import queue
from concurrent.futures import ThreadPoolExecutor

from fastapi.responses import StreamingResponse

from agent_platform.agent.service import TurnStream

_POLL_TIMEOUT = 0.25


def sse_response(stream: TurnStream, executor: ThreadPoolExecutor) -> StreamingResponse:
    loop = asyncio.get_running_loop()

    async def generator():
        while True:
            try:
                item = await loop.run_in_executor(
                    executor, stream.next_event, _POLL_TIMEOUT
                )
            except queue.Empty:
                continue
            if item is None:
                break
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
        yield 'data: {"type":"done"}\n\n'

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
