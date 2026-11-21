"""
长期记忆与高光回溯路由（/api/memories）
---------------------------------------
管理灵儿记住的个人喜好、近期需主动跟进关心的事件、以及用于低落时鼓励的历史高光。
"""

from datetime import datetime
from typing import Optional
from fastapi import APIRouter, HTTPException, Query

from app.database import db_cursor
from app.schemas import MemoryCreate, MemoryOut

router = APIRouter(prefix="/api/memories", tags=["Memories"])


def _row_to_memory(row) -> MemoryOut:
    return MemoryOut(
        source_message_id=row["source_message_id"],
        id=row["id"],
        memory_type=row["memory_type"],
        content=row["content"],
        follow_up_date=row["follow_up_date"],
        is_resolved=bool(row["is_resolved"]),
        created_at=row["created_at"],
    )


@router.get("", response_model=list[MemoryOut])
def list_memories(
    memory_type: Optional[str] = Query(default=None, description="按类型筛选：preference / ongoing_event / highlight"),
):
    """获取长期记忆与高光列表（按创建时间倒序）"""
    with db_cursor() as cur:
        if memory_type:
            cur.execute(
                "SELECT * FROM memories WHERE memory_type = ? ORDER BY id DESC;",
                (memory_type,),
            )
        else:
            cur.execute("SELECT * FROM memories ORDER BY id DESC;")
        rows = cur.fetchall()
    return [_row_to_memory(r) for r in rows]


@router.post("", response_model=MemoryOut, status_code=201)
def create_memory(payload: MemoryCreate):
    """新增一条长期记忆或高光时刻"""
    now_iso = datetime.now().isoformat(timespec="seconds")
    with db_cursor() as cur:
        cur.execute(
            """
            INSERT INTO memories (memory_type, content, follow_up_date, is_resolved, created_at)
            VALUES (?, ?, ?, 0, ?);
            """,
            (payload.memory_type, payload.content, payload.follow_up_date, now_iso),
        )
        mem_id = cur.lastrowid
        cur.execute("SELECT * FROM memories WHERE id = ?;", (mem_id,))
        row = cur.fetchone()
    return _row_to_memory(row)


@router.delete("/{memory_id}")
def delete_memory(memory_id: int):
    """删除指定长期记忆（赋予用户完全的记忆掌控权）"""
    with db_cursor() as cur:
        cur.execute("DELETE FROM memories WHERE id = ?;", (memory_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="找不到对应的记忆记录")
    return {"deleted": True, "memory_id": memory_id}

@router.patch("/{memory_id}", response_model=MemoryOut)
def edit_memory(memory_id: int, payload: MemoryCreate):
    with db_cursor() as cur:
        cur.execute("UPDATE memories SET content=?, memory_type=?, follow_up_date=? WHERE id=?",
                    (payload.content, payload.memory_type, payload.follow_up_date, memory_id))
        row = cur.execute("SELECT * FROM memories WHERE id=?", (memory_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "记忆已删除")
        return _row_to_memory(row)
