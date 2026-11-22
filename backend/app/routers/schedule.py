"""
全天作息定时管家与 WebSocket 实时推送路由（/api/schedule & /ws/events）
----------------------------------------------------------------------
提供：
- WebSocket `/ws/events`：向桌宠浮窗与主控面板实时推送定时/随机冒泡事件
- GET `/api/schedule/status`：查询所有已注册作息任务与下次触发时间
- POST `/api/schedule/trigger`：模拟触发指定作息节点或随机冒泡（方便体验与验收）
- POST `/api/schedule/snooze`：点击「稍后再聊（15 分钟后）」延后提醒
- POST `/api/schedule/dnd`：一键切换免打扰开关并实时通知前端。
  开启免打扰时同时关闭离线语音唤醒。
"""

import asyncio
import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.local_auth import accept_authorized_websocket
from app.schemas import DndToggleRequest, ScheduleSnoozeRequest, ScheduleTriggerRequest
from app.services.event_bus import event_bus
from app.services.scheduler_service import (
    get_scheduler_status,
    set_dnd_enabled,
    snooze_proactive_event,
    trigger_proactive_event,
)
from app.services.wakeword_service import wakeword_engine

router = APIRouter(tags=["Schedule"])


@router.websocket("/ws/events")
async def websocket_events(websocket: WebSocket):
    """前端桌宠与主控面板的实时事件推送通道"""
    if not await accept_authorized_websocket(websocket):
        return
    await event_bus.connect(websocket, already_accepted=True)
    try:
        # 首次连接后立即发送一条握手状态，便于前端确认在线
        await websocket.send_json(
            {
                "type": "connected",
                "message": "灵儿实时陪伴通道已连通",
            }
        )
        while True:
            # 维持连接并处理心跳 ping、客户端身份声明（hello）与 UI 指令回执（ui_command_ack）
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_json({"type": "pong"})
                continue
            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue
            msg_type = str(msg.get("type") or "")
            if msg_type == "ping":
                await websocket.send_json({"type": "pong"})
            elif msg_type == "hello":
                await event_bus.set_client_role(websocket, str(msg.get("client") or "unknown"))
            elif msg_type == "ui_command_ack":
                command_id = str(msg.get("command_id") or "").strip()
                if command_id:
                    event_bus.resolve_ui_ack(command_id, msg)
    except WebSocketDisconnect:
        await event_bus.disconnect(websocket)
    except Exception:
        await event_bus.disconnect(websocket)


@router.get("/api/schedule/status")
def schedule_status():
    """获取当前全天作息调度状态、下次触发时间与免打扰开关"""
    return get_scheduler_status()


@router.post("/api/schedule/trigger")
async def simulate_schedule_trigger(payload: ScheduleTriggerRequest):
    """手动模拟触发一次定时节点或随机冒泡（用于测试与即时体验）"""
    return await trigger_proactive_event(payload.event_type, force=True)


@router.post("/api/schedule/snooze")
def snooze_nudge(payload: ScheduleSnoozeRequest):
    """点击「稍后再聊」后延后指定分钟数再次轻轻提醒"""
    return snooze_proactive_event(
        event_type=payload.event_type,
        delay_minutes=payload.delay_minutes,
    )


@router.post("/api/schedule/dnd")
async def toggle_dnd(payload: DndToggleRequest):
    """一键切换免打扰模式，并通过 WebSocket 同步给桌宠与面板。

    一旦开启免打扰，离线唤醒会一起关掉并停止听麦克风。
    关闭免打扰不会把唤醒自动打开，需要用户再手动开启。
    """
    cfg = set_dnd_enabled(payload.enabled)
    if payload.enabled:
        loop = asyncio.get_running_loop()
        await asyncio.to_thread(wakeword_engine.toggle, False, None, loop)
    await event_bus.broadcast(
        {
            "type": "dnd_changed",
            "enabled": bool(cfg["dnd_enabled"]),
            "wakeword_disabled": bool(payload.enabled),
        }
    )
    return {
        "dnd_enabled": bool(cfg["dnd_enabled"]),
        "wakeword_disabled": bool(payload.enabled),
    }
