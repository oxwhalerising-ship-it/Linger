"""
WebSocket 实时事件推送与双向控制总线（Event Bus）
----------------------------------------------
负责维护所有连接到 `/ws/events` 的前端窗口（桌宠浮窗 + 主控面板）：
1. 单向广播：定时作息节点、随机冒泡、语音唤醒、免打扰状态、以及工具写入后的 `data_changed` 刷新事件。
2. 双向 UI 控制（带超时 ACK 回执）：灵儿调用工具操控前端番茄钟或切换控制面板页面时，
   通过 `dispatch_ui_command` 发出带 `command_id` 的指令并等待前端回执，支持冲突保护与超时降级。
"""

from __future__ import annotations

import asyncio
from typing import Any
from uuid import uuid4

from fastapi import WebSocket


class EventBusManager:
    """轻量级异步 WebSocket 连接池、事件广播器与双向 UI 指令调度器"""

    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()
        self._client_roles: dict[WebSocket, str] = {}
        self._pending_acks: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._lock = asyncio.Lock()

    async def connect(
        self,
        websocket: WebSocket,
        *,
        already_accepted: bool = False,
        role: str = "unknown",
    ) -> None:
        if not already_accepted:
            await websocket.accept()
        async with self._lock:
            self._connections.add(websocket)
            self._client_roles[websocket] = role

    async def set_client_role(self, websocket: WebSocket, role: str) -> None:
        clean_role = str(role or "unknown").strip().lower() or "unknown"
        async with self._lock:
            if websocket in self._connections:
                self._client_roles[websocket] = clean_role

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections.discard(websocket)
            self._client_roles.pop(websocket, None)

    @property
    def active_count(self) -> int:
        return len(self._connections)

    async def has_client_role(self, role: str) -> bool:
        target = role.strip().lower()
        async with self._lock:
            return any(r == target for r in self._client_roles.values())

    async def _send_to_targets(self, targets: list[WebSocket], event: dict[str, Any]) -> int:
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
                    self._client_roles.pop(ws, None)

        return delivered

    async def broadcast(self, event: dict[str, Any]) -> int:
        """向所有在线客户端广播 JSON 事件，并自动清理已断开的连接"""
        async with self._lock:
            targets = list(self._connections)
        return await self._send_to_targets(targets, event)

    async def notify_data_changed(
        self,
        domains: list[str],
        *,
        source: str = "tool",
        detail: dict[str, Any] | None = None,
    ) -> int:
        """通知前端面板指定业务域数据已更新，触发无刷新即时重载"""
        clean_domains = sorted({str(d).strip() for d in domains if str(d).strip()})
        if not clean_domains:
            return 0
        payload: dict[str, Any] = {
            "type": "data_changed",
            "domains": clean_domains,
            "source": source,
        }
        if detail:
            payload["detail"] = detail
        return await self.broadcast(payload)

    def resolve_ui_ack(self, command_id: str, ack_payload: dict[str, Any]) -> bool:
        """收到前端 `ui_command_ack` 后唤醒对应的等待协程"""
        fut = self._pending_acks.get(command_id)
        if fut is None or fut.done():
            return False
        fut.set_result(ack_payload)
        return True

    async def dispatch_ui_command(
        self,
        action: str,
        payload: dict[str, Any] | None = None,
        *,
        timeout: float = 2.0,
        prefer_role: str | None = "dashboard",
    ) -> dict[str, Any]:
        """向前端发送 UI 控制指令并等待带超时保护的 ACK 回执。

        若存在匹配 `prefer_role`（默认 `dashboard`）的连接，则优先只发给该类客户端，
        避免桌宠与面板重复执行同一条 UI 指令；若未注册角色则回退广播全部在线连接。
        """
        async with self._lock:
            if prefer_role:
                role_targets = [
                    ws
                    for ws in self._connections
                    if self._client_roles.get(ws) == prefer_role
                ]
            else:
                role_targets = []
            targets = role_targets if role_targets else list(self._connections)

        if not targets:
            return {
                "ok": False,
                "timeout": False,
                "connected_clients": 0,
                "error": "控制面板尚未连接，请先打开灵儿主控面板后再试。",
            }

        command_id = uuid4().hex
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending_acks[command_id] = fut

        event = {
            "type": "ui_command",
            "command_id": command_id,
            "action": action,
            "payload": payload or {},
        }

        try:
            delivered = await self._send_to_targets(targets, event)
            if delivered == 0:
                return {
                    "ok": False,
                    "timeout": False,
                    "connected_clients": 0,
                    "error": "控制面板连接已断开，指令未能送达。",
                }
            ack = await asyncio.wait_for(fut, timeout=max(0.2, float(timeout)))
            return {
                "ok": bool(ack.get("ok", True)),
                "timeout": False,
                "connected_clients": delivered,
                "result": ack.get("result") if isinstance(ack.get("result"), dict) else {},
                "error": str(ack.get("error") or ""),
            }
        except asyncio.TimeoutError:
            return {
                "ok": False,
                "timeout": True,
                "connected_clients": len(targets),
                "error": "已发出面板指令，但超过等待时间未收到控制面板回执。",
            }
        finally:
            self._pending_acks.pop(command_id, None)


# 全局单例事件总线
event_bus = EventBusManager()
