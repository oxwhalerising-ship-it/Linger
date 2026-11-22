"""灵儿控制面板全套核心内置工具（v1）。

覆盖范围（严格遵循安全边界：第一期不暴露任何永久删除类工具）：
1. 日记与今日记录：`get_daily_log`、`record_daily_log`
2. 习惯管理：`list_habits`、`checkin_habit`、`create_habit`
3. 待办任务：`list_tasks`、`create_task`、`update_task`
4. 长期记忆：`list_memories`、`save_memory`
5. 番茄钟与专注：`get_focus_overview`、`control_focus_timer`
6. 面板导航：`open_dashboard_page`
"""

from __future__ import annotations

import asyncio
import json
from datetime import date, datetime, timedelta
from typing import Any

from app.core.logging import get_logger
from app.core.utils import validate_date_str
from app.database import db_cursor
from app.routers.habits import _streak
from app.services.markdown_exporter import export_daily_markdown
from app.services.tools.registry import ToolRegistry
from app.services.tools.types import ToolContext, ToolExecutionResult, ToolSpec

logger = get_logger("tools.builtin")

_VALID_HABIT_CATEGORIES = ("生活习惯", "作息睡眠", "运动健康", "学习成长", "情绪自我")
_VALID_MEMORY_TYPES = ("preference", "ongoing_event", "highlight")
_PAGE_LABELS = {
    "today": "今天概览",
    "tasks": "待办任务",
    "focus": "番茄钟",
    "habits": "习惯打卡",
    "chat": "对话",
    "insights": "数据洞察",
    "journal": "每日日记",
    "joy": "小确幸",
    "memory": "长期记忆",
    "settings": "设置",
}


def _resolve_date(raw: Any, fallback: str) -> str:
    text = str(raw or "").strip()
    if not text:
        return fallback
    try:
        return validate_date_str(text)
    except Exception:
        return fallback


def _safe_export_md(date_str: str) -> str:
    try:
        path, _ = export_daily_markdown(date_str)
        return path
    except Exception as exc:
        logger.warning("工具写库后导出 Markdown 失败 (%s): %s", date_str, exc)
        return ""


def _clamp_int(val: Any, low: int, high: int) -> int | None:
    if isinstance(val, bool) or val is None:
        return None
    try:
        num = int(round(float(val)))
    except (TypeError, ValueError):
        return None
    return max(low, min(high, num))


# ==================== 1. 日记与今日记录 ====================


def _tool_get_daily_log(args: dict[str, Any], ctx: ToolContext) -> ToolExecutionResult:
    target_date = _resolve_date(args.get("date"), ctx.date_str)
    with db_cursor() as cur:
        cur.execute("SELECT * FROM daily_logs WHERE date = ?;", (target_date,))
        row = cur.fetchone()
        cur.execute(
            """
            SELECT hr.habit_id, h.title, hr.status, hr.note
            FROM habit_records hr
            JOIN habits h ON h.id = hr.habit_id
            WHERE hr.date = ?
            ORDER BY hr.habit_id ASC;
            """,
            (target_date,),
        )
        records = [dict(r) for r in cur.fetchall()]

    return ToolExecutionResult(
        ok=True,
        tool_name="get_daily_log",
        data={
            "date": target_date,
            "summary": row["summary"] if row else "",
            "mood_score": row["mood_score"] if row else None,
            "energy_score": row["energy_score"] if row else None,
            "highlights": json.loads(row["highlights"] or "[]") if row else [],
            "habit_records": records,
        },
    )


def _tool_record_daily_log(args: dict[str, Any], ctx: ToolContext) -> ToolExecutionResult:
    target_date = _resolve_date(args.get("date"), ctx.date_str)
    summary_append = str(args.get("summary_append") or "").strip()
    mood_score = _clamp_int(args.get("mood_score"), 1, 5)
    energy_score = _clamp_int(args.get("energy_score"), 1, 5)

    raw_highlights = args.get("highlights")
    new_highlights: list[str] = []
    if isinstance(raw_highlights, list):
        for item in raw_highlights:
            text = str(item or "").strip()
            if text and text not in new_highlights:
                new_highlights.append(text[:120])
    elif isinstance(raw_highlights, str) and raw_highlights.strip():
        new_highlights.append(raw_highlights.strip()[:120])

    if not summary_append and mood_score is None and energy_score is None and not new_highlights:
        return ToolExecutionResult(
            ok=False,
            tool_name="record_daily_log",
            error="至少需要提供 summary_append、mood_score、energy_score 或 highlights 中的一项。",
        )

    now_iso = datetime.now().isoformat(timespec="seconds")
    skip_keys: set[str] = set()
    added_highlights: list[str] = []
    summary_changed = False

    with db_cursor() as cur:
        cur.execute("SELECT * FROM daily_logs WHERE date = ?;", (target_date,))
        existing = cur.fetchone()
        summary = existing["summary"] if existing else ""
        cur_mood = existing["mood_score"] if existing else None
        cur_energy = existing["energy_score"] if existing else None
        cur_highlights: list[str] = json.loads(existing["highlights"] or "[]") if existing else []

        if summary_append:
            if summary_append not in summary:
                summary = f"{summary}\n{summary_append}".strip() if summary else summary_append
                summary_changed = True
            skip_keys.add("summary")

        if mood_score is not None:
            cur_mood = mood_score
            skip_keys.add("mood_score")

        if energy_score is not None:
            cur_energy = energy_score
            skip_keys.add("energy_score")

        if new_highlights:
            for item in new_highlights:
                if item not in cur_highlights:
                    cur_highlights.append(item)
                    added_highlights.append(item)
            skip_keys.add("highlights")

        if existing:
            cur.execute(
                """
                UPDATE daily_logs
                SET summary = ?, mood_score = ?, energy_score = ?, highlights = ?, updated_at = ?
                WHERE date = ?;
                """,
                (
                    summary,
                    cur_mood,
                    cur_energy,
                    json.dumps(cur_highlights, ensure_ascii=False),
                    now_iso,
                    target_date,
                ),
            )
        else:
            cur.execute(
                """
                INSERT INTO daily_logs (date, summary, mood_score, energy_score, highlights, md_path, updated_at)
                VALUES (?, ?, ?, ?, ?, '', ?);
                """,
                (
                    target_date,
                    summary,
                    cur_mood,
                    cur_energy,
                    json.dumps(cur_highlights, ensure_ascii=False),
                    now_iso,
                ),
            )

    _safe_export_md(target_date)

    badge_parts: list[str] = []
    if summary_append:
        badge_parts.append("📝 已记录到今日日记" if target_date == ctx.date_str else f"📝 已记录到 {target_date} 日记")
    if added_highlights:
        badge_parts.append(f"✨ 收录小确幸×{len(added_highlights)}")
    if mood_score is not None and not badge_parts:
        badge_parts.append(f"💛 已记录心情 {mood_score}/5")
    if energy_score is not None and not badge_parts:
        badge_parts.append(f"⚡ 已记录精力 {energy_score}/5")

    return ToolExecutionResult(
        ok=True,
        tool_name="record_daily_log",
        data={
            "date": target_date,
            "summary_updated": summary_changed,
            "summary": summary,
            "mood_score": cur_mood,
            "energy_score": cur_energy,
            "added_highlights": added_highlights,
            "total_highlights": len(cur_highlights),
        },
        badge=" · ".join(badge_parts) if badge_parts else "📝 已更新今日记录",
        mutated_domains=["logs", "today"],
        archive_skip_keys=skip_keys,
    )


# ==================== 2. 习惯管理 ====================


def _tool_list_habits(args: dict[str, Any], ctx: ToolContext) -> ToolExecutionResult:
    target_date = _resolve_date(args.get("date"), ctx.date_str)
    day = date.fromisoformat(target_date)
    lookback = (day - timedelta(days=400)).isoformat()

    with db_cursor() as cur:
        cur.execute("SELECT * FROM habits WHERE is_active = 1 ORDER BY id ASC;")
        habits = cur.fetchall()
        cur.execute(
            "SELECT habit_id, date, status, note FROM habit_records WHERE date >= ? AND date <= ?;",
            (lookback, target_date),
        )
        marks: dict[int, dict[str, str]] = {}
        today_notes: dict[int, str] = {}
        for row in cur.fetchall():
            marks.setdefault(row["habit_id"], {})[row["date"]] = row["status"]
            if row["date"] == target_date:
                today_notes[row["habit_id"]] = row["note"] or ""

    items = []
    for h in habits:
        history = marks.get(h["id"], {})
        items.append(
            {
                "id": h["id"],
                "title": h["title"],
                "category": h["category"],
                "target_desc": h["target_desc"] or "",
                "today_status": history.get(target_date),
                "today_note": today_notes.get(h["id"], ""),
                "streak": _streak(history, day),
            }
        )

    return ToolExecutionResult(
        ok=True,
        tool_name="list_habits",
        data={"date": target_date, "habits": items},
    )


def _match_habit(cur, habit_id: Any, habit_title: str):
    if habit_id is not None and not isinstance(habit_id, bool):
        try:
            hid = int(habit_id)
            cur.execute("SELECT * FROM habits WHERE id = ? AND is_active = 1;", (hid,))
            row = cur.fetchone()
            if row is not None:
                return row, []
        except (TypeError, ValueError):
            pass

    title = habit_title.strip()
    if not title:
        return None, []

    cur.execute("SELECT * FROM habits WHERE is_active = 1 ORDER BY id ASC;")
    rows = cur.fetchall()
    lower = title.lower()
    exact = [r for r in rows if r["title"].strip().lower() == lower]
    if len(exact) == 1:
        return exact[0], []

    fuzzy = [
        r
        for r in rows
        if lower in r["title"].strip().lower() or r["title"].strip().lower() in lower
    ]
    if len(fuzzy) == 1:
        return fuzzy[0], []
    return None, [{"id": r["id"], "title": r["title"]} for r in (fuzzy or rows)]


def _tool_checkin_habit(args: dict[str, Any], ctx: ToolContext) -> ToolExecutionResult:
    target_date = _resolve_date(args.get("date"), ctx.date_str)
    status = str(args.get("status") or "done").strip().lower()
    if status not in ("done", "partial", "missed"):
        status = "done"
    note = str(args.get("note") or "").strip()[:120]
    habit_title = str(args.get("habit_title") or "").strip()

    with db_cursor() as cur:
        matched, candidates = _match_habit(cur, args.get("habit_id"), habit_title)
        if matched is None:
            return ToolExecutionResult(
                ok=False,
                tool_name="checkin_habit",
                data={"candidates": candidates},
                error="没有精确匹配到对应的启用习惯，请参考 candidates 确认或用 create_habit 新建。",
            )

        now_iso = datetime.now().isoformat(timespec="seconds")
        cur.execute(
            """
            INSERT INTO habit_records (habit_id, date, status, note, recorded_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(habit_id, date) DO UPDATE SET
                status = excluded.status,
                note = excluded.note,
                recorded_at = excluded.recorded_at;
            """,
            (matched["id"], target_date, status, note, now_iso),
        )
        matched_id = int(matched["id"])
        matched_title = str(matched["title"])

    _safe_export_md(target_date)

    status_badge = {
        "done": f"✅ 已打卡「{matched_title}」",
        "partial": f"🟡 已记录「{matched_title}」（部分完成）",
        "missed": f"📝 已记录「{matched_title}」（今日未完成）",
    }[status]

    return ToolExecutionResult(
        ok=True,
        tool_name="checkin_habit",
        data={
            "date": target_date,
            "habit_id": matched_id,
            "title": matched_title,
            "status": status,
            "note": note,
        },
        badge=status_badge,
        mutated_domains=["habits", "logs", "today"],
        archive_skip_keys={"habit_updates"},
    )


def _tool_create_habit(args: dict[str, Any], ctx: ToolContext) -> ToolExecutionResult:
    title = str(args.get("title") or "").strip()[:40]
    if not title:
        return ToolExecutionResult(ok=False, tool_name="create_habit", error="习惯名称不能为空。")
    category = str(args.get("category") or "生活习惯").strip()
    if category not in _VALID_HABIT_CATEGORIES:
        category = "生活习惯"
    target_desc = str(args.get("target_desc") or "").strip()[:120]

    now_iso = datetime.now().isoformat(timespec="seconds")
    with db_cursor() as cur:
        cur.execute(
            "SELECT * FROM habits WHERE is_active = 1 AND lower(title) = lower(?);",
            (title,),
        )
        existing = cur.fetchone()
        if existing is not None:
            return ToolExecutionResult(
                ok=True,
                tool_name="create_habit",
                data={
                    "already_exists": True,
                    "habit": {
                        "id": existing["id"],
                        "title": existing["title"],
                        "category": existing["category"],
                    },
                },
                badge=f"🌱 习惯「{existing['title']}」已在清单中",
            )
        cur.execute(
            """
            INSERT INTO habits (title, category, frequency, target_desc, is_active, created_at)
            VALUES (?, ?, 'daily', ?, 1, ?);
            """,
            (title, category, target_desc, now_iso),
        )
        habit_id = int(cur.lastrowid)

    return ToolExecutionResult(
        ok=True,
        tool_name="create_habit",
        data={
            "already_exists": False,
            "habit": {
                "id": habit_id,
                "title": title,
                "category": category,
                "target_desc": target_desc,
            },
        },
        badge=f"🌱 已新增习惯「{title}」",
        mutated_domains=["habits", "today"],
    )


# ==================== 3. 待办任务 ====================


def _tool_list_tasks(args: dict[str, Any], ctx: ToolContext) -> ToolExecutionResult:
    scope = str(args.get("scope") or "today").strip().lower()
    if scope not in ("today", "later", "done"):
        scope = "today"
    day = _resolve_date(args.get("on"), ctx.date_str)

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
                LIMIT 30;
                """
            )
        rows = [
            {
                "id": r["id"],
                "title": r["title"],
                "notes": r["notes"] or "",
                "important": bool(r["important"]),
                "due_date": r["due_date"],
                "status": r["status"],
            }
            for r in cur.fetchall()
        ]

    return ToolExecutionResult(
        ok=True,
        tool_name="list_tasks",
        data={"scope": scope, "date": day, "tasks": rows},
    )


def _tool_create_task(args: dict[str, Any], ctx: ToolContext) -> ToolExecutionResult:
    title = str(args.get("title") or "").strip()[:200]
    if not title:
        return ToolExecutionResult(ok=False, tool_name="create_task", error="待办任务标题不能为空。")
    notes = str(args.get("notes") or "").strip()[:500]
    important = bool(args.get("important", False))
    later = bool(args.get("later", False))

    raw_due = args.get("due_date")
    if later:
        due_date = None
    elif raw_due is not None and str(raw_due).strip():
        due_date = _resolve_date(raw_due, ctx.date_str)
    else:
        due_date = ctx.date_str

    now_iso = datetime.now().isoformat(timespec="seconds")
    with db_cursor() as cur:
        cur.execute(
            """
            SELECT * FROM tasks
            WHERE status = 'open' AND lower(title) = lower(?) AND COALESCE(due_date, '') = COALESCE(?, '');
            """,
            (title, due_date),
        )
        dup = cur.fetchone()
        if dup is not None:
            return ToolExecutionResult(
                ok=True,
                tool_name="create_task",
                data={
                    "already_exists": True,
                    "task": {
                        "id": dup["id"],
                        "title": dup["title"],
                        "due_date": dup["due_date"],
                        "important": bool(dup["important"]),
                    },
                },
                badge=f"📌 待办「{dup['title']}」已在清单中",
            )

        cur.execute(
            """
            INSERT INTO tasks (title, notes, important, due_date, status, completed_at, created_at)
            VALUES (?, ?, ?, ?, 'open', NULL, ?);
            """,
            (title, notes, 1 if important else 0, due_date, now_iso),
        )
        task_id = int(cur.lastrowid)

    return ToolExecutionResult(
        ok=True,
        tool_name="create_task",
        data={
            "already_exists": False,
            "task": {
                "id": task_id,
                "title": title,
                "due_date": due_date,
                "important": important,
                "notes": notes,
            },
        },
        badge=f"📌 已添加待办「{title}」",
        mutated_domains=["tasks", "today"],
    )


def _find_task(cur, task_id: Any, task_title: str, prefer_open: bool = True):
    if task_id is not None and not isinstance(task_id, bool):
        try:
            tid = int(task_id)
            cur.execute("SELECT * FROM tasks WHERE id = ?;", (tid,))
            row = cur.fetchone()
            if row is not None:
                return row, []
        except (TypeError, ValueError):
            pass

    title = task_title.strip()
    if not title:
        return None, []

    if prefer_open:
        cur.execute("SELECT * FROM tasks WHERE status = 'open' ORDER BY id DESC;")
        rows = cur.fetchall()
        if not rows:
            cur.execute("SELECT * FROM tasks ORDER BY id DESC LIMIT 40;")
            rows = cur.fetchall()
    else:
        cur.execute("SELECT * FROM tasks ORDER BY id DESC LIMIT 40;")
        rows = cur.fetchall()

    lower = title.lower()
    exact = [r for r in rows if r["title"].strip().lower() == lower]
    if len(exact) == 1:
        return exact[0], []

    fuzzy = [
        r
        for r in rows
        if lower in r["title"].strip().lower() or r["title"].strip().lower() in lower
    ]
    if len(fuzzy) == 1:
        return fuzzy[0], []
    return None, [{"id": r["id"], "title": r["title"], "status": r["status"]} for r in fuzzy[:8]]


def _tool_update_task(args: dict[str, Any], ctx: ToolContext) -> ToolExecutionResult:
    task_title = str(args.get("task_title") or "").strip()
    status = args.get("status")
    postpone = bool(args.get("postpone", False))
    prefer_open = status != "open"

    with db_cursor() as cur:
        row, candidates = _find_task(cur, args.get("task_id"), task_title, prefer_open=prefer_open)
        if row is None:
            return ToolExecutionResult(
                ok=False,
                tool_name="update_task",
                data={"candidates": candidates},
                error="未找到对应的待办任务，请先调用 list_tasks 核对准确任务名或 ID。",
            )

        now_iso = datetime.now().isoformat(timespec="seconds")
        updates: list[str] = []
        params: list[Any] = []
        new_title = str(row["title"])

        if args.get("title") and str(args["title"]).strip():
            new_title = str(args["title"]).strip()[:200]
            updates.append("title = ?")
            params.append(new_title)
        if "notes" in args and args["notes"] is not None:
            updates.append("notes = ?")
            params.append(str(args["notes"]).strip()[:500])
        if "important" in args and args["important"] is not None:
            updates.append("important = ?")
            params.append(1 if bool(args["important"]) else 0)
        if postpone:
            tomorrow = (date.fromisoformat(ctx.date_str) + timedelta(days=1)).isoformat()
            updates.append("due_date = ?")
            params.append(tomorrow)
        elif "due_date" in args:
            raw_due = args.get("due_date")
            due_val = None if (raw_due is None or not str(raw_due).strip()) else _resolve_date(raw_due, ctx.date_str)
            updates.append("due_date = ?")
            params.append(due_val)
        if status in ("open", "done"):
            updates.append("status = ?")
            params.append(status)
            updates.append("completed_at = ?")
            params.append(now_iso if status == "done" else None)

        if not updates:
            return ToolExecutionResult(
                ok=False,
                tool_name="update_task",
                error="没有提供需要更新的字段（如 status、postpone、title、due_date 或 important）。",
            )

        params.append(row["id"])
        cur.execute(f"UPDATE tasks SET {', '.join(updates)} WHERE id = ?;", tuple(params))
        cur.execute("SELECT * FROM tasks WHERE id = ?;", (row["id"],))
        updated = cur.fetchone()

    if status == "done":
        badge = f"☑️ 已完成待办「{updated['title']}」"
    elif postpone:
        badge = f"📅 已顺延待办「{updated['title']}」到明天"
    else:
        badge = f"✏️ 已更新待办「{updated['title']}」"

    return ToolExecutionResult(
        ok=True,
        tool_name="update_task",
        data={
            "task": {
                "id": updated["id"],
                "title": updated["title"],
                "due_date": updated["due_date"],
                "important": bool(updated["important"]),
                "status": updated["status"],
            }
        },
        badge=badge,
        mutated_domains=["tasks", "today"],
    )


# ==================== 4. 长期记忆 ====================


def _tool_list_memories(args: dict[str, Any], ctx: ToolContext) -> ToolExecutionResult:
    mem_type = str(args.get("memory_type") or "").strip()
    query = str(args.get("query") or "").strip().lower()
    limit = _clamp_int(args.get("limit"), 1, 30) or 15

    with db_cursor() as cur:
        if mem_type in _VALID_MEMORY_TYPES:
            cur.execute(
                "SELECT * FROM memories WHERE memory_type = ? ORDER BY id DESC LIMIT ?;",
                (mem_type, limit * 2 if query else limit),
            )
        else:
            cur.execute(
                "SELECT * FROM memories ORDER BY id DESC LIMIT ?;",
                (limit * 2 if query else limit,),
            )
        rows = cur.fetchall()

    items = []
    for r in rows:
        if query and query not in str(r["content"]).lower():
            continue
        items.append(
            {
                "id": r["id"],
                "memory_type": r["memory_type"],
                "content": r["content"],
                "follow_up_date": r["follow_up_date"],
                "created_at": r["created_at"],
            }
        )
        if len(items) >= limit:
            break

    return ToolExecutionResult(
        ok=True,
        tool_name="list_memories",
        data={"memories": items},
    )


def _tool_save_memory(args: dict[str, Any], ctx: ToolContext) -> ToolExecutionResult:
    content = str(args.get("content") or "").strip()[:300]
    if not content:
        return ToolExecutionResult(ok=False, tool_name="save_memory", error="记忆内容不能为空。")
    mem_type = str(args.get("memory_type") or "preference").strip()
    if mem_type not in _VALID_MEMORY_TYPES:
        mem_type = "preference"
    follow_up_raw = args.get("follow_up_date")
    follow_up = _resolve_date(follow_up_raw, "") if follow_up_raw else None
    if follow_up == "":
        follow_up = None

    now_iso = datetime.now().isoformat(timespec="seconds")
    with db_cursor() as cur:
        cur.execute(
            "SELECT id, content FROM memories WHERE memory_type = ? AND content = ?;",
            (mem_type, content),
        )
        dup = cur.fetchone()
        if dup is not None:
            return ToolExecutionResult(
                ok=True,
                tool_name="save_memory",
                data={"already_exists": True, "memory_id": dup["id"], "content": dup["content"]},
                badge=f"🧠 已记住：{content[:20]}",
                archive_skip_keys={"new_memories"},
            )
        cur.execute(
            """
            INSERT INTO memories (memory_type, content, follow_up_date, is_resolved, created_at, source_message_id)
            VALUES (?, ?, ?, 0, ?, ?);
            """,
            (mem_type, content, follow_up, now_iso, ctx.source_message_id),
        )
        mem_id = int(cur.lastrowid)

    short = content if len(content) <= 22 else f"{content[:22]}…"
    return ToolExecutionResult(
        ok=True,
        tool_name="save_memory",
        data={
            "already_exists": False,
            "memory_id": mem_id,
            "memory_type": mem_type,
            "content": content,
            "follow_up_date": follow_up,
        },
        badge=f"🧠 已记住：{short}",
        mutated_domains=["memories"],
        archive_skip_keys={"new_memories"},
    )


# ==================== 5. 番茄钟与专注控制 ====================


def _match_focus_task(task_id: Any, task_title: str, today_str: str) -> tuple[int | None, str]:
    """在本地待办任务中自动匹配要绑定到番茄钟的任务。"""
    with db_cursor() as cur:
        if task_id is not None and not isinstance(task_id, bool):
            try:
                tid = int(task_id)
                cur.execute("SELECT id, title FROM tasks WHERE id = ?;", (tid,))
                row = cur.fetchone()
                if row is not None:
                    return int(row["id"]), str(row["title"])
            except (TypeError, ValueError):
                pass

        clean = task_title.strip()
        if not clean:
            return None, ""

        cur.execute(
            """
            SELECT id, title, due_date FROM tasks
            WHERE status = 'open'
            ORDER BY CASE WHEN due_date IS NOT NULL AND due_date <= ? THEN 0 ELSE 1 END, id DESC;
            """,
            (today_str,),
        )
        rows = cur.fetchall()
        lower = clean.lower()
        for r in rows:
            if r["title"].strip().lower() == lower:
                return int(r["id"]), str(r["title"])
        for r in rows:
            rt = r["title"].strip().lower()
            if lower in rt or rt in lower:
                return int(r["id"]), str(r["title"])
    return None, task_title.strip()[:80]


async def _tool_get_focus_overview(args: dict[str, Any], ctx: ToolContext) -> ToolExecutionResult:
    target_date = _resolve_date(args.get("date"), ctx.date_str)
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
            (target_date, target_date),
        )
        summary = cur.fetchone()

    live_timer: dict[str, Any] | None = None
    if ctx.bus.active_count > 0:
        ack = await ctx.bus.dispatch_ui_command(
            "focus_control",
            {"action": "status"},
            timeout=1.2,
        )
        if ack.get("ok") and isinstance(ack.get("result"), dict):
            live_timer = ack["result"].get("state")

    return ToolExecutionResult(
        ok=True,
        tool_name="get_focus_overview",
        data={
            "date": target_date,
            "today_tomatoes": int(summary["today_count"] or 0),
            "today_focus_minutes": round(int(summary["today_seconds"] or 0) / 60, 1),
            "total_tomatoes": int(summary["total_count"] or 0),
            "total_focus_minutes": round(int(summary["total_seconds"] or 0) / 60, 1),
            "live_timer": live_timer,
        },
    )


async def _tool_control_focus_timer(args: dict[str, Any], ctx: ToolContext) -> ToolExecutionResult:
    action = str(args.get("action") or "start").strip().lower()
    if action not in ("start", "pause", "resume", "stop", "skip_break", "status"):
        return ToolExecutionResult(
            ok=False,
            tool_name="control_focus_timer",
            error="不支持的 action，必须是 start / pause / resume / stop / skip_break / status 之一。",
        )

    mode = str(args.get("mode") or "pomodoro").strip().lower()
    if mode not in ("pomodoro", "stopwatch"):
        mode = "pomodoro"

    minutes = _clamp_int(args.get("minutes"), 1, 180)
    raw_task_title = str(args.get("task_title") or "").strip()
    matched_task_id, resolved_task_title = _match_focus_task(
        args.get("task_id"),
        raw_task_title,
        ctx.date_str,
    )
    finish_task = bool(args.get("finish_task", False))
    force = bool(args.get("force", False))
    # 专注无打扰策略：默认由桌宠飞往右上角变身悬浮番茄钟，不强行把大主控面板弹到最前
    open_panel = bool(args.get("open_panel", False))

    cmd_payload: dict[str, Any] = {
        "action": action,
        "mode": mode,
        "force": force,
        "open_panel": open_panel,
    }
    if minutes is not None:
        cmd_payload["minutes"] = minutes
    if matched_task_id is not None:
        cmd_payload["task_id"] = matched_task_id
    if resolved_task_title:
        cmd_payload["task_title"] = resolved_task_title
    if "finish_task" in args:
        cmd_payload["finish_task"] = finish_task

    ack = await ctx.bus.dispatch_ui_command(
        "focus_control",
        cmd_payload,
        timeout=2.2,
    )

    result_obj = ack.get("result") if isinstance(ack.get("result"), dict) else {}
    timer_state = result_obj.get("state") if isinstance(result_obj.get("state"), dict) else {}

    # 冲突保护：前端已有计时器正在运行且未开启 force 覆盖
    if result_obj.get("conflict"):
        rem_sec = int(timer_state.get("remaining") or 0)
        rem_min = max(1, round(rem_sec / 60)) if rem_sec > 0 else 0
        running_task = str(timer_state.get("taskTitle") or "")
        return ToolExecutionResult(
            ok=False,
            tool_name="control_focus_timer",
            data={
                "conflict": True,
                "current_timer": timer_state,
                "remaining_minutes": rem_min,
                "current_task_title": running_task,
            },
            error=(
                f"当前已经有一个正在进行的计时器（剩余约 {rem_min} 分钟"
                + (f"，任务「{running_task}」" if running_task else "")
                + "）。未强制覆盖，请先温和告知用户当前进度并询问要继续还是重新开一个新的。"
            ),
        )

    if not ack.get("ok"):
        return ToolExecutionResult(
            ok=False,
            tool_name="control_focus_timer",
            data={"timeout": bool(ack.get("timeout")), "timer": timer_state},
            error=str(ack.get("error") or "控制番茄钟失败，请确认主控面板已打开。"),
        )

    # 拼装友好的轻量回执标签
    badge: str | None = None
    if action == "start":
        actual_min = int(timer_state.get("focusMinutes") or minutes or 25)
        task_suffix = f" · {resolved_task_title}" if resolved_task_title else ""
        if mode == "stopwatch":
            badge = f"⏱️ 已开启正计时{task_suffix}"
        else:
            badge = f"🍅 已开启 {actual_min} 分钟番茄钟{task_suffix}"
    elif action == "pause":
        badge = "⏸️ 已暂停番茄钟"
    elif action == "resume":
        badge = "▶️ 已继续番茄钟"
    elif action == "stop":
        badge = "⏹️ 已结束本次专注并记录"
    elif action == "skip_break":
        badge = "☕ 已跳过休息"

    return ToolExecutionResult(
        ok=True,
        tool_name="control_focus_timer",
        data={
            "action": action,
            "mode": mode,
            "bound_task_id": matched_task_id,
            "bound_task_title": resolved_task_title,
            "timer": timer_state,
        },
        badge=badge,
    )


# ==================== 6. 面板导航 ====================


async def _tool_open_dashboard_page(args: dict[str, Any], ctx: ToolContext) -> ToolExecutionResult:
    page = str(args.get("page") or "today").strip().lower()
    if page not in _PAGE_LABELS:
        return ToolExecutionResult(
            ok=False,
            tool_name="open_dashboard_page",
            error=f"未知的面板页面：{page}。可选：{', '.join(_PAGE_LABELS.keys())}",
        )

    payload: dict[str, Any] = {"page": page}
    if page == "journal" and args.get("date"):
        payload["date"] = _resolve_date(args.get("date"), ctx.date_str)

    ack = await ctx.bus.dispatch_ui_command("navigate", payload, timeout=2.0)
    if not ack.get("ok"):
        return ToolExecutionResult(
            ok=False,
            tool_name="open_dashboard_page",
            error=str(ack.get("error") or "未能切换到指定面板页面，请确认主控面板已连接。"),
        )

    label = _PAGE_LABELS[page]
    return ToolExecutionResult(
        ok=True,
        tool_name="open_dashboard_page",
        data={"page": page, "label": label},
        badge=f"🖥️ 已打开「{label}」",
    )


# ==================== 注册入口 ====================


def register_builtin_tools(registry: ToolRegistry) -> None:
    """将全部 v1 控制面板核心工具注册到指定 ToolRegistry。"""
    specs = [
        ToolSpec(
            name="get_daily_log",
            description="查询指定日期（默认今天）的复盘日记摘要、心情与精力评分、小确幸及习惯打卡记录。",
            parameters={
                "type": "object",
                "properties": {
                    "date": {"type": "string", "description": "日期 YYYY-MM-DD，不填默认为今天"},
                },
            },
            handler=_tool_get_daily_log,
            category="journal",
            filler_hint="好喔，我帮你翻一下今天的记录～",
            read_only=True,
        ),
        ToolSpec(
            name="record_daily_log",
            description=(
                "将用户口述的今天做的事、经历、复盘总结记录到今日日记，并可同时更新心情评分(1-5)、"
                "精力评分(1-5)及收录开心的小确幸。写入后会自动同步到本地 Markdown 日记。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "summary_append": {
                        "type": "string",
                        "description": "提炼后的今日活动/经历摘要，简洁自然，按事项整理",
                    },
                    "mood_score": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 5,
                        "description": "心情评分 1~5（仅当用户表达明显情绪时填写）",
                    },
                    "energy_score": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 5,
                        "description": "精力评分 1~5（仅当用户提到累/精力充沛等状态时填写）",
                    },
                    "highlights": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "今天开心的小事或成就（小确幸列表）",
                    },
                    "date": {"type": "string", "description": "日期 YYYY-MM-DD，不填默认今天"},
                },
            },
            handler=_tool_record_daily_log,
            category="journal",
            filler_hint="好喔，我这就帮你记到今天的日记里～",
            mutates_domains=("logs", "today"),
        ),
        ToolSpec(
            name="list_habits",
            description="查看当前启用中的每日习惯清单、今日打卡状态与连续完成天数。",
            parameters={
                "type": "object",
                "properties": {
                    "date": {"type": "string", "description": "日期 YYYY-MM-DD，不填默认今天"},
                },
            },
            handler=_tool_list_habits,
            category="habit",
            filler_hint="好喔，我帮你看一下今天的习惯清单～",
            read_only=True,
        ),
        ToolSpec(
            name="checkin_habit",
            description="为用户的某项每日习惯完成今日打卡（支持按 habit_id 或 habit_title 匹配）。当用户口述做了某件与预设习惯对应的事时可自动调用。",
            parameters={
                "type": "object",
                "properties": {
                    "habit_id": {"type": "integer", "description": "习惯 ID（已知时优先填写）"},
                    "habit_title": {"type": "string", "description": "习惯名称关键词（如 喝水、运动、早睡）"},
                    "status": {
                        "type": "string",
                        "enum": ["done", "partial", "missed"],
                        "description": "打卡状态：done 完成、partial 部分完成、missed 未完成",
                    },
                    "note": {"type": "string", "description": "简短备注（如 跑了3公里）"},
                    "date": {"type": "string", "description": "日期 YYYY-MM-DD，不填默认今天"},
                },
                "required": ["status"],
            },
            handler=_tool_checkin_habit,
            category="habit",
            filler_hint="好耶，我这就帮你把习惯打上卡～",
            mutates_domains=("habits", "logs", "today"),
            archive_skip_keys=("habit_updates",),
        ),
        ToolSpec(
            name="create_habit",
            description="新增一项长期坚持的每日习惯（非一次性待办）。",
            parameters={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "习惯名称，简短清晰"},
                    "category": {
                        "type": "string",
                        "enum": list(_VALID_HABIT_CATEGORIES),
                        "description": "习惯分类",
                    },
                    "target_desc": {"type": "string", "description": "每日目标描述，如 每天喝水 2000ml"},
                },
                "required": ["title"],
            },
            handler=_tool_create_habit,
            category="habit",
            filler_hint="好喔，我帮你把这项新习惯加进去～",
            mutates_domains=("habits", "today"),
        ),
        ToolSpec(
            name="list_tasks",
            description="查看待办任务清单：today（今日含逾期）、later（稍后/未排期）或 done（已完成）。",
            parameters={
                "type": "object",
                "properties": {
                    "scope": {
                        "type": "string",
                        "enum": ["today", "later", "done"],
                        "description": "任务范围，默认 today",
                    },
                    "on": {"type": "string", "description": "基准日期 YYYY-MM-DD，不填默认今天"},
                },
            },
            handler=_tool_list_tasks,
            category="task",
            filler_hint="好喔，我帮你翻一下待办清单～",
            read_only=True,
        ),
        ToolSpec(
            name="create_task",
            description="添加一条一次性待办任务。当用户说等下/今天/明天要做什么事时自动调用。",
            parameters={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "待办事项标题"},
                    "due_date": {
                        "type": "string",
                        "description": "截止/计划日期 YYYY-MM-DD；默认今天。若用户说稍后做可设 later=true",
                    },
                    "later": {
                        "type": "boolean",
                        "description": "为 true 时放入「稍后」无日期池",
                    },
                    "important": {"type": "boolean", "description": "是否标记为重要"},
                    "notes": {"type": "string", "description": "补充说明"},
                },
                "required": ["title"],
            },
            handler=_tool_create_task,
            category="task",
            filler_hint="好喔，我这就帮你记进待办里～",
            mutates_domains=("tasks", "today"),
        ),
        ToolSpec(
            name="update_task",
            description="更新待办任务状态（标记完成/重新打开）、顺延到明天或修改标题/日期/重要标记。不支持删除任务。",
            parameters={
                "type": "object",
                "properties": {
                    "task_id": {"type": "integer", "description": "任务 ID"},
                    "task_title": {"type": "string", "description": "任务标题关键词（用于定位任务）"},
                    "status": {"type": "string", "enum": ["open", "done"], "description": "目标状态"},
                    "postpone": {"type": "boolean", "description": "为 true 时顺延到明天"},
                    "title": {"type": "string", "description": "新标题"},
                    "due_date": {"type": "string", "description": "新计划日期 YYYY-MM-DD"},
                    "important": {"type": "boolean", "description": "是否重要"},
                },
            },
            handler=_tool_update_task,
            category="task",
            filler_hint="好喔，我马上帮你更新这条待办～",
            mutates_domains=("tasks", "today"),
        ),
        ToolSpec(
            name="list_memories",
            description="查询灵儿记住的长期记忆（个人喜好 preference、待跟进事件 ongoing_event、历史高光 highlight）。",
            parameters={
                "type": "object",
                "properties": {
                    "memory_type": {
                        "type": "string",
                        "enum": list(_VALID_MEMORY_TYPES),
                        "description": "按类型筛选",
                    },
                    "query": {"type": "string", "description": "关键词筛选"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 30},
                },
            },
            handler=_tool_list_memories,
            category="memory",
            filler_hint="嗯嗯，我想一下之前记下来的事喔～",
            read_only=True,
        ),
        ToolSpec(
            name="save_memory",
            description="保存一条值得长期记住的信息（用户喜好、近期需要关心的计划/考试/面试、或高光时刻）。",
            parameters={
                "type": "object",
                "properties": {
                    "content": {"type": "string", "description": "具体记忆内容"},
                    "memory_type": {
                        "type": "string",
                        "enum": list(_VALID_MEMORY_TYPES),
                        "description": "preference 个人喜好 / ongoing_event 近期关注事件 / highlight 高光时刻",
                    },
                    "follow_up_date": {
                        "type": "string",
                        "description": "可选跟进日期 YYYY-MM-DD",
                    },
                },
                "required": ["content"],
            },
            handler=_tool_save_memory,
            category="memory",
            filler_hint="好喔，我帮你牢牢记在心里～",
            mutates_domains=("memories",),
            archive_skip_keys=("new_memories",),
        ),
        ToolSpec(
            name="get_focus_overview",
            description="查询今日与累计的番茄钟数量、专注时长，以及前端当前正在运行的番茄钟状态。",
            parameters={
                "type": "object",
                "properties": {
                    "date": {"type": "string", "description": "日期 YYYY-MM-DD，默认今天"},
                },
            },
            handler=_tool_get_focus_overview,
            category="focus",
            filler_hint="好喔，我帮你看一下专注统计～",
            read_only=True,
        ),
        ToolSpec(
            name="control_focus_timer",
            description=(
                "控制控制面板里的番茄钟或正计时器：支持启动(start)、暂停(pause)、继续(resume)、"
                "结束并记录(stop)、跳过休息(skip_break)、查询当前计时状态(status)。"
                "支持自定义分钟数(1~180)和自动绑定待办任务。启动时默认自动切到番茄钟页；"
                "若已有计时在运行且 force=false 会返回冲突状态，请先询问用户再决定是否传 force=true 重开。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["start", "pause", "resume", "stop", "skip_break", "status"],
                        "description": "控制动作",
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["pomodoro", "stopwatch"],
                        "description": "计时模式：pomodoro 倒计时番茄钟（默认），stopwatch 正计时",
                    },
                    "minutes": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 180,
                        "description": "番茄钟自定义时长（分钟），1~180，默认 25",
                    },
                    "task_id": {"type": "integer", "description": "可选绑定的任务 ID"},
                    "task_title": {
                        "type": "string",
                        "description": "可选绑定的任务名称（会自动匹配今日待办，如 写周报、看书）",
                    },
                    "finish_task": {
                        "type": "boolean",
                        "description": "番茄钟结束后是否自动把绑定任务勾为完成",
                    },
                    "force": {
                        "type": "boolean",
                        "description": "若已有番茄钟在运行，仅在用户明确要求覆盖重开时传 true",
                    },
                    "open_panel": {
                        "type": "boolean",
                        "description": "是否同时把主控面板大窗口弹到前台，默认 false（由桌面灵儿飞到右上角变身悬浮番茄钟，无打扰专注）；仅当用户明确要求打开面板时传 true",
                    },
                },
                "required": ["action"],
            },
            handler=_tool_control_focus_timer,
            category="focus",
            filler_hint="好喔，我这就帮你调出番茄钟～",
        ),
        ToolSpec(
            name="open_dashboard_page",
            description="打开并切换灵儿控制面板到指定页面（如待办、番茄钟、习惯、日记、小确幸、记忆、洞察、设置）。",
            parameters={
                "type": "object",
                "properties": {
                    "page": {
                        "type": "string",
                        "enum": list(_PAGE_LABELS.keys()),
                        "description": "目标页面标识",
                    },
                    "date": {
                        "type": "string",
                        "description": "当 page=journal 时可选定位到指定日期 YYYY-MM-DD",
                    },
                },
                "required": ["page"],
            },
            handler=_tool_open_dashboard_page,
            category="navigation",
            filler_hint="好喔，我帮你把面板切过去～",
        ),
    ]

    for spec in specs:
        registry.register(spec)
