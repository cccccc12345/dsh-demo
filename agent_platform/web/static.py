"""前端静态资源与 SPA 入口(仅 Web 层关心)。"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

PACKAGE_DIR = Path(__file__).resolve().parents[1]
STATIC_DIR = PACKAGE_DIR / "static"


def install_static_routes(
    app: FastAPI, static_dir: Path = STATIC_DIR
) -> None:
    @app.get("/static/assets/{filename}")
    def static_asset(filename: str) -> Response:
        """静态资源兜底:旧 index.html 引用已删除的 hash 时,让页面自动刷新。

        Vite 构建默认会清空 static/,浏览器若还拿着上一版 index.html,就会请求
        已删除的 index-*.js,表现为整页白屏。这里对缺失的 JS/CSS 返回一个
        刷新脚本/空样式,避免白屏,并让页面重新拿到当前 index。
        """
        assets_dir = (static_dir / "assets").resolve()
        path = (assets_dir / filename).resolve()
        if assets_dir not in path.parents:
            raise HTTPException(404, "asset not found")
        if path.is_file():
            return FileResponse(path)
        if filename.endswith(".js"):
            return Response(
                "window.location.replace(window.location.pathname + '?reload=' + Date.now());",
                media_type="application/javascript",
                headers={"Cache-Control": "no-store"},
            )
        if filename.endswith(".css"):
            return Response("", media_type="text/css", headers={"Cache-Control": "no-store"})
        raise HTTPException(404, "asset not found")

    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    @app.get("/")
    def index() -> FileResponse:
        # 前端产物带哈希、可长缓存;但 index.html 必须 no-store,
        # 避免浏览器拿着旧哈希引用导致新构建后整页 404 显空白。
        return FileResponse(
            static_dir / "index.html", headers={"Cache-Control": "no-store"}
        )
