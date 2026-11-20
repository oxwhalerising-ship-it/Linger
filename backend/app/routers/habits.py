"""
习惯清单管理路由（/api/habits）
-------------------------------
提供每日习惯与关注事项的增删改查接口。
"""

from datetime import datetime
from fastapi import APIRouter, HTTPException, Query

from app.database import db_cursor
from app.schemas import HabitCreate, HabitOut, HabitUpdate

router = APIRouter(prefix="/api/habits", tags=["Habits"])


def _row_to_habit(row) -> HabitOut:
    """将 SQLite 行记录转换为 Pydantic 输出模型"""
    return HabitOut(
        id=row["id"],
        title=row["title"],
        category=row["category"],
        frequency=row["frequency"],
        target_desc=row["target_desc"],
        is_active=bool(row["is_active"]),
        created_at=row["created_at"],
    )


@router.get("", response_model=list[HabitOut])
def list_habits(active_only: bool = Query(default=False, description="是否仅返回启用中的习惯")):
    """获取习惯清单列表"""
    with db_cursor() as cur:
        if active_only:
            cur.execute("SELECT * FROM habits WHERE is_active = 1 ORDER BY id ASC;")
        else:
            cur.execute("SELECT * FROM habits ORDER BY id ASC;")
        rows = cur.fetchall()
    return [_row_to_habit(r) for r in rows]


@router.post("", response_model=HabitOut, status_code=201)
def create_habit(payload: HabitCreate):
    """新增一个每日习惯或关注事项"""
    now_iso = datetime.now().isoformat(timespec="seconds")
    with db_cursor() as cur:
        cur.execute(
            """
            INSERT INTO habits (title, category, frequency, target_desc, is_active, created_at)
            VALUES (?, ?, ?, ?, 1, ?);
            """,
            (payload.title, payload.category, payload.frequency, payload.target_desc, now_iso),
        )
        habit_id = cur.lastrowid
        cur.execute("SELECT * FROM habits WHERE id = ?;", (habit_id,))
        row = cur.fetchone()
    return _row_to_habit(row)


@router.patch("/{habit_id}", response_model=HabitOut)
def update_habit(habit_id: int, payload: HabitUpdate):
    """更新指定习惯的信息或启用状态"""
    updates: list[str] = []
    params: list = []

    if payload.title is not None:
        updates.append("title = ?")
        params.append(payload.title)
    if payload.category is not None:
        updates.append("category = ?")
        params.append(payload.category)
    if payload.frequency is not None:
        updates.append("frequency = ?")
        params.append(payload.frequency)
    if payload.target_desc is not None:
        updates.append("target_desc = ?")
        params.append(payload.target_desc)
    if payload.is_active is not None:
        updates.append("is_active = ?")
        params.append(1 if payload.is_active else 0)

    with db_cursor() as cur:
        cur.execute("SELECT * FROM habits WHERE id = ?;", (habit_id,))
        existing = cur.fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="找不到对应的习惯项")

        if updates:
            params.append(habit_id)
            cur.execute(f"UPDATE habits SET {', '.join(updates)} WHERE id = ?;", params)
            cur.execute("SELECT * FROM habits WHERE id = ?;", (habit_id,))
            existing = cur.fetchone()

    return _row_to_habit(existing)


@router.delete("/{habit_id}")
def delete_habit(habit_id: int):
    """删除指定习惯（会级联清理对应的打卡记录）"""
    with db_cursor() as cur:
        cur.execute("DELETE FROM habits WHERE id = ?;", (habit_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="找不到对应的习惯项")
    return {"deleted": True, "habit_id": habit_id}
