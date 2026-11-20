"""
每日复盘 Markdown 自动归档引擎
------------------------------
每次某日的复盘摘要、情绪/精力评分、习惯完成记录或「每日小确幸」发生变化时，
自动从 SQLite 汇总该日最新数据，重新渲染并写入：
    data/notes/daily/YYYY-MM-DD.md

文件头部包含标准 YAML Frontmatter，可直接放入 Obsidian 笔记库检索与做双链统计。
"""

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from app.database import DAILY_NOTES_DIR, db_cursor, ensure_data_dirs

# 习惯状态对应的 Markdown 复选框与中文标签
STATUS_BADGE = {
    "done": ("[x]", "已完成"),
    "partial": ("[-]", "部分完成"),
    "missed": ("[ ]", "未完成"),
}


def _safe_daily_md_path(date_str: str) -> tuple[str, Path]:
    """严格校验 YYYY-MM-DD 日期，防止路径穿越"""
    try:
        canonical = datetime.strptime(date_str.strip(), "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError as exc:
        raise ValueError(f"非法日期格式：{date_str!r}，须为 YYYY-MM-DD") from exc
    md_file = (DAILY_NOTES_DIR / f"{canonical}.md").resolve()
    base_dir = DAILY_NOTES_DIR.resolve()
    if md_file.parent != base_dir:
        raise ValueError(f"非法文件路径：{date_str!r}")
    return canonical, md_file


def _build_markdown_text(
    date_str: str,
    summary: str,
    mood_score: Any,
    energy_score: Any,
    highlights: list[str],
    habit_rows: list[Any],
    updated_at: str,
) -> str:
    total_habits = len(habit_rows)
    done_count = sum(1 for row in habit_rows if row["status"] == "done")

    lines: list[str] = [
        "---",
        f"date: {date_str}",
        "tags:",
        "  - taiwanbot",
        "  - daily-review",
        f"mood_score: {mood_score if mood_score is not None else 'null'}",
        f"energy_score: {energy_score if energy_score is not None else 'null'}",
        f"habits_done: {done_count}",
        f"habits_total: {total_habits}",
        f"updated_at: {updated_at}",
        "---",
        "",
        f"# {date_str} 每日复盘笔记",
        "",
        "## 状态概览",
        f"- **情绪评分**：{f'{mood_score} / 5' if mood_score is not None else '待记录'}",
        f"- **精力评分**：{f'{energy_score} / 5' if energy_score is not None else '待记录'}",
        f"- **习惯进度**：{done_count} / {total_habits}",
        "",
        "## 每日习惯清单",
    ]

    if not habit_rows:
        lines.append("- *尚未配置习惯清单*")
    else:
        for row in habit_rows:
            status = row["status"]
            if status in STATUS_BADGE:
                checkbox, label = STATUS_BADGE[status]
            else:
                checkbox, label = "[ ]", "待核对"
            note_suffix = f" —— {row['note']}" if row["note"] else ""
            lines.append(
                f"- {checkbox} **{row['habit_title']}**（{row['category']} · {label}）{note_suffix}"
            )

    lines.extend(
        [
            "",
            "## 今日复盘摘要",
            summary if summary.strip() else "*今天还没有写入复盘总结喔～*",
            "",
            "## 今日小确幸罐子",
        ]
    )

    if not highlights:
        lines.append("- *等待今晚和灵儿一起收集今日小确幸 ✨*")
    else:
        for item in highlights:
            lines.append(f"- ✨ {item}")

    lines.append("")
    return "\n".join(lines)


def _fetch_habit_rows(cur, date_str: str) -> list[Any]:
    cur.execute(
        """
        SELECT
            h.id AS habit_id,
            h.title AS habit_title,
            h.category AS category,
            hr.status AS status,
            hr.note AS note
        FROM habits h
        LEFT JOIN habit_records hr
            ON h.id = hr.habit_id AND hr.date = ?
        WHERE h.is_active = 1 OR hr.id IS NOT NULL
        ORDER BY h.id ASC;
        """,
        (date_str,),
    )
    return cur.fetchall()


def render_daily_markdown(date_str: str) -> tuple[str, str]:
    """
    纯只读渲染某日的每日复盘 Markdown 预览（不写数据库、不创建磁盘文件）。
    用于 GET /api/logs/{date_str}，避免浏览空白日期污染 daily_logs 与统计数据。
    """
    canonical, md_file = _safe_daily_md_path(date_str)
    with db_cursor() as cur:
        cur.execute("SELECT * FROM daily_logs WHERE date = ?;", (canonical,))
        log_row = cur.fetchone()
        habit_rows = _fetch_habit_rows(cur, canonical)

    if log_row is None:
        summary = ""
        mood_score = None
        energy_score = None
        highlights: list[str] = []
        updated_at = ""
        md_path = str(md_file) if md_file.is_file() else ""
    else:
        summary = log_row["summary"] or ""
        mood_score = log_row["mood_score"]
        energy_score = log_row["energy_score"]
        highlights = json.loads(log_row["highlights"] or "[]")
        updated_at = log_row["updated_at"] or ""
        md_path = log_row["md_path"] or (str(md_file) if md_file.is_file() else "")

    markdown_text = _build_markdown_text(
        date_str=canonical,
        summary=summary,
        mood_score=mood_score,
        energy_score=energy_score,
        highlights=highlights,
        habit_rows=habit_rows,
        updated_at=updated_at or datetime.now().isoformat(timespec="seconds"),
    )
    return md_path, markdown_text


def export_daily_markdown(date_str: str) -> tuple[str, str]:
    """
    根据指定日期（YYYY-MM-DD）的数据库数据，生成并原子保存对应的每日复盘 Markdown 文件。
    返回：(文件绝对路径字符串, Markdown 文本内容)
    """
    ensure_data_dirs()
    canonical, md_file = _safe_daily_md_path(date_str)
    now_iso = datetime.now().isoformat(timespec="seconds")

    with db_cursor() as cur:
        # 原子占位，避免并发 SELECT -> INSERT 竞态
        cur.execute(
            """
            INSERT OR IGNORE INTO daily_logs
                (date, summary, mood_score, energy_score, highlights, md_path, updated_at)
            VALUES (?, '', NULL, NULL, '[]', ?, ?);
            """,
            (canonical, str(md_file), now_iso),
        )
        cur.execute("SELECT * FROM daily_logs WHERE date = ?;", (canonical,))
        log_row = cur.fetchone()
        summary = (log_row["summary"] or "") if log_row else ""
        mood_score = log_row["mood_score"] if log_row else None
        energy_score = log_row["energy_score"] if log_row else None
        highlights = json.loads(log_row["highlights"] or "[]") if log_row else []
        habit_rows = _fetch_habit_rows(cur, canonical)

        markdown_text = _build_markdown_text(
            date_str=canonical,
            summary=summary,
            mood_score=mood_score,
            energy_score=energy_score,
            highlights=highlights,
            habit_rows=habit_rows,
            updated_at=now_iso,
        )

        # 原子写入临时文件再替换，避免并发写入导致文件截断
        tmp_file = md_file.with_name(f".{md_file.name}.{os.getpid()}.{id(markdown_text)}.tmp")
        try:
            tmp_file.write_text(markdown_text, encoding="utf-8")
            os.replace(tmp_file, md_file)
        finally:
            if tmp_file.exists():
                tmp_file.unlink(missing_ok=True)

        cur.execute(
            "UPDATE daily_logs SET md_path = ?, updated_at = ? WHERE date = ?;",
            (str(md_file), now_iso, canonical),
        )

    return str(md_file), markdown_text
