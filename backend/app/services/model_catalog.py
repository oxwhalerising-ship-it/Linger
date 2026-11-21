"""本地语音模型清单。第一次启动时补齐缺失的 SenseVoice Small 和唤醒词模型。"""

from __future__ import annotations

import glob
import json
import sys
import tarfile
import tempfile
import threading
import urllib.request
from pathlib import Path
from typing import Any

from app.core.logging import get_logger
from app.database import DATA_DIR, MODELS_MANIFEST

logger = get_logger("model_catalog")

_LOCK = threading.Lock()
_STATE: dict[str, Any] = {
    "downloading": False,
    "error": None,
}


def _load_manifest() -> list[dict[str, Any]]:
    if not MODELS_MANIFEST.is_file():
        return []
    payload = json.loads(MODELS_MANIFEST.read_text(encoding="utf-8"))
    models = payload.get("models") or []
    return [item for item in models if isinstance(item, dict)]


def _resolve_data_path(relative: str) -> Path:
    path = Path(relative)
    if path.parts and path.parts[0] == "data":
        return DATA_DIR.joinpath(*path.parts[1:])
    return DATA_DIR / path


def _is_installed(model: dict[str, Any]) -> bool:
    check_file = model.get("check_file")
    if isinstance(check_file, str):
        return _resolve_data_path(check_file).is_file()
    check_glob = model.get("check_glob")
    if isinstance(check_glob, str):
        return len(glob.glob(str(_resolve_data_path(check_glob)))) > 0
    return False


def get_model_status() -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    missing: list[str] = []
    if not MODELS_MANIFEST.is_file():
        return {
            "items": [],
            "missing": [],
            "downloading": bool(_STATE["downloading"]),
            "error": f"找不到模型清单：{MODELS_MANIFEST}",
        }
    for model in _load_manifest():
        ready = _is_installed(model)
        model_id = str(model.get("id") or "")
        items.append(
            {
                "id": model_id,
                "name": model.get("name") or model_id,
                "ready": ready,
                "description": model.get("description") or "",
            }
        )
        if model_id and not ready:
            missing.append(model_id)
    return {
        "items": items,
        "missing": missing,
        "downloading": bool(_STATE["downloading"]),
        "error": _STATE["error"],
    }


def _download_tar_bz2(model: dict[str, Any]) -> None:
    target_dir = _resolve_data_path(str(model["target_dir"]))
    target_dir.mkdir(parents=True, exist_ok=True)
    url = str(model["url"])
    logger.info("开始下载本地模型 %s", model.get("name") or model.get("id"))
    with tempfile.NamedTemporaryFile(suffix=".tar.bz2", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        urllib.request.urlretrieve(url, tmp_path)
        with tarfile.open(tmp_path, "r:bz2") as tar:
            if sys.version_info >= (3, 12):
                tar.extractall(path=target_dir, filter="data")
            else:
                tar.extractall(path=target_dir)
    finally:
        tmp_path.unlink(missing_ok=True)


def download_missing_models(only: list[str] | None = None) -> list[str]:
    """同步下载缺失模型。返回实际开始下载的 id。"""
    selected = set(only or [])
    started: list[str] = []
    for model in _load_manifest():
        model_id = str(model.get("id") or "")
        if selected and model_id not in selected:
            continue
        if _is_installed(model):
            continue
        kind = model.get("type")
        if kind == "tar.bz2":
            _download_tar_bz2(model)
        else:
            logger.warning("跳过未知模型类型 %s (%s)", kind, model_id)
            continue
        started.append(model_id)
        logger.info("本地模型已就绪 %s", model_id)
    return started


def _download_worker() -> None:
    try:
        download_missing_models()
        with _LOCK:
            _STATE["error"] = None
    except Exception as exc:
        logger.warning("本地语音模型下载失败：%s", exc)
        with _LOCK:
            _STATE["error"] = str(exc)[:300]
    finally:
        with _LOCK:
            _STATE["downloading"] = False


def start_model_download_if_missing() -> bool:
    """缺失时在后台补模型。已经在下载或都已就绪时什么都不做。"""
    status = get_model_status()
    if not status["missing"]:
        return False
    with _LOCK:
        if _STATE["downloading"]:
            return False
        _STATE["downloading"] = True
        _STATE["error"] = None
    threading.Thread(target=_download_worker, name="model-download", daemon=True).start()
    logger.info("正在后台补齐本地语音模型：%s", "、".join(status["missing"]))
    return True
