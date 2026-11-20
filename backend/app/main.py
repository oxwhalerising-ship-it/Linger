"""
TaiwanBot 本地后端服务入口
--------------------------
Step 1：搭建 FastAPI 基础骨架与 /api/health 健康检查
Step 2：接入 SQLite 本地数据库、习惯/复盘/记忆/配置 CRUD 与 Markdown 自动归档引擎
"""

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.logging import get_logger
from app.database import init_db
from app.routers import chat, habits, logs, memories, reports, schedule, settings, voice, voice_call
from app.services.llm.client import close_all_llm_clients
from app.services.scheduler_service import shutdown_scheduler, start_scheduler
from app.services.stt_service import close_fish_asr_session
from app.services.tts_provider import FishAudioTTSProvider
from app.services.wakeword_service import wakeword_engine

logger = get_logger("main")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """FastAPI 生命周期钩子：初始化 SQLite、启动全天作息定时管家与本地唤醒监听，退出时优雅停止"""
    init_db()
    start_scheduler()
    loop = asyncio.get_running_loop()
    await asyncio.to_thread(wakeword_engine.start_if_enabled, loop)
    logger.info("TaiwanBot 后端服务启动就绪")
    try:
        yield
    finally:
        await asyncio.to_thread(wakeword_engine.stop)
        shutdown_scheduler()
        await FishAudioTTSProvider.close_session()
        await close_fish_asr_session()
        await close_all_llm_clients()
        logger.info("TaiwanBot 后端服务已优雅关闭")


# 初始化 FastAPI 应用实例
app = FastAPI(
    title="TaiwanBot 本地小管家后端",
    description="台湾腔治愈系自我管理桌面小精灵的本地 API 服务",
    version="0.3.0",
    lifespan=lifespan,
)

# 配置跨域（CORS），允许 Electron 开发期 Vite 页面（localhost:5173）和打包后的本地页面访问后端
# 本服务不使用 Cookie 鉴权，关闭 allow_credentials 以降低本地 Origin: null 风险
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "null",  # Electron 加载本地 file:// 协议时的 Origin
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册核心业务路由
app.include_router(habits.router)
app.include_router(logs.router)
app.include_router(memories.router)
app.include_router(reports.router)
app.include_router(schedule.router)
app.include_router(settings.router)
app.include_router(chat.router)
app.include_router(voice.router)
app.include_router(voice_call.router)


@app.get("/api/health")
async def health_check():
    """
    健康检查接口
    供 Electron 前端启动时探测本地后端是否已经准备就绪。
    """
    return {
        "status": "ok",
        "service": "TaiwanBot Backend",
        "version": "0.3.0",
        "voice_call": True,
        "greeting": "欸～灵儿后端已经顺利启动啰，随时准备陪你！",
        "server_time": datetime.now().isoformat(timespec="seconds"),
    }
