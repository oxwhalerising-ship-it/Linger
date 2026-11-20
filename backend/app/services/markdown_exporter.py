"""
每日复盘 Markdown 自动归档引擎
------------------------------
每次某日的复盘摘要、情绪/精力评分、习惯完成记录或「每日小确幸」发生变化时，
自动从 SQLite 汇总该日最新数据，重新渲染并写入：
    data/notes/daily/YYYY-MM-DD.md

文件头部包含标准 YAML Frontmatter，可直接放入 Obsidian 笔记库检索与做双链统计。
"""

import json
from datetime import datetime
from pathlib import Path

from app.database import DAILY_NOTES_DIR, db_cursor, ensure_data_dirs

# 习惯状态对应的 Markdown 复选框与中文标签
STATUS_BADGE = {
    "done": ("[x]", "已完成"),
    "partial": ("[-]", "部分完成"),
    "missed": ("[ ]", "未完成"),
}


def export_daily_markdown(date_str: str) -> tuple[str, str]:
    """
    根据指定日期（YYYY-MM-DD）的数据库数据，生成并保存对应的每日复盘 Markdown 文件。
    返回：(文件绝对路径字符串, Markdown 文本内容)
    """
    ensure_data_dirs()
    now_iso = datetime.now().isoformat(timespec="seconds")
    md_file: Path = DAILY_NOTES_DIR / f"{date_str}.md"

    with db_cursor() as cur:
        # 1. 读取当日 daily_logs（若尚无记录则先创建占位行）
        cur.execute("SELECT * FROM daily_logs WHERE date = ?;", (date_str,))
        log_row = cur.fetchone()
        if log_row is None:
            cur.execute(
                """
                INSERT INTO daily_logs (date, summary, mood_score, energy_score, highlights, md_path, updated_at)
                VALUES (?, '', NULL, NULL, '[]', ?, ?);
                """,
                (date_str, str(md_file), now_iso),
            )
            summary = ""
            mood_score = None
            energy_score = None
            highlights: list[str] = []
        else:
            summary = log_row["summary"] or ""
            mood_score = log_row["mood_score"]
            energy_score = log_row["energy_score"]
            highlights = json.loads(log_row["highlights"] or "[]")

        # 2. 读取全部启用中的习惯，并左连接当日打卡记录（这样未记录的习惯也能清晰展示）
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
        habit_rows = cur.fetchall()

        # 3. 统计完成数
        total_habits = len(habit_rows)
        done_count = sum(1 for row in habit_rows if row["status"] == "done")

        # 4. 拼接 Obsidian 兼容的 YAML Frontmatter 与正文
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
            f"updated_at: {now_iso}",
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
        markdown_text = "\n".join(lines)

        # 5. 写入本地 UTF-8 文件并同步更新数据库中的 md_path
        md_file.write_text(markdown_text, encoding="utf-8")
        cur.execute(
            "UPDATE daily_logs SET md_path = ?, updated_at = ? WHERE date = ?;",
            (str(md_file), now_iso, date_str),
        )

    return str(md_file), markdown_text
