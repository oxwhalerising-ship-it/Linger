"""
周报与月报分析路由（/api/reports）
---------------------------------
提供一键生成周报/月报（含台湾腔 AI 点评与 Obsidian Markdown 导出）及历史报告查询接口。
"""

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
