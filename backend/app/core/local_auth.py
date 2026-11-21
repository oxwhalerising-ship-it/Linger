"""本机回环接口的共享令牌。

Electron 和 FastAPI 共用 data/linger.token。浏览器页面拿不到这个文件，
所以随便打开的网页不能读日记或改设置。同一 Windows 用户仍能读到该文件，
这只挡住本机上的网页和其他不知道令牌的进程。
"""

from __future__ import annotations

import json
import secrets
from typing import Any

from fastapi import WebSocket

from app import database

_TOKEN: str | None = None
_AUTH_PROTOCOL_PREFIX = "linger-auth."


def reset_token_cache() -> None:
    """测试用：丢掉内存中的令牌，下次按当前数据目录重新读取。"""
    global _TOKEN
    _TOKEN = None


def token_file():
    return database.DATA_DIR / "linger.token"


def ensure_local_token() -> str:
    """启动时读取或创建令牌。已有文件保持不变，避免重启后桌面端失效。"""
    global _TOKEN
    path = token_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        existing = path.read_text(encoding="utf-8").strip()
        if existing:
            _TOKEN = existing
            return existing
    generated = secrets.token_urlsafe(32)
    path.write_text(generated, encoding="utf-8")
    _TOKEN = generated
    return generated


def current_token() -> str | None:
    return _TOKEN


def token_matches(presented: str | None) -> bool:
    expected = _TOKEN
    if not expected or not presented:
        return False
    try:
        return secrets.compare_digest(presented, expected)
    except Exception:
        return False


def token_from_headers(headers: dict[str, str]) -> str | None:
    direct = (headers.get("x-linger-token") or "").strip()
    if direct:
        return direct
    authorization = headers.get("authorization") or ""
    if authorization.lower().startswith("bearer "):
        bearer = authorization[7:].strip()
        if bearer:
            return bearer
    return None


def token_from_websocket(websocket: WebSocket) -> str | None:
    protocol_header = websocket.headers.get("sec-websocket-protocol") or ""
    for part in protocol_header.split(","):
        candidate = part.strip()
        if candidate.startswith(_AUTH_PROTOCOL_PREFIX):
            token = candidate[len(_AUTH_PROTOCOL_PREFIX) :].strip()
            if token:
                return token
    return token_from_headers({k.lower(): v for k, v in websocket.headers.items()})


async def accept_authorized_websocket(websocket: WebSocket) -> bool:
    """校验通过后才 accept，并回显客户端带来的子协议，否则浏览器会直接断开。"""
    token = token_from_websocket(websocket)
    if not token_matches(token):
        await websocket.close(code=1008)
        return False
    await websocket.accept(subprotocol=f"{_AUTH_PROTOCOL_PREFIX}{token}")
    return True


class LocalTokenMiddleware:
    """HTTP 请求必须带 X-Linger-Token。预检 OPTIONS 放行，交给 CORS 处理。"""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope.get("type") == "http" and scope.get("method") != "OPTIONS":
            header_map: dict[str, str] = {}
            for key, value in scope.get("headers") or []:
                header_map[key.decode("latin1").lower()] = value.decode("latin1")
            if not token_matches(token_from_headers(header_map)):
                body = json.dumps({"detail": "本地鉴权失败"}, ensure_ascii=False).encode("utf-8")
                await send(
                    {
                        "type": "http.response.start",
                        "status": 401,
                        "headers": [
                            (b"content-type", b"application/json; charset=utf-8"),
                            (b"content-length", str(len(body)).encode("ascii")),
                        ],
                    }
                )
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)
