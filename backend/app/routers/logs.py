"""
每日复盘与习惯打卡路由（/api/logs）
-----------------------------------
提供按月查询复盘热力图、查看/更新某日复盘摘要与小确幸、
以及写入/覆盖某日习惯打卡记录的接口；每次写入都会自动同步更新本地 Markdown 日记。
"""

import json
import re
from datetime import datetime
from fastapi import Body, APIRouter, HTTPException, Query

from app.database import db_cursor
from app.schemas import DailyLogOut, DailyLogUpsert, HabitRecordOut, HabitRecordUpsert
from app.services.markdown_exporter import export_daily_markdown, render_daily_markdown

router = APIRouter(prefix="/api/logs", tags=["DailyLogs"])


def _validate_date(date_str: str) -> str:
    """严格校验日期字符串必须为合法公历 YYYY-MM-DD"""
    try:
        return datetime.strptime(date_str.strip(), "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="日期格式必须为合法的 YYYY-MM-DD") from exc


def _validate_month(month_str: str) -> str:
    """严格校验月份字符串必须为合法 YYYY-MM"""
    try:
        return datetime.strptime(month_str.strip(), "%Y-%m").strftime("%Y-%m")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="月份格式必须为合法的 YYYY-MM") from exc


def _build_daily_log_response(date_str: str, md_path: str, md_content: str) -> DailyLogOut:
    """组装某日完整复盘响应（含打卡详情与最新 Markdown 文本）"""
    with db_cursor() as cur:
        cur.execute("SELECT * FROM daily_logs WHERE date = ?;", (date_str,))
        log_row = cur.fetchone()
        cur.execute(
            """
            SELECT
                hr.habit_id,
                h.title AS habit_title,
                h.category AS category,
                hr.status,
                hr.note,
                hr.recorded_at
            FROM habit_records hr
            JOIN habits h ON h.id = hr.habit_id
            WHERE hr.date = ?
            ORDER BY hr.habit_id ASC;
            """,
            (date_str,),
        )
        record_rows = cur.fetchall()

    return DailyLogOut(
        date=date_str,
        summary=log_row["summary"] if log_row else "",
        mood_score=log_row["mood_score"] if log_row else None,
        energy_score=log_row["energy_score"] if log_row else None,
        highlights=json.loads(log_row["highlights"] or "[]") if log_row else [],
        md_path=md_path,
        updated_at=log_row["updated_at"] if log_row else "",
        habit_records=[
            HabitRecordOut(
                habit_id=r["habit_id"],
                habit_title=r["habit_title"],
                category=r["category"],
                status=r["status"],
                note=r["note"],
                recorded_at=r["recorded_at"],
            )
            for r in record_rows
        ],
        markdown_content=md_content,
    )


@router.get("")
def list_monthly_logs(
    month: str = Query(..., description="月份，格式 YYYY-MM，例如 2026-11"),
):
    """获取指定月份的每日复盘概览与习惯完成热力图数据"""
    month = _validate_month(month)

    like_prefix = f"{month}-%"
    with db_cursor() as cur:
        cur.execute(
            """
            SELECT date, summary, mood_score, energy_score, highlights, md_path, updated_at
            FROM daily_logs
            WHERE date LIKE ?
            ORDER BY date ASC;
            """,
            (like_prefix,),
        )
        log_rows = cur.fetchall()

        cur.execute(
            """
            SELECT date,
                   SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_count,
                   COUNT(*) AS recorded_count
            FROM habit_records
            WHERE date LIKE ?
            GROUP BY date;
            """,
            (like_prefix,),
        )
        stat_map = {r["date"]: dict(r) for r in cur.fetchall()}

    items = []
    for row in log_rows:
        date_str = row["date"]
        stats = stat_map.get(date_str, {"done_count": 0, "recorded_count": 0})
        items.append(
            {
                "date": date_str,
                "summary": row["summary"],
                "mood_score": row["mood_score"],
                "energy_score": row["energy_score"],
                "highlights": json.loads(row["highlights"] or "[]"),
                "done_count": stats["done_count"],
                "recorded_count": stats["recorded_count"],
                "md_path": row["md_path"],
                "updated_at": row["updated_at"],
            }
        )
    return {"month": month, "days": items}


@router.get("/{date_str}", response_model=DailyLogOut)
def get_daily_log(date_str: str):
    """只读获取某日完整复盘记录与 Markdown 预览（不污染数据库或磁盘）"""
    canonical = _validate_date(date_str)
    md_path, md_content = render_daily_markdown(canonical)
    return _build_daily_log_response(canonical, md_path, md_content)


@router.put("/{date_str}", response_model=DailyLogOut)
def upsert_daily_log(date_str: str, payload: DailyLogUpsert):
    """创建或更新某日的复盘摘要、情绪/精力评分及「每日小确幸」，并自动导出 Markdown"""
    canonical = _validate_date(date_str)
    now_iso = datetime.now().isoformat(timespec="seconds")

    with db_cursor() as cur:
        cur.execute(
            """
            INSERT OR IGNORE INTO daily_logs
                (date, summary, mood_score, energy_score, highlights, md_path, updated_at)
            VALUES (?, '', NULL, NULL, '[]', '', ?);
            """,
            (canonical, now_iso),
        )
        cur.execute("SELECT * FROM daily_logs WHERE date = ?;", (canonical,))
        existing = cur.fetchone()

        summary = payload.summary if payload.summary is not None else existing["summary"]
        mood_score = payload.mood_score if payload.mood_score is not None else existing["mood_score"]
        energy_score = payload.energy_score if payload.energy_score is not None else existing["energy_score"]
        highlights = (
            payload.highlights
            if payload.highlights is not None
            else json.loads(existing["highlights"] or "[]")
        )
        cur.execute(
            """
            UPDATE daily_logs
            SET summary = ?, mood_score = ?, energy_score = ?, highlights = ?, updated_at = ?
            WHERE date = ?;
            """,
            (
                summary,
                mood_score,
                energy_score,
                json.dumps(highlights, ensure_ascii=False),
                now_iso,
                canonical,
            ),
        )

    md_path, md_content = export_daily_markdown(canonical)
    return _build_daily_log_response(canonical, md_path, md_content)


@router.post("/{date_str}/habits", response_model=DailyLogOut)
def record_daily_habit(date_str: str, payload: HabitRecordUpsert):
    """记录或更新某日某项习惯的完成状态（UPSERT），并自动刷新当日 Markdown 日记"""
    canonical = _validate_date(date_str)
    now_iso = datetime.now().isoformat(timespec="seconds")

    with db_cursor() as cur:
        # 先确认习惯存在
        cur.execute("SELECT id FROM habits WHERE id = ?;", (payload.habit_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="找不到对应的习惯项")

        # 若当日已有记录则更新，否则插入（支持白天静默记录 + 晚间复盘核对修正）
        cur.execute(
            """
            INSERT INTO habit_records (date, habit_id, status, note, recorded_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(date, habit_id) DO UPDATE SET
                status = excluded.status,
                note = excluded.note,
                recorded_at = excluded.recorded_at;
            """,
            (canonical, payload.habit_id, payload.status, payload.note, now_iso),
        )

    md_path, md_content = export_daily_markdown(canonical)
    return _build_daily_log_response(canonical, md_path, md_content)

@router.get("/highlights/list")
def list_highlights(month: str):
    month = _validate_month(month)
    with db_cursor() as cur:
        return [dict(r) for r in cur.execute(
            "SELECT id,date,content,favorite FROM highlights WHERE date LIKE ? ORDER BY date DESC,id",
            (month + "-%",))]

@router.put("/highlights/{highlight_id}/favorite")
def favorite_highlight(highlight_id: int, favorite: bool):
    with db_cursor() as cur:
        if not cur.execute("UPDATE highlights SET favorite=? WHERE id=?", (int(favorite), highlight_id)).rowcount:
            raise HTTPException(404, "条目已删除")
    return {"favorite": favorite}

@router.post("/{date_str}/highlights")
def append_highlight(date_str: str, content: str = Body(embed=True, min_length=1, max_length=2000)):
    canonical = _validate_date(date_str)
    if not content.strip():
        raise HTTPException(422, "请输入内容")
    with db_cursor() as cur:
        cur.execute("""INSERT INTO daily_logs(date,highlights,updated_at) VALUES (?,json_array(?),?)
            ON CONFLICT(date) DO UPDATE SET highlights=json_insert(daily_logs.highlights,'$[#]',?),
            updated_at=excluded.updated_at""",
            (canonical,content.strip(),datetime.now().isoformat(timespec="seconds"),content.strip()))
    path, md = export_daily_markdown(canonical)
    return _build_daily_log_response(canonical,path,md)
