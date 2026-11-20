"""
系统与人设配置路由（/api/settings）
-----------------------------------
统一读写 API Key、人设口头禅、台湾腔音色、作息时间表、随机冒泡与唤醒词配置。
"""

import asyncio
from typing import Any
from fastapi import APIRouter

from app.core.settings_store import get_all_settings as load_all_settings, update_settings_batch
from app.schemas import SettingsUpdate
from app.services.scheduler_service import reload_schedule_jobs
from app.services.wakeword_service import wakeword_engine

router = APIRouter(prefix="/api/settings", tags=["Settings"])


@router.get("")
def get_all_settings() -> dict[str, Any]:
    """读取全部本地配置项（命中内存缓存）"""
    return load_all_settings()


@router.put("")
async def update_settings(payload: SettingsUpdate) -> dict[str, Any]:
    """批量更新配置项（递归深度合并 + 缓存失效，并在变更 schedule/wakeword 时自动热重载）"""
    updated = await asyncio.to_thread(update_settings_batch, payload.settings)

    if "schedule" in payload.settings:
        reload_schedule_jobs()

    if "wakeword" in payload.settings and isinstance(updated.get("wakeword"), dict):
        ww = updated["wakeword"]
        loop = asyncio.get_running_loop()
        await asyncio.to_thread(
            wakeword_engine.toggle,
            bool(ww.get("enabled", False)),
            str(ww.get("keyword", "") or "") or None,
            loop,
        )

    return updated
