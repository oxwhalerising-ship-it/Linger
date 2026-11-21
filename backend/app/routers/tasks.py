"""
一次性任务（/api/tasks）
-----------------------
今天 / 稍后 / 完成。重复要做的事仍走习惯，不在这里生成循环任务。
"""

from datetime import date, datetime, timedelta

from fastapi import APIRouter, HTTPException

from app.core.utils import validate_date_str
from app.database import db_cursor
from app.schemas import TaskCreate, TaskOut, TaskUpdate

router = APIRouter(prefix="/api/tasks", tags=["Tasks"])


def _day(on: str | None) -> date:
    if not on:
        return date.today()
    return date.fromisoformat(validate_date_str(on))


def _due(value: str | None) -> str | None:
    if value is None or not str(value).strip():
        return None
    return validate_date_str(value)


def _out(row) -> TaskOut:
    return TaskOut(
        id=row["id"],
        title=row["title"],
        notes=row["notes"] or "",
        important=bool(row["important"]),
        due_date=row["due_date"],
        status=row["status"],
        completed_at=row["completed_at"],
        created_at=row["created_at"],
    )


def _get(cur, task_id: int):
    cur.execute("SELECT * FROM tasks WHERE id = ?;", (task_id,))
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="找不到这件任务")
    return row


@router.get("", response_model=list[TaskOut])
def list_tasks(scope: str = "today", on: str | None = None):
    """今天含逾期；稍后是没排期或排在今天之后的；完成只留最近 50 件。"""
    if scope not in ("today", "later", "done"):
        raise HTTPException(status_code=400, detail="scope 只能是 today、later 或 done")
    day = _day(on).isoformat()
    with db_cursor() as cur:
        if scope == "today":
            cur.execute(
                """
                SELECT * FROM tasks
                WHERE status = 'open' AND due_date IS NOT NULL AND due_date <= ?
                ORDER BY important DESC, due_date ASC, id ASC;
                """,
                (day,),
            )
        elif scope == "later":
            cur.execute(
                """
                SELECT * FROM tasks
                WHERE status = 'open' AND (due_date IS NULL OR due_date > ?)
                ORDER BY CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC, important DESC, id ASC;
                """,
                (day,),
            )
        else:
            cur.execute(
                """
                SELECT * FROM tasks
                WHERE status = 'done'
                ORDER BY completed_at DESC, id DESC
                LIMIT 50;
                """
            )
        rows = cur.fetchall()
    return [_out(row) for row in rows]


@router.post("", response_model=TaskOut, status_code=201)
def create_task(payload: TaskCreate):
    now = datetime.now().isoformat(timespec="seconds")
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="先写下一件要做的事")
    with db_cursor() as cur:
        cur.execute(
            """
            INSERT INTO tasks (title, notes, important, due_date, status, completed_at, created_at)
            VALUES (?, ?, ?, ?, 'open', NULL, ?);
            """,
            (title, payload.notes.strip(), 1 if payload.important else 0, _due(payload.due_date), now),
        )
        row = _get(cur, cur.lastrowid)
    return _out(row)


@router.patch("/{task_id}", response_model=TaskOut)
def update_task(task_id: int, payload: TaskUpdate):
    now = datetime.now().isoformat(timespec="seconds")
    fields = payload.model_fields_set
    updates: list[str] = []
    params: list = []
    if "title" in fields and payload.title is not None:
        title = payload.title.strip()
        if not title:
            raise HTTPException(status_code=400, detail="任务标题不能是空的")
        updates.append("title = ?")
        params.append(title)
    if "notes" in fields and payload.notes is not None:
        updates.append("notes = ?")
        params.append(payload.notes.strip())
    if "important" in fields and payload.important is not None:
        updates.append("important = ?")
        params.append(1 if payload.important else 0)
    if "due_date" in fields:
        updates.append("due_date = ?")
        params.append(_due(payload.due_date))
    if "status" in fields and payload.status is not None:
        updates.append("status = ?")
        params.append(payload.status)
        updates.append("completed_at = ?")
        params.append(now if payload.status == "done" else None)

    with db_cursor() as cur:
        _get(cur, task_id)
        if updates:
            params.append(task_id)
            cur.execute(f"UPDATE tasks SET {', '.join(updates)} WHERE id = ?;", params)
        row = _get(cur, task_id)
    return _out(row)


@router.post("/{task_id}/postpone", response_model=TaskOut)
def postpone_task(task_id: int, on: str | None = None):
    """改到明天。用来把今天清干净，而不是让逾期一直堆着。"""
    tomorrow = (_day(on) + timedelta(days=1)).isoformat()
    with db_cursor() as cur:
        row = _get(cur, task_id)
        if row["status"] != "open":
            raise HTTPException(status_code=400, detail="已经完成的任务不用再改期")
        cur.execute("UPDATE tasks SET due_date = ? WHERE id = ?;", (tomorrow, task_id))
        row = _get(cur, task_id)
    return _out(row)


@router.delete("/{task_id}")
def delete_task(task_id: int):
    with db_cursor() as cur:
        cur.execute("DELETE FROM tasks WHERE id = ?;", (task_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="找不到这件任务")
    return {"deleted": True, "task_id": task_id}
