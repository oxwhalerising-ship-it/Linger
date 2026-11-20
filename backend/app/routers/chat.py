"""
台湾腔小管家对话与历史消息管理路由（/api/chat）
--------------------------------------------
提供：
1. POST /api/chat：发送文本对话、生成台湾腔回复并静默归档
2. GET  /api/chat/history：按日期读取聊天流（兼容主聊天室）
3. 历史消息全量增删改查（统一 SQLite 库，按 channel='text' 文本对话 / channel='voice' 语音对话分区）：
   - GET    /api/chat/messages/summary      按日期与渠道统计汇总
   - GET    /api/chat/messages              多维检索（渠道 / 日期 / 角色 / 关键词 / 排序 / 分页）
   - POST   /api/chat/messages              手动新增历史记录（补录文本或语音对话）
   - PATCH  /api/chat/messages/{message_id} 编辑单条记录内容、角色、分类或日期
   - DELETE /api/chat/messages/{message_id} 删除单条记录
   - POST   /api/chat/messages/batch-delete 批量勾选删除或按日期/渠道清理
"""

from datetime import datetime
from typing import Literal, Optional
from fastapi import APIRouter, HTTPException, Query

from app.database import db_cursor
from app.schemas import (
    ChatRequest,
    MessageBatchDeleteRequest,
    MessageCreate,
    MessageUpdate,
)
from app.services.agent_brain import run_agent_chat

router = APIRouter(prefix="/api/chat", tags=["Chat"])

_DATE_FORMAT = "%Y-%m-%d"


def _validate_date_str(value: str) -> str:
    try:
        return datetime.strptime(value.strip(), _DATE_FORMAT).strftime(_DATE_FORMAT)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="日期格式须为 YYYY-MM-DD") from exc


def _row_to_message_dict(row) -> dict:
    item = dict(row)
    # 兜底确保 channel 始终为 text 或 voice
    if item.get("channel") not in ("text", "voice"):
        item["channel"] = "voice" if item.get("trigger_type") == "voice_call" else "text"
    return item


@router.post("")
def chat_with_bot(payload: ChatRequest):
    """与台湾腔小管家对话，并自动触发静默归档与 Markdown 更新"""
    validated_date = _validate_date_str(payload.date) if payload.date else None
    try:
        return run_agent_chat(
            user_message=payload.message,
            date_str=validated_date,
            mode=payload.mode,
            trigger_type=payload.trigger_type,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"对话大脑调用失败：{exc}") from exc


@router.get("/history")
def get_chat_history(
    date: Optional[str] = Query(default=None, description="日期 YYYY-MM-DD，默认当天"),
    channel: Literal["all", "text", "voice"] = Query(default="all", description="对话渠道筛选"),
    limit: int = Query(default=100, ge=1, le=500),
):
    """读取指定日期的对话历史记录"""
    target_date = _validate_date_str(date) if date else datetime.now().strftime(_DATE_FORMAT)
    clauses = ["session_date = ?"]
    params: list = [target_date]
    if channel != "all":
        clauses.append("channel = ?")
        params.append(channel)
    params.append(limit)

    with db_cursor() as cur:
        cur.execute(
            f"""
            SELECT id, session_date, channel, role, content, trigger_type, created_at, updated_at, duration_ms
            FROM messages
            WHERE {' AND '.join(clauses)}
            ORDER BY id ASC
            LIMIT ?;
            """,
            tuple(params),
        )
        rows = [_row_to_message_dict(r) for r in cur.fetchall()]
    return {"date": target_date, "channel": channel, "messages": rows}


@router.get("/messages/summary")
def get_messages_summary():
    """汇总全部历史消息数量（总计 / 文本对话 / 语音对话）及按日期分组列表"""
    with db_cursor() as cur:
        cur.execute(
            """
            SELECT
                COUNT(*) AS total_count,
                SUM(CASE WHEN channel = 'text' THEN 1 ELSE 0 END) AS text_count,
                SUM(CASE WHEN channel = 'voice' THEN 1 ELSE 0 END) AS voice_count
            FROM messages;
            """
        )
        tot = cur.fetchone()
        totals = {
            "all": int(tot["total_count"] or 0),
            "text": int(tot["text_count"] or 0),
            "voice": int(tot["voice_count"] or 0),
        }

        cur.execute(
            """
            SELECT
                agg.session_date AS date,
                agg.total_count,
                agg.text_count,
                agg.voice_count,
                agg.last_at,
                latest.content AS last_preview
            FROM (
                SELECT
                    session_date,
                    COUNT(*) AS total_count,
                    SUM(CASE WHEN channel = 'text' THEN 1 ELSE 0 END) AS text_count,
                    SUM(CASE WHEN channel = 'voice' THEN 1 ELSE 0 END) AS voice_count,
                    MAX(created_at) AS last_at,
                    MAX(id) AS last_id
                FROM messages
                GROUP BY session_date
            ) agg
            LEFT JOIN messages latest ON latest.id = agg.last_id
            ORDER BY agg.session_date DESC;
            """
        )
        dates = [
            {
                "date": r["date"],
                "total_count": int(r["total_count"] or 0),
                "text_count": int(r["text_count"] or 0),
                "voice_count": int(r["voice_count"] or 0),
                "last_at": r["last_at"] or "",
                "last_preview": str(r["last_preview"] or "")[:60],
            }
            for r in cur.fetchall()
        ]

    return {"totals": totals, "dates": dates}


@router.get("/messages")
def list_messages(
    channel: Literal["all", "text", "voice"] = Query(default="all", description="all=全部, text=文本对话, voice=语音对话"),
    date: Optional[str] = Query(default=None, description="按日期筛选 YYYY-MM-DD，不传则跨全库搜索"),
    role: Optional[Literal["user", "assistant", "system"]] = Query(default=None, description="按角色筛选"),
    q: Optional[str] = Query(default=None, max_length=200, description="关键词模糊检索"),
    order: Literal["asc", "desc"] = Query(default="desc", description="排序方向：asc=时间正序, desc=最新优先"),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    """查询历史对话消息（支持按文本/语音分区、日期、角色、关键词、分页检索）"""
    clauses: list[str] = []
    params: list = []

    if channel != "all":
        clauses.append("channel = ?")
        params.append(channel)
    if date:
        clauses.append("session_date = ?")
        params.append(_validate_date_str(date))
    if role:
        clauses.append("role = ?")
        params.append(role)
    if q and q.strip():
        escaped_q = (
            q.strip()
            .replace("\\", "\\\\")
            .replace("%", "\\%")
            .replace("_", "\\_")
        )
        clauses.append("LOWER(content) LIKE LOWER(?) ESCAPE '\\'")
        params.append(f"%{escaped_q}%")

    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    order_sql = "ASC" if order == "asc" else "DESC"

    with db_cursor() as cur:
        cur.execute(f"SELECT COUNT(*) AS cnt FROM messages {where_sql};", tuple(params))
        total = int(cur.fetchone()["cnt"] or 0)

        cur.execute(
            f"""
            SELECT id, session_date, channel, role, content, trigger_type, created_at, updated_at, duration_ms
            FROM messages
            {where_sql}
            ORDER BY session_date {order_sql}, id {order_sql}
            LIMIT ? OFFSET ?;
            """,
            tuple([*params, limit, offset]),
        )
        items = [_row_to_message_dict(r) for r in cur.fetchall()]

    return {
        "total": total,
        "items": items,
        "channel": channel,
        "date": date,
        "q": q or "",
        "limit": limit,
        "offset": offset,
    }


@router.post("/messages")
def create_message(payload: MessageCreate):
    """手动新增一条历史消息记录（支持补录文本对话或语音对话）"""
    target_date = (
        _validate_date_str(payload.session_date)
        if payload.session_date
        else datetime.now().strftime(_DATE_FORMAT)
    )
    now_time = datetime.now().strftime("%H:%M:%S")
    raw_created_at = (payload.created_at or "").strip()
    if raw_created_at:
        try:
            datetime.fromisoformat(raw_created_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="created_at 须为合法 ISO 时间格式") from exc
        created_at = raw_created_at
    else:
        created_at = f"{target_date}T{now_time}"
    trigger_type = "voice_call" if payload.channel == "voice" else "manual"
    cleaned_content = payload.content.strip()
    if not cleaned_content:
        raise HTTPException(status_code=400, detail="消息内容不能为空")

    with db_cursor() as cur:
        cur.execute(
            """
            INSERT INTO messages (session_date, channel, role, content, trigger_type, created_at)
            VALUES (?, ?, ?, ?, ?, ?);
            """,
            (target_date, payload.channel, payload.role, cleaned_content, trigger_type, created_at),
        )
        new_id = cur.lastrowid
        cur.execute(
            """
            SELECT id, session_date, channel, role, content, trigger_type, created_at, updated_at, duration_ms
            FROM messages
            WHERE id = ?;
            """,
            (new_id,),
        )
        row = cur.fetchone()
    return _row_to_message_dict(row)


@router.patch("/messages/{message_id}")
def update_message(message_id: int, payload: MessageUpdate):
    """编辑单条历史对话记录（内容 / 角色 / 文本或语音渠道 / 归属日期）"""
    updates: list[str] = []
    params: list = []

    if payload.content is not None:
        cleaned = payload.content.strip()
        if not cleaned:
            raise HTTPException(status_code=400, detail="消息内容不能为空")
        updates.append("content = ?")
        params.append(cleaned)

    if payload.role is not None:
        updates.append("role = ?")
        params.append(payload.role)

    if payload.channel is not None:
        updates.append("channel = ?")
        params.append(payload.channel)
        updates.append("trigger_type = ?")
        params.append("voice_call" if payload.channel == "voice" else "manual")

    if payload.session_date is not None:
        valid_date = _validate_date_str(payload.session_date)
        updates.append("session_date = ?")
        params.append(valid_date)

    if not updates:
        raise HTTPException(status_code=400, detail="请至少提供一个需要修改的字段")

    now_iso = datetime.now().isoformat(timespec="seconds")
    updates.append("updated_at = ?")
    params.append(now_iso)
    params.append(message_id)

    with db_cursor() as cur:
        cur.execute("SELECT id FROM messages WHERE id = ?;", (message_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="找不到对应的历史消息")

        cur.execute(
            f"UPDATE messages SET {', '.join(updates)} WHERE id = ?;",
            tuple(params),
        )
        cur.execute(
            """
            SELECT id, session_date, channel, role, content, trigger_type, created_at, updated_at, duration_ms
            FROM messages
            WHERE id = ?;
            """,
            (message_id,),
        )
        row = cur.fetchone()

    return _row_to_message_dict(row)


@router.delete("/messages/{message_id}")
def delete_message(message_id: int):
    """删除单条历史消息记录"""
    with db_cursor() as cur:
        cur.execute("DELETE FROM messages WHERE id = ?;", (message_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="找不到对应的历史消息")
    return {"deleted": True, "id": message_id}


@router.post("/messages/batch-delete")
def batch_delete_messages(payload: MessageBatchDeleteRequest):
    """批量删除历史消息（按选中 ID 列表，或按指定日期/渠道范围一键清理）"""
    with db_cursor() as cur:
        if payload.ids:
            clean_ids = [int(i) for i in payload.ids if isinstance(i, int) and not isinstance(i, bool)]
            if not clean_ids:
                raise HTTPException(status_code=400, detail="未提供有效的消息 ID")
            placeholders = ",".join("?" for _ in clean_ids)
            cur.execute(f"DELETE FROM messages WHERE id IN ({placeholders});", tuple(clean_ids))
            return {"deleted_count": int(cur.rowcount or 0)}

        # 若未传 ids，则必须指定日期或具体渠道，防止无条件误清空全库
        if not payload.date and payload.channel == "all":
            raise HTTPException(
                status_code=400,
                detail="批量清理请指定具体消息 ID、日期或对话分类（文本/语音）",
            )

        clauses: list[str] = []
        params: list = []
        if payload.date:
            clauses.append("session_date = ?")
            params.append(_validate_date_str(payload.date))
        if payload.channel != "all":
            clauses.append("channel = ?")
            params.append(payload.channel)

        cur.execute(
            f"DELETE FROM messages WHERE {' AND '.join(clauses)};",
            tuple(params),
        )
        return {"deleted_count": int(cur.rowcount or 0)}
