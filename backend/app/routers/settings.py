"""
系统与人设配置路由（/api/settings）
-----------------------------------
统一读写 API Key、人设口头禅、台湾腔音色、作息时间表、随机冒泡与唤醒词配置。
"""

import json
from datetime import datetime
from typing import Any
from fastapi import APIRouter

from app.database import db_cursor
from app.schemas import SettingsUpdate
from app.services.scheduler_service import reload_schedule_jobs

router = APIRouter(prefix="/api/settings", tags=["Settings"])


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
def update_settings(payload: SettingsUpdate) -> dict[str, Any]:
    """批量更新配置项（字典类型自动与现有值浅合并，防止局部更新误清空其他字段）"""
    now_iso = datetime.now().isoformat(timespec="seconds")
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
                            final_value = {**existing_obj, **value}
                    except Exception:
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
    if "schedule" in payload.settings:
        reload_schedule_jobs()
    return get_all_settings()
