"""统一系统配置仓库（带线程安全内存缓存 + 深度合并写入失效）。

消除各路由/服务重复打开 SQLite 查询 settings 表的开销：
单轮语音通话此前会查询 settings 表 5~6 次，接入内存缓存后降至 0 次磁盘/SQLite 读取。
"""

from __future__ import annotations

import copy
import json
import threading
from datetime import datetime
from typing import Any

from app.core.utils import deep_merge
from app.database import DEFAULT_SETTINGS, db_cursor

_CACHE_LOCK = threading.RLock()
_SETTINGS_CACHE: dict[str, Any] | None = None


def invalidate_settings_cache() -> None:
    """手动失效内存缓存（如数据库重置后）。"""
    global _SETTINGS_CACHE
    with _CACHE_LOCK:
        _SETTINGS_CACHE = None


def get_all_settings() -> dict[str, Any]:
    """读取全部配置（优先命中内存缓存，返回深拷贝防止调用方意外篡改缓存）。"""
    global _SETTINGS_CACHE
    with _CACHE_LOCK:
        if _SETTINGS_CACHE is None:
            loaded: dict[str, Any] = {}
            with db_cursor() as cur:
                cur.execute("SELECT key, value FROM settings ORDER BY key ASC;")
                for row in cur.fetchall():
                    loaded[row["key"]] = json.loads(row["value"])
            _SETTINGS_CACHE = loaded
        return copy.deepcopy(_SETTINGS_CACHE)


def get_setting(key: str, default: Any = None) -> Any:
    """读取单个顶层配置项，缺失时回退 DEFAULT_SETTINGS 或调用方默认值。"""
    all_cfg = get_all_settings()
    if key in all_cfg:
        return all_cfg[key]
    if default is not None:
        return copy.deepcopy(default)
    if key in DEFAULT_SETTINGS:
        return copy.deepcopy(DEFAULT_SETTINGS[key])
    return None


def update_settings_batch(patch: dict[str, Any]) -> dict[str, Any]:
    """批量更新配置项（字典类型自动递归深度合并），同步刷新内存缓存。"""
    global _SETTINGS_CACHE
    now_iso = datetime.now().isoformat(timespec="seconds")

    with _CACHE_LOCK:
        with db_cursor() as cur:
            for key, value in patch.items():
                final_value = value
                if isinstance(value, dict):
                    cur.execute("SELECT value FROM settings WHERE key = ?;", (key,))
                    existing_row = cur.fetchone()
                    if existing_row:
                        try:
                            existing_obj = json.loads(existing_row["value"])
                            if isinstance(existing_obj, dict):
                                final_value = deep_merge(existing_obj, value)
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
        _SETTINGS_CACHE = None
        return get_all_settings()
