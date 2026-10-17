"""FastAPI 适配层:路由、SSE 桥接、静态资源。

这里只调用 ``AgentService`` 的公开方法,不直接接触 runtime/通知翻译。
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Annotated, Any

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel

from agent_platform.agent.service import (
    AgentService,
    AgentUnavailable,
    ApprovalNotFound,
    ChatBusy,
    ChatNotFound,
)

from .sse import sse_response
from .static import install_static_routes

router = APIRouter()


def get_service(request: Request) -> AgentService:
    return request.app.state.agent_service


def get_executor(request: Request) -> ThreadPoolExecutor:
    return request.app.state.sse_executor


ServiceDep = Annotated[AgentService, Depends(get_service)]
ExecutorDep = Annotated[ThreadPoolExecutor, Depends(get_executor)]


class MessageIn(BaseModel):
    text: str


class ApprovalDecisionIn(BaseModel):
    decision: str


@router.get("/api/config")
def api_config(service: ServiceDep) -> dict[str, Any]:
    return service.config()


@router.get("/api/agents")
def api_list_agents(service: ServiceDep) -> dict[str, Any]:
    return service.agents()


@router.post("/api/stop")
def api_stop_all(service: ServiceDep) -> dict[str, Any]:
    """停止全部:硬中断共享 runtime;下一条消息会自动重启。"""
    stopped = service.stop_all()
    return {
        "ok": True,
        "stopped": stopped,
        "message": "全部任务已停止;下一条消息会自动重启 runtime",
    }


@router.get("/api/approvals")
def api_list_approvals(service: ServiceDep) -> list[dict[str, Any]]:
    """当前等待人工决定的审批。"""
    return service.list_approvals()


@router.post("/api/approvals/{approval_id}")
def api_resolve_approval(
    approval_id: str, body: ApprovalDecisionIn, service: ServiceDep
) -> dict[str, Any]:
    decision = body.decision.strip().lower()
    if decision not in {"approve", "reject"}:
        raise HTTPException(400, "decision 必须是 approve 或 reject")
    try:
        outcome = service.resolve_approval(approval_id, decision == "approve")
    except ApprovalNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"ok": True, "id": approval_id, "outcome": outcome}


@router.get("/api/chats")
def api_list_chats(service: ServiceDep) -> list[dict[str, Any]]:
    return service.list_chats()


@router.post("/api/chats")
def api_create_chat(
    service: ServiceDep, body: dict[str, Any] | None = None
) -> dict[str, Any]:
    title = (body or {}).get("title") or ""
    return service.create_chat(str(title))


@router.get("/api/chats/{chat_id}")
def api_get_chat(chat_id: str, service: ServiceDep) -> dict[str, Any]:
    try:
        return service.get_chat_detail(chat_id)
    except ChatNotFound as exc:
        raise HTTPException(404, str(exc)) from exc


@router.delete("/api/chats/{chat_id}")
def api_delete_chat(chat_id: str, service: ServiceDep) -> dict[str, Any]:
    try:
        service.delete_chat(chat_id)
    except ChatNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except ChatBusy as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"ok": True}


def _turn_response(
    service: AgentService,
    executor: ThreadPoolExecutor,
    chat_id: str,
    text: str,
    *,
    team: bool,
    empty_detail: str,
) -> Any:
    text = text.strip()
    if not text:
        raise HTTPException(400, empty_detail)
    try:
        stream = service.start_turn(chat_id, text, team=team)
    except ChatBusy as exc:
        raise HTTPException(409, str(exc)) from exc
    except AgentUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    return sse_response(stream, executor)


@router.post("/api/chats/{chat_id}/messages")
async def api_send_message(
    chat_id: str, body: MessageIn, service: ServiceDep, executor: ExecutorDep
) -> Any:
    return _turn_response(
        service,
        executor,
        chat_id,
        body.text,
        team=False,
        empty_detail="消息不能为空",
    )


@router.post("/api/chats/{chat_id}/team")
async def api_team_task(
    chat_id: str, body: MessageIn, service: ServiceDep, executor: ExecutorDep
) -> Any:
    return _turn_response(
        service,
        executor,
        chat_id,
        body.text,
        team=True,
        empty_detail="任务不能为空",
    )


def create_app(service: AgentService | None = None) -> FastAPI:
    """构建 Web 应用;``service`` 可注入,便于测试时替换 agent 门面。"""
    agent_service = service or AgentService()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        agent_service.start()
        app.state.sse_executor = ThreadPoolExecutor(
            max_workers=8, thread_name_prefix="sse-worker"
        )
        try:
            yield
        finally:
            agent_service.stop()
            app.state.sse_executor.shutdown(wait=False)

    app = FastAPI(title="DeepSeek Harness Agent 平台", lifespan=lifespan)
    app.state.agent_service = agent_service
    app.include_router(router)
    install_static_routes(app)
    return app
