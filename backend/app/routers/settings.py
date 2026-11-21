"""
系统与人设配置路由（/api/settings）
-----------------------------------
统一读写 API Key、人设口头禅、台湾腔音色、作息时间表、随机冒泡与唤醒词配置。
"""

import asyncio
from typing import Any
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, SecretStr
from app.services.llm.client import get_openai_client

from app.core.settings_store import get_all_settings as load_all_settings, update_settings_batch
from app.schemas import SettingsUpdate
from app.services.scheduler_service import load_schedule_settings, reload_schedule_jobs
from app.services.wakeword_service import wakeword_engine

router = APIRouter(prefix="/api/settings", tags=["Settings"])


@router.get("")
def get_all_settings() -> dict[str, Any]:
    """读取全部本地配置项（命中内存缓存）"""
    return load_all_settings()


@router.put("")
async def update_settings(payload: SettingsUpdate) -> dict[str, Any]:
    """批量更新配置项（递归深度合并 + 缓存失效，并在变更 schedule/wakeword 时自动热重载）"""
    current_dnd = bool(load_schedule_settings().get("dnd_enabled"))
    schedule_patch = payload.settings.get("schedule")
    if isinstance(schedule_patch, dict) and "dnd_enabled" in schedule_patch:
        next_dnd = bool(schedule_patch["dnd_enabled"])
    else:
        next_dnd = current_dnd
    turning_dnd_on = next_dnd and not current_dnd

    updated = await asyncio.to_thread(update_settings_batch, payload.settings)

    if "schedule" in payload.settings:
        reload_schedule_jobs()

    wake_patch = payload.settings.get("wakeword")
    wake_patch = wake_patch if isinstance(wake_patch, dict) else None
    # 打开免打扰，或免打扰期间又把唤醒写成开启，都以关闭唤醒为准。
    force_wake_off = turning_dnd_on or (
        next_dnd and wake_patch is not None and bool(wake_patch.get("enabled", False))
    )
    loop = asyncio.get_running_loop()
    if force_wake_off:
        keyword = None
        if wake_patch and wake_patch.get("keyword"):
            keyword = str(wake_patch.get("keyword"))
        await asyncio.to_thread(wakeword_engine.toggle, False, keyword, loop)
    elif wake_patch is not None and isinstance(updated.get("wakeword"), dict):
        ww = updated["wakeword"]
        await asyncio.to_thread(
            wakeword_engine.toggle,
            bool(ww.get("enabled", False)),
            str(ww.get("keyword", "") or "") or None,
            loop,
        )

    return updated

class ModelProbe(BaseModel):
    model: str
    base_url: str
    api_key: SecretStr

@router.post("/test-model")
def test_model(payload: ModelProbe):
    try:
        client = get_openai_client(payload.api_key.get_secret_value(), payload.base_url, timeout=12)
        client.with_options(max_retries=0).chat.completions.create(
            model=payload.model, messages=[{"role":"user","content":"Reply OK."}])
    except Exception as exc:
        raise HTTPException(502, "连接失败，请检查模型、服务地址和密钥") from exc
    return {"connected": True}
