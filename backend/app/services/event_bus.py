"""
WebSocket 实时事件推送总线（Event Bus）
--------------------------------------
负责维护所有连接到 `/ws/events` 的前端窗口（桌宠浮窗 + 主控面板），
当定时作息节点、随机冒泡、或后续 Step 7 语音唤醒触发时，
第一时间将事件广播给桌面端，实现桌宠主动探头与语音陪伴。
"""

import asyncio
from typing import Any
from fastapi import WebSocket


class EventBusManager:
    """轻量级异步 WebSocket 连接池与广播器"""

    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket, *, already_accepted: bool = False) -> None:
        if not already_accepted:
            await websocket.accept()
        async with self._lock:
            self._connections.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections.discard(websocket)

    @property
    def active_count(self) -> int:
        return len(self._connections)

    async def broadcast(self, event: dict[str, Any]) -> int:
        """向所有在线客户端广播 JSON 事件，并自动清理已断开的连接"""
        async with self._lock:
            targets = list(self._connections)

        delivered = 0
        stale: list[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_json(event)
                delivered += 1
            except Exception:
                stale.append(ws)

        if stale:
            async with self._lock:
                for ws in stale:
                    self._connections.discard(ws)

        return delivered


# 全局单例事件总线
event_bus = EventBusManager()
