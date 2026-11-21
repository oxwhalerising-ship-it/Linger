"""
周报与月报分析路由（/api/reports）
---------------------------------
提供一键生成周报/月报（含台湾腔 AI 点评与 Obsidian Markdown 导出）及历史报告查询接口。
"""

import json
from datetime import date, timedelta
from typing import Literal
from app.database import db_cursor
from app.services.report_service import _collect_period_stats, _resolve_period_range, render_report_markdown
from fastapi import APIRouter, HTTPException, Query

from app.schemas import ReportGenerateRequest
from app.services.report_service import generate_period_report, list_saved_reports

router = APIRouter(prefix="/api/reports", tags=["Reports"])


@router.get("")
def get_reports(limit: int = Query(default=20, ge=1, le=100)):
    """获取历史生成的周报与月报列表"""
    return {"reports": list_saved_reports(limit=limit)}


@router.post("/generate")
def create_report(payload: ReportGenerateRequest):
    """按指定周期（weekly / monthly）立即生成一份带台湾腔点评的复盘报告"""
    try:
        return generate_period_report(
            period_type=payload.period_type,
            end_date_str=payload.end_date,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"日期格式错误：{exc}") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"生成周期报告失败：{exc}") from exc

@router.get("/insights")
def insights(period_type: Literal["weekly","monthly"], end_date: date):
    first, last, _ = _resolve_period_range(period_type, end_date.isoformat())
    stats = _collect_period_stats(first,last)
    with db_cursor() as cur:
        rows = cur.execute("""SELECT date, COUNT(*) AS count FROM habit_records
            WHERE status='done' AND date BETWEEN ? AND ? GROUP BY date""",
            ((end_date-timedelta(days=89)).isoformat(),last))
        stats["activity"] = {r["date"]: r["count"] for r in rows}
        days = cur.execute("SELECT DISTINCT date FROM habit_records WHERE status='done' AND date<=? ORDER BY date DESC",
                           (min(end_date,date.today()).isoformat(),))
        expected = min(end_date,date.today())
        streak = 0
        for row in days:
            if row["date"] != expected.isoformat():
                break
            streak += 1
            expected -= timedelta(days=1)
        stats["streak"] = streak
    return stats

@router.get("/{report_id}/markdown")
def report_markdown(report_id: int):
    with db_cursor() as cur:
        row = cur.execute("SELECT * FROM reports WHERE id=?", (report_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "报告不存在")
        # Export the selected snapshot even when multiple reports cover the same week.
        stats = json.loads(row["stats_json"])
        _, _, stem = _resolve_period_range(row["period_type"],row["end_date"])
        return {"text":render_report_markdown(row["period_type"],stem,stats,row["ai_analysis"],row["created_at"])}
