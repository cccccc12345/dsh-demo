"""应用入口。

真正的实现分为两层:

- ``agent_platform.agent``:agent 核心(runtime、会话、turn、团队编排),不依赖 Web;
- ``agent_platform.web``:FastAPI/SSE/静态资源适配层。

启动方式保持不变:``uvicorn agent_platform.main:app``。
"""
from agent_platform.web import create_app

app = create_app()
