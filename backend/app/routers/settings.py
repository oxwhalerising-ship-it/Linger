"""
系统与人设配置路由（/api/settings）
-----------------------------------
统一读写 API Key、人设口头禅、台湾腔音色、作息时间表、随机冒泡与唤醒词配置。
"""

import asyncio
import json
from datetime import datetime
from typing import Any
from fastapi import APIRouter

from app.database import db_cursor
from app.schemas import SettingsUpdate
from app.services.scheduler_service import reload_schedule_jobs
from app.services.wakeword_service import wakeword_engine

router = APIRouter(prefix="/api/settings", tags=["Settings"])


def _deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """递归深度合并字典，避免局部更新嵌套配置（如 schedule.morning_plan.time）时误清空同级字段"""
    merged = dict(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(merged.get(k), dict):
            merged[k] = _deep_merge(merged[k], v)
        else:
            merged[k] = v
    return merged


@router.get("")
def get_all_settings() -> dict[str, Any]:
    """读取全部本地配置项"""
    result: dict[str, Any] = {}
    with db_cursor() as cur:
        cur.execute("SELECT key, value FROM settings ORDER BY key ASC;")
        for row in cur.fetchall():
            result[row["key"]] = json.loads(row["value"])
    return result


@router.put("")
async def update_settings(payload: SettingsUpdate) -> dict[str, Any]:
    """批量更新配置项（字典类型递归深度合并，并在变更 schedule/wakeword 时自动热重载）"""
    now_iso = datetime.now().isoformat(timespec="seconds")

    def _persist() -> dict[str, Any]:
        with db_cursor() as cur:
            for key, value in payload.settings.items():
                final_value = value
                if isinstance(value, dict):
                    cur.execute("SELECT value FROM settings WHERE key = ?;", (key,))
                    existing_row = cur.fetchone()
                    if existing_row:
                        try:
                            existing_obj = json.loads(existing_row["value"])
                            if isinstance(existing_obj, dict):
                                final_value = _deep_merge(existing_obj, value)
                        except (TypeError, ValueError):
                            pass
                cur.execute(
                    """
                    INSERT INTO settings (key, value, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        value = excluded.value,
                        updated_at = excluded.updated_at;
                    """,
                    (key, json.dumps(final_value, ensure_ascii=False), now_iso),
                )
        return get_all_settings()

    updated = await asyncio.to_thread(_persist)

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
