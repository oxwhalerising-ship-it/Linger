"""
灵儿本地后端服务入口
------------------
常驻 127.0.0.1:8765，给桌宠和主控面板提供对话、语音、习惯和日记。
"""

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.local_auth import LocalTokenMiddleware, ensure_local_token
from app.core.logging import get_logger
from app.database import init_db
from app.routers import chat, focus, habits, logs, memories, reports, schedule, settings, tasks, tools, voice, voice_call
from app.services.llm.client import close_all_llm_clients
from app.services.model_catalog import start_model_download_if_missing
from app.services.scheduler_service import shutdown_scheduler, start_scheduler
from app.services.tts_provider import FishAudioTTSProvider
from app.services.wakeword_service import wakeword_engine

logger = get_logger("main")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """初始化日记库和本机令牌，拉起作息与唤醒，并在后台补齐缺失的语音模型。"""
    init_db()
    ensure_local_token()
    start_scheduler()
    start_model_download_if_missing()
    loop = asyncio.get_running_loop()
    await asyncio.to_thread(wakeword_engine.start_if_enabled, loop)
    logger.info("灵儿后端已启动")
    try:
        yield
    finally:
        await asyncio.to_thread(wakeword_engine.stop)
        shutdown_scheduler()
        await FishAudioTTSProvider.close_session()
        await close_all_llm_clients()
        logger.info("灵儿后端已关闭")


app = FastAPI(
    title="灵儿本地后端",
    description="治愈系桌面小管家的本地 API",
    version="0.4.0",
    lifespan=lifespan,
)

# 先挂令牌中间件，再挂 CORS，这样 401 响应仍然带允许的 Origin。
app.add_middleware(LocalTokenMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "null",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册核心业务路由
app.include_router(habits.router)
app.include_router(tasks.router)
app.include_router(focus.router)
app.include_router(logs.router)
app.include_router(memories.router)
app.include_router(reports.router)
app.include_router(schedule.router)
app.include_router(settings.router)
app.include_router(chat.router)
app.include_router(voice.router)
app.include_router(voice_call.router)
app.include_router(tools.router)


@app.get("/api/health")
async def health_check():
    """
    健康检查接口
    供 Electron 前端启动时探测本地后端是否已经准备就绪。
    """
    return {
        "status": "ok",
        "service": "Linger",
        "version": "0.4.0",
        "voice_call": True,
        "greeting": "欸～灵儿后端已经顺利启动啰，随时准备陪你！",
        "server_time": datetime.now().isoformat(timespec="seconds"),
    }
