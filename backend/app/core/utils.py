"""后端通用校验、合并与原子文件写入工具。"""

from __future__ import annotations

import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import HTTPException

_DATE_FORMAT = "%Y-%m-%d"
_MONTH_FORMAT = "%Y-%m"


def validate_date_str(value: str) -> str:
    """严格校验公历 YYYY-MM-DD 日期，非法则抛 HTTP 400。"""
    try:
        return datetime.strptime(value.strip(), _DATE_FORMAT).strftime(_DATE_FORMAT)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="日期格式必须为合法的 YYYY-MM-DD") from exc


def validate_month_str(value: str) -> str:
    """严格校验公历 YYYY-MM 月份，非法则抛 HTTP 400。"""
    try:
        return datetime.strptime(value.strip(), _MONTH_FORMAT).strftime(_MONTH_FORMAT)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="月份格式必须为合法的 YYYY-MM") from exc


def is_strict_int(value: Any) -> bool:
    """判断是否为纯整数（排除 Python 中 bool 是 int 子类的陷阱）。"""
    return isinstance(value, int) and not isinstance(value, bool)


def deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """递归深度合并字典，避免局部更新嵌套配置时误清空同级字段。"""
    merged = dict(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(merged.get(k), dict):
            merged[k] = deep_merge(merged[k], v)
        else:
            merged[k] = v
    return merged


def strip_json_fences(raw: str) -> str:
    """剥离 LLM 返回的 ```json ... ``` 代码块围栏。"""
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text)
    return text.strip()


def atomic_write_text(target_path: Path, content: str, encoding: str = "utf-8") -> None:
    """通过唯一临时文件 + os.replace 原子写入文本，避免并发写截断。"""
    target_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = target_path.with_name(f".{target_path.name}.{os.getpid()}.{id(content)}.tmp")
    try:
        tmp_path.write_text(content, encoding=encoding)
        os.replace(tmp_path, target_path)
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
