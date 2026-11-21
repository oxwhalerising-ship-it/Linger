"""
番茄钟记录（/api/focus）
-----------------------
只保存已经结束的一轮。进行中的倒计时留在面板本机，避免刷新或切页把钟重置。
"""

from datetime import date, datetime

from fastapi import APIRouter, HTTPException

from app.core.utils import validate_date_str
from app.database import db_cursor
from app.schemas import FocusDayOut, FocusOverviewOut, FocusRecordDay, FocusSessionCreate, FocusSessionOut

router = APIRouter(prefix="/api/focus", tags=["Focus"])


def _out(row) -> FocusSessionOut:
    return FocusSessionOut(
        id=row["id"],
        task_id=row["task_id"],
        task_title=row["task_title"],
        kind=row["kind"],
        planned_seconds=row["planned_seconds"],
        actual_seconds=row["actual_seconds"],
        started_at=row["started_at"],
        ended_at=row["ended_at"],
        session_date=row["session_date"],
        completed=bool(row["completed"]),
    )


def _load(cur, session_id: int):
    cur.execute(
        """
        SELECT f.*, t.title AS task_title
        FROM focus_sessions f
        LEFT JOIN tasks t ON t.id = f.task_id
        WHERE f.id = ?;
        """,
        (session_id,),
    )
    return cur.fetchone()


@router.get("/overview", response_model=FocusOverviewOut)
def focus_overview(on: str | None = None):
    """今日和累计的番茄数、专注时长，以及最近的专注记录。休息不记进这条时间线。"""
    day = date.today().isoformat() if not on else validate_date_str(on)
    with db_cursor() as cur:
        cur.execute(
            """
            SELECT
                COALESCE(SUM(CASE WHEN session_date = ? AND completed = 1 THEN 1 ELSE 0 END), 0) AS today_count,
                COALESCE(SUM(CASE WHEN session_date = ? THEN actual_seconds ELSE 0 END), 0) AS today_seconds,
                COALESCE(SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END), 0) AS total_count,
                COALESCE(SUM(actual_seconds), 0) AS total_seconds
            FROM focus_sessions
            WHERE kind = 'focus';
            """,
            (day, day),
        )
        summary = cur.fetchone()
        cur.execute(
            """
            SELECT f.*, t.title AS task_title
            FROM focus_sessions f
            LEFT JOIN tasks t ON t.id = f.task_id
            WHERE f.kind = 'focus'
            ORDER BY f.session_date DESC, f.id DESC
            LIMIT 80;
            """
        )
        rows = [_out(row) for row in cur.fetchall()]
    days: list[FocusRecordDay] = []
    for item in rows:
        if not days or days[-1].date != item.session_date:
            days.append(FocusRecordDay(date=item.session_date, sessions=[]))
        days[-1].sessions.append(item)
    return FocusOverviewOut(
        today_count=int(summary["today_count"] or 0),
        today_seconds=int(summary["today_seconds"] or 0),
        total_count=int(summary["total_count"] or 0),
        total_seconds=int(summary["total_seconds"] or 0),
        days=days,
    )


@router.get("/days/{date_str}", response_model=FocusDayOut)
def focus_day(date_str: str):
    day = validate_date_str(date_str)
    with db_cursor() as cur:
        cur.execute(
            """
            SELECT f.*, t.title AS task_title
            FROM focus_sessions f
            LEFT JOIN tasks t ON t.id = f.task_id
            WHERE f.session_date = ?
            ORDER BY f.id DESC
            LIMIT 100;
            """,
            (day,),
        )
        rows = [_out(row) for row in cur.fetchall()]
        cur.execute(
            """
            SELECT COUNT(*) AS cnt, COALESCE(SUM(actual_seconds), 0) AS seconds
            FROM focus_sessions
            WHERE session_date = ? AND kind = 'focus' AND completed = 1;
            """,
            (day,),
        )
        summary = cur.fetchone()
    seconds = int(summary["seconds"] or 0)
    return FocusDayOut(
        date=day,
        focus_count=int(summary["cnt"] or 0),
        focus_minutes=(seconds + 30) // 60,
        sessions=rows,
    )


@router.post("/sessions", response_model=FocusSessionOut, status_code=201)
def record_focus(payload: FocusSessionCreate):
    day = validate_date_str(payload.session_date)
    now = datetime.now().isoformat(timespec="seconds")
    with db_cursor() as cur:
        cur.execute("SELECT id FROM focus_sessions WHERE client_id = ?;", (payload.client_id,))
        existing = cur.fetchone()
        if existing is not None:
            return _out(_load(cur, existing["id"]))
        if payload.task_id is not None:
            cur.execute("SELECT id FROM tasks WHERE id = ?;", (payload.task_id,))
            if cur.fetchone() is None:
                raise HTTPException(status_code=404, detail="找不到要绑定的任务")
        cur.execute(
            """
            INSERT INTO focus_sessions (
                client_id, task_id, kind, planned_seconds, actual_seconds,
                started_at, ended_at, session_date, completed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
            """,
            (
                payload.client_id,
                payload.task_id,
                payload.kind,
                payload.planned_seconds,
                payload.actual_seconds,
                payload.started_at,
                now,
                day,
                1 if payload.completed else 0,
            ),
        )
        row = _load(cur, cur.lastrowid)
    return _out(row)
