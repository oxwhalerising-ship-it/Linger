"""统一 OpenAI / AsyncOpenAI 客户端生命周期与低延迟思考档位缓存管理。

供 agent_brain、stt_service（ASR 润色）与 report_service（周/月报分析）共同复用，
彻底消除多处重复实例化、无超时请求、淘汰连接池泄漏以及缓存键大小写不一致问题。
"""

from __future__ import annotations

import threading
from contextlib import suppress
from typing import Any

from openai import AsyncOpenAI, OpenAI

_OPENAI_CLIENT_CACHE: dict[tuple[str, str], OpenAI] = {}
_ASYNC_OPENAI_CLIENT_CACHE: dict[tuple[str, str], AsyncOpenAI] = {}
_CLIENT_LOCK = threading.Lock()

# 缓存每个 (base_url.lower(), model.lower()) 实测可用的最优低思考档位：
# "disabled" | "effort_minimal" | "effort_low" | "none"
_FAST_THINK_MODE_CACHE: dict[tuple[str, str], str] = {}


def get_openai_client(api_key: str, base_url: str, timeout: float = 30.0) -> OpenAI:
    """获取复用长连接的同步 OpenAI 客户端（淘汰时主动关闭底层 httpx 连接池）。"""
    cache_key = (base_url.strip(), api_key.strip())
    with _CLIENT_LOCK:
        client = _OPENAI_CLIENT_CACHE.get(cache_key)
        if client is None:
            if len(_OPENAI_CLIENT_CACHE) >= 8:
                for old_client in _OPENAI_CLIENT_CACHE.values():
                    with suppress(Exception):
                        old_client.close()
                _OPENAI_CLIENT_CACHE.clear()
            client = OpenAI(api_key=cache_key[1], base_url=cache_key[0], timeout=timeout)
            _OPENAI_CLIENT_CACHE[cache_key] = client
        return client


def get_async_openai_client(api_key: str, base_url: str, timeout: float = 30.0) -> AsyncOpenAI:
    """获取复用长连接的异步 OpenAI 客户端。"""
    cache_key = (base_url.strip(), api_key.strip())
    with _CLIENT_LOCK:
        client = _ASYNC_OPENAI_CLIENT_CACHE.get(cache_key)
        if client is None:
            if len(_ASYNC_OPENAI_CLIENT_CACHE) >= 8:
                _ASYNC_OPENAI_CLIENT_CACHE.clear()
            client = AsyncOpenAI(api_key=cache_key[1], base_url=cache_key[0], timeout=timeout)
            _ASYNC_OPENAI_CLIENT_CACHE[cache_key] = client
        return client


async def close_all_llm_clients() -> None:
    """在应用退出时优雅关闭所有缓存的同步/异步 HTTP 客户端连接池。"""
    with _CLIENT_LOCK:
        sync_clients = list(_OPENAI_CLIENT_CACHE.values())
        async_clients = list(_ASYNC_OPENAI_CLIENT_CACHE.values())
        _OPENAI_CLIENT_CACHE.clear()
        _ASYNC_OPENAI_CLIENT_CACHE.clear()

    for client in sync_clients:
        with suppress(Exception):
            client.close()
    for client in async_clients:
        with suppress(Exception):
            await client.close()


def get_cached_fast_think_mode(base_url: str, model_name: str) -> str | None:
    """统一小写键读取已探测的低思考档位。"""
    return _FAST_THINK_MODE_CACHE.get((base_url.strip().lower(), model_name.strip().lower()))


def candidate_fast_think_modes(base_url: str, model_name: str) -> list[str]:
    """按厂商与模型系列返回低延迟思考档位尝试顺序（命中缓存后单次直达，零多余 400 往返）。"""
    cached = get_cached_fast_think_mode(base_url, model_name)
    if cached is not None:
        return [cached] if cached == "none" else [cached, "none"]

    lower_url = base_url.strip().lower()
    lower_model = model_name.strip().lower()

    if "generativelanguage.googleapis.com" in lower_url or lower_model.startswith("gemini"):
        return ["effort_minimal", "effort_low", "none"]
    if "open.bigmodel.cn" in lower_url or lower_model.startswith("glm"):
        if lower_model.startswith("glm-5"):
            return ["effort_low", "none"]
        return ["disabled", "effort_low", "none"]
    return ["none"]


def apply_think_mode(kwargs: dict[str, Any], mode: str) -> None:
    """将指定的低思考档位写入请求参数。"""
    kwargs.pop("reasoning_effort", None)
    kwargs.pop("extra_body", None)
    if mode == "disabled":
        kwargs["extra_body"] = {"thinking": {"type": "disabled"}}
    elif mode == "effort_minimal":
        kwargs["reasoning_effort"] = "minimal"
    elif mode == "effort_low":
        kwargs["reasoning_effort"] = "low"


async def create_async_completion_fast(
    client: AsyncOpenAI,
    base_kwargs: dict[str, Any],
    base_url: str,
    model_name: str,
):
    """带低思考档位自动探测与缓存的异步请求封装（遇到 400 自动滑向下一档并记忆最优档）。"""
    model_key = (base_url.strip().lower(), model_name.strip().lower())
    modes = candidate_fast_think_modes(base_url, model_name)
    last_exc: Exception | None = None

    for idx, mode in enumerate(modes):
        req_kwargs = dict(base_kwargs)
        apply_think_mode(req_kwargs, mode)
        try:
            result = await client.chat.completions.create(**req_kwargs)
            _FAST_THINK_MODE_CACHE[model_key] = mode
            return result
        except Exception as exc:
            last_exc = exc
            if getattr(exc, "status_code", None) == 400:
                if idx == len(modes) - 1 and "response_format" in req_kwargs:
                    req_kwargs.pop("response_format", None)
                    _FAST_THINK_MODE_CACHE[model_key] = "none"
                    return await client.chat.completions.create(**req_kwargs)
                continue
            raise

    if last_exc is not None:
        raise last_exc
    raise RuntimeError("模型调用失败")
