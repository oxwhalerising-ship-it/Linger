"""
全天作息定时管家与 WebSocket 实时推送路由（/api/schedule & /ws/events）
----------------------------------------------------------------------
提供：
- WebSocket `/ws/events`：向桌宠浮窗与主控面板实时推送定时/随机冒泡事件
- GET `/api/schedule/status`：查询所有已注册作息任务与下次触发时间
- POST `/api/schedule/trigger`：模拟触发指定作息节点或随机冒泡（方便体验与验收）
- POST `/api/schedule/snooze`：点击「稍后再聊（15 分钟后）」延后提醒
- POST `/api/schedule/dnd`：一键切换免打扰开关并实时通知前端
"""

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
            # 维持连接并响应客户端心跳 ping
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_json({"type": "pong"})
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
    """一键切换免打扰模式，并通过 WebSocket 同步给桌宠与面板"""
    cfg = set_dnd_enabled(payload.enabled)
    await event_bus.broadcast(
        {
            "type": "dnd_changed",
            "enabled": bool(cfg["dnd_enabled"]),
        }
    )
    return {"dnd_enabled": bool(cfg["dnd_enabled"])}
