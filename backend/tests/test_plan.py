"""任务、番茄钟和习惯连续天数。"""

from datetime import date, timedelta

import pytest
from fastapi import HTTPException

from app import database
from app.routers import focus, habits, tasks
from app.schemas import FocusSessionCreate, TaskCreate, TaskUpdate


def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DB_PATH", tmp_path / "plan.db")
    monkeypatch.setattr(database, "ensure_data_dirs", lambda: None)
    database.init_db()


def test_tasks_split_today_later_and_postpone(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    day = "2026-11-21"
    overdue = tasks.create_task(TaskCreate(title="补交周报", due_date="2026-11-20", important=True))
    today = tasks.create_task(TaskCreate(title="买牛奶", due_date=day))
    later = tasks.create_task(TaskCreate(title="整理书桌"))
    titles = [item.title for item in tasks.list_tasks("today", day)]
    assert titles == ["补交周报", "买牛奶"]
    assert [item.title for item in tasks.list_tasks("later", day)] == ["整理书桌"]

    moved = tasks.postpone_task(overdue.id, day)
    assert moved.due_date == "2026-11-22"
    assert overdue.title not in [item.title for item in tasks.list_tasks("today", day)]
    assert "补交周报" in [item.title for item in tasks.list_tasks("later", day)]

    done = tasks.update_task(today.id, TaskUpdate(status="done"))
    assert done.status == "done" and done.completed_at
    assert [item.title for item in tasks.list_tasks("done")] == ["买牛奶"]
    assert tasks.update_task(today.id, TaskUpdate(status="open")).status == "open"

    with pytest.raises(HTTPException):
        tasks.postpone_task(tasks.update_task(today.id, TaskUpdate(status="done")).id, day)
    tasks.delete_task(later.id)
    assert later.title not in [item.title for item in tasks.list_tasks("later", day)]


def test_focus_counts_finished_tomatoes_once(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    task = tasks.create_task(TaskCreate(title="读十页", due_date="2026-11-21"))
    payload = FocusSessionCreate(
        client_id="tomato-1",
        task_id=task.id,
        kind="focus",
        planned_seconds=25 * 60,
        actual_seconds=25 * 60,
        started_at="2026-11-21T09:00:00",
        session_date="2026-11-21",
        completed=True,
    )
    first = focus.record_focus(payload)
    again = focus.record_focus(payload)
    assert first.id == again.id
    focus.record_focus(
        FocusSessionCreate(
            client_id="tomato-abandoned",
            task_id=task.id,
            kind="focus",
            planned_seconds=25 * 60,
            actual_seconds=4 * 60,
            started_at="2026-11-21T10:00:00",
            session_date="2026-11-21",
            completed=False,
        )
    )
    focus.record_focus(
        FocusSessionCreate(
            client_id="break-rest",
            kind="break",
            planned_seconds=5 * 60,
            actual_seconds=5 * 60,
            started_at="2026-11-21T09:25:00",
            session_date="2026-11-21",
        )
    )
    day = focus.focus_day("2026-11-21")
    finished = [item for item in day.sessions if item.kind == "focus" and item.completed]
    assert day.focus_count == 1
    assert day.focus_minutes == 25
    assert len(finished) == 1
    assert finished[0].task_title == "读十页"
    overview = focus.focus_overview("2026-11-21")
    assert overview.today_count == 1
    assert overview.total_count == 1
    assert overview.today_seconds == 25 * 60 + 4 * 60
    assert overview.days[0].date == "2026-11-21"
    assert overview.days[0].sessions[0].task_title == "读十页"
    with pytest.raises(HTTPException):
        focus.record_focus(
            FocusSessionCreate(
                client_id="missing-task",
                task_id=999,
                kind="focus",
                planned_seconds=60,
                actual_seconds=60,
                started_at="2026-11-21T11:00:00",
                session_date="2026-11-21",
            )
        )


def test_habit_streak_waits_until_the_day_is_over(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    today = date(2026, 11, 21)
    with database.db_cursor() as cur:
        cur.execute(
            """
            INSERT INTO habits (title, category, frequency, target_desc, is_active, created_at)
            VALUES ('喝水', '生活习惯', 'daily', '', 1, '2026-11-01T00:00:00');
            """
        )
        habit_id = cur.lastrowid
        for offset, status in ((2, "done"), (1, "partial")):
            cur.execute(
                """
                INSERT INTO habit_records (date, habit_id, status, note, recorded_at)
                VALUES (?, ?, ?, '', '2026-11-21T08:00:00');
                """,
                ((today - timedelta(days=offset)).isoformat(), habit_id, status),
            )
    board = habits.habit_board(today.isoformat())
    item = board.items[0]
    assert item.streak == 2
    assert item.today_status is None
    assert len(item.week) == 7
    assert item.week[-2].status == "partial"

    with database.db_cursor() as cur:
        cur.execute(
            """
            INSERT INTO habit_records (date, habit_id, status, note, recorded_at)
            VALUES ('2026-11-21', ?, 'missed', '', '2026-11-21T21:00:00');
            """,
            (habit_id,),
        )
    assert habits.habit_board(today.isoformat()).items[0].streak == 0
