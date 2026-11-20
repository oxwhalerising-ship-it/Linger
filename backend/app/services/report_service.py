"""
周报与月报 AI 周期性复盘分析服务（Report Service）
-------------------------------------------------
核心能力：
1. 聚合指定周期（近 7 天周报 / 近 30 天或当月月报）的习惯达成统计、每日情绪精力曲线、
   以及「每日小确幸罐子」汇总。
2. 若已配置大模型 API Key，则调用大模型生成俏皮温暖台湾腔的深度洞察与下周期微调建议；
   若未配置 API Key，则自动使用高质量本地统计 + 台湾腔暖心点评模板生成，确保离线可用。
3. 持久化至 SQLite `reports` 表，并同步导出 Obsidian 兼容的 `.md` 报告至
   `data/notes/weekly/` 或 `data/notes/monthly/`。
"""

import json
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Literal, Optional
from openai import OpenAI

from app.database import MONTHLY_NOTES_DIR, WEEKLY_NOTES_DIR, db_cursor, ensure_data_dirs


def _resolve_period_range(
    period_type: Literal["weekly", "monthly"],
    end_date_str: Optional[str] = None,
) -> tuple[str, str, str]:
    """
    计算统计周期的起止日期及对应的 Markdown 文件名标识。
    返回：(start_date, end_date, file_stem)
    """
    if end_date_str:
        end_dt = date.fromisoformat(end_date_str)
    else:
        end_dt = date.today()

    if period_type == "weekly":
        start_dt = end_dt - timedelta(days=6)
        iso_year, iso_week, _ = end_dt.isocalendar()
        file_stem = f"{iso_year}-W{iso_week:02d}"
    else:
        start_dt = end_dt.replace(day=1)
        file_stem = end_dt.strftime("%Y-%m")

    return start_dt.isoformat(), end_dt.isoformat(), file_stem


def _collect_period_stats(start_date: str, end_date: str) -> dict[str, Any]:
    """从 SQLite 汇总周期内的习惯完成度、情绪/精力曲线与小确幸列表"""
    with db_cursor() as cur:
        # 1. 查询启用中的习惯清单
        cur.execute("SELECT id, title, category FROM habits WHERE is_active = 1 ORDER BY id ASC;")
        active_habits = [dict(r) for r in cur.fetchall()]

        # 2. 查询周期内每日复盘主表
        cur.execute(
            """
            SELECT date, summary, mood_score, energy_score, highlights
            FROM daily_logs
            WHERE date >= ? AND date <= ?
            ORDER BY date ASC;
            """,
            (start_date, end_date),
        )
        daily_rows = [dict(r) for r in cur.fetchall()]

        # 3. 查询周期内习惯打卡记录
        cur.execute(
            """
            SELECT hr.date, hr.habit_id, h.title, h.category, hr.status, hr.note
            FROM habit_records hr
            JOIN habits h ON h.id = hr.habit_id
            WHERE hr.date >= ? AND hr.date <= ?
            ORDER BY hr.date ASC;
            """,
            (start_date, end_date),
        )
        record_rows = [dict(r) for r in cur.fetchall()]

    # 构建情绪/精力趋势曲线与小确幸罐子汇总
    trend: list[dict[str, Any]] = []
    all_highlights: list[dict[str, str]] = []
    mood_values: list[int] = []
    energy_values: list[int] = []

    for row in daily_rows:
        m = row["mood_score"]
        e = row["energy_score"]
        if isinstance(m, int):
            mood_values.append(m)
        if isinstance(e, int):
            energy_values.append(e)
        trend.append(
            {
                "date": row["date"],
                "mood_score": m,
                "energy_score": e,
            }
        )
        for hl in json.loads(row["highlights"] or "[]"):
            if str(hl).strip():
                all_highlights.append({"date": row["date"], "text": str(hl).strip()})

    # 计算总天数（含起止日）
    start_dt = date.fromisoformat(start_date)
    end_dt = date.fromisoformat(end_date)
    total_days = max((end_dt - start_dt).days + 1, 1)

    # 按习惯汇总达成率
    habit_counter: dict[int, dict[str, Any]] = {
        h["id"]: {
            "habit_id": h["id"],
            "title": h["title"],
            "category": h["category"],
            "done": 0,
            "partial": 0,
            "missed": 0,
        }
        for h in active_habits
    }
    for rec in record_rows:
        hid = rec["habit_id"]
        if hid not in habit_counter:
            habit_counter[hid] = {
                "habit_id": hid,
                "title": rec["title"],
                "category": rec["category"],
                "done": 0,
                "partial": 0,
                "missed": 0,
            }
        habit_counter[hid][rec["status"]] += 1

    habit_breakdown: list[dict[str, Any]] = []
    total_done_equiv = 0.0
    total_possible = max(len(habit_counter) * total_days, 1)

    for item in habit_counter.values():
        score_equiv = item["done"] + item["partial"] * 0.5
        total_done_equiv += score_equiv
        rate = round(min(score_equiv / total_days, 1.0) * 100, 1)
        habit_breakdown.append({**item, "completion_rate": rate})

    habit_breakdown.sort(key=lambda x: x["completion_rate"], reverse=True)

    overall_rate = (
        round(min(total_done_equiv / total_possible, 1.0) * 100, 1)
        if habit_counter
        else 0.0
    )

    return {
        "start_date": start_date,
        "end_date": end_date,
        "total_days": total_days,
        "logged_days": len(daily_rows),
        "overall_completion_rate": overall_rate,
        "avg_mood": round(sum(mood_values) / len(mood_values), 2) if mood_values else None,
        "avg_energy": round(sum(energy_values) / len(energy_values), 2) if energy_values else None,
        "habit_breakdown": habit_breakdown,
        "trend": trend,
        "highlights": all_highlights,
    }


def _load_llm_settings() -> tuple[str, dict[str, Any]]:
    """读取 bot_name 与 llm 配置"""
    with db_cursor() as cur:
        cur.execute("SELECT key, value FROM settings WHERE key IN ('bot_name', 'llm');")
        rows = {r["key"]: json.loads(r["value"]) for r in cur.fetchall()}
    return rows.get("bot_name", "灵儿"), rows.get("llm", {})


def _build_offline_taiwan_analysis(
    bot_name: str,
    period_type: Literal["weekly", "monthly"],
    stats: dict[str, Any],
) -> str:
    """当用户尚未配置 LLM API Key 时，使用高质量台湾腔暖心模板生成周期复盘"""
    period_label = "这一周" if period_type == "weekly" else "这个月"
    rate = stats["overall_completion_rate"]
    logged_days = stats["logged_days"]
    avg_mood = stats["avg_mood"]
    avg_energy = stats["avg_energy"]
    habits = stats["habit_breakdown"]
    highlights = stats["highlights"]

    lines: list[str] = [
        f"欸～先给你一个大大的拥抱喔！{period_label}你一共认真记录了 **{logged_days} 天**，整体习惯达成率来到 **{rate}%** 耶！",
        "",
        "### 1. 闪闪发光的进步亮点",
    ]

    if habits:
        top = habits[0]
        lines.append(
            f"- 表现最稳的是「**{top['title']}**」，完成度高达 **{top['completion_rate']}%**，真的超厉害的捏！"
        )
    else:
        lines.append("- 目前还没有建立习惯清单喔～可以在左侧「习惯清单」先加 2~3 个最轻松的小目标开始啦！")

    if avg_mood is not None or avg_energy is not None:
        mood_txt = f"{avg_mood}/5" if avg_mood is not None else "待记录"
        energy_txt = f"{avg_energy}/5" if avg_energy is not None else "待记录"
        lines.append(
            f"- {period_label}平均情绪分 **{mood_txt}**、平均精力分 **{energy_txt}**，愿意觉察自己的状态本身就很棒喔～"
        )

    lines.append("")
    lines.append("### 2. 温柔微调小建议")
    if len(habits) >= 2 and habits[-1]["completion_rate"] < 60:
        weak = habits[-1]
        lines.append(
            f"- 「**{weak['title']}**」{period_label}稍微卡了一点点（{weak['completion_rate']}%），没关系啦拍拍你～下个周期要不要先把它拆小一半，做起来更无痛喔！"
        )
    else:
        lines.append("- 现在的节奏蛮稳的耶！继续保持这种不紧绷、细水长流的步调就很可以啦～")

    lines.append("")
    lines.append("### 3. 你的小确幸罐子回顾")
    if highlights:
        for hl in highlights[-5:]:
            lines.append(f"- `{hl['date']}` {hl['text']}")
    else:
        lines.append("- 罐子里还空空的捏～今晚复盘时记得跟我分享一件哪怕很小的开心事，我帮你好好收起来喔！")

    lines.append("")
    lines.append(f"—— 一直挺你的 {bot_name} 💛")
    return "\n".join(lines)


def _generate_ai_analysis(
    period_type: Literal["weekly", "monthly"],
    stats: dict[str, Any],
) -> tuple[str, bool]:
    """调用大模型生成台湾腔周期复盘；未配置 Key 或调用失败时平滑降级为本地暖心模板"""
    bot_name, llm_cfg = _load_llm_settings()
    api_key = (llm_cfg.get("api_key") or "").strip()
    if not api_key:
        return _build_offline_taiwan_analysis(bot_name, period_type, stats), False

    base_url = (
        llm_cfg.get("base_url")
        or "https://generativelanguage.googleapis.com/v1beta/openai/"
    ).strip()
    model_name = (llm_cfg.get("model") or "gemini-2.5-flash").strip()
    period_label = "周报" if period_type == "weekly" else "月报"

    system_prompt = (
        f"你是「{bot_name}」，一位说话带有自然台湾腔（适度使用欸～、喔、啦、捏、耶、很可以、拍拍你等语气词）、"
        "俏皮可爱、温暖善良且极度善于提供情绪价值的私人生活小管家。\n"
        f"请根据用户的{period_label}统计数据，用 Markdown 输出一份真诚、有活人感、不爹味、不说教的复盘报告，"
        "包含以下三个小节：\n"
        "### 1. 闪闪发光的进步亮点\n"
        "### 2. 温柔微调小建议（指出最容易卡壳的习惯，给出轻松无痛的减负策略）\n"
        "### 3. 暖心打气与下周期祝福（结合用户的小确幸给予情绪价值）\n"
        "总字数控制在 280~450 字，排版清爽自然。"
    )

    try:
        client = OpenAI(api_key=api_key, base_url=base_url)
        completion = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": f"以下是我的{period_label}统计数据（JSON）：\n{json.dumps(stats, ensure_ascii=False)}",
                },
            ],
            temperature=0.75,
        )
        content = (completion.choices[0].message.content or "").strip()
        if content:
            return content, True
    except Exception:
        pass

    return _build_offline_taiwan_analysis(bot_name, period_type, stats), False


def _export_report_markdown(
    period_type: Literal["weekly", "monthly"],
    file_stem: str,
    stats: dict[str, Any],
    analysis_md: str,
) -> Path:
    """将周期报告导出为 Obsidian 兼容的本地 Markdown 文件"""
    ensure_data_dirs()
    target_dir = WEEKLY_NOTES_DIR if period_type == "weekly" else MONTHLY_NOTES_DIR
    md_path = target_dir / f"{file_stem}.md"

    title_label = "每周成长复盘" if period_type == "weekly" else "每月成长复盘"
    lines: list[str] = [
        "---",
        f"type: {period_type}_report",
        f"period: {file_stem}",
        f"start_date: {stats['start_date']}",
        f"end_date: {stats['end_date']}",
        f"completion_rate: {stats['overall_completion_rate']}",
        f"avg_mood: {stats['avg_mood'] if stats['avg_mood'] is not None else 'null'}",
        f"avg_energy: {stats['avg_energy'] if stats['avg_energy'] is not None else 'null'}",
        f"generated_at: {datetime.now().isoformat(timespec='seconds')}",
        "---",
        "",
        f"# {file_stem} {title_label}",
        "",
        f"> 统计区间：`{stats['start_date']}` ~ `{stats['end_date']}`｜记录天数：`{stats['logged_days']}/{stats['total_days']}` 天｜综合习惯达成率：`{stats['overall_completion_rate']}%`",
        "",
        "## 灵儿的台湾腔复盘点评",
        "",
        analysis_md,
        "",
        "## 习惯达成明细",
        "",
    ]

    if stats["habit_breakdown"]:
        for h in stats["habit_breakdown"]:
            lines.append(
                f"- **{h['title']}**（{h['category']}）：完成 {h['done']} 天 / 部分 {h['partial']} 天 / 未完成 {h['missed']} 天（达成率 {h['completion_rate']}%）"
            )
    else:
        lines.append("- 暂无习惯记录")

    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return md_path


def generate_period_report(
    period_type: Literal["weekly", "monthly"] = "weekly",
    end_date_str: Optional[str] = None,
) -> dict[str, Any]:
    """生成并持久化一份周报或月报"""
    start_date, end_date, file_stem = _resolve_period_range(period_type, end_date_str)
    stats = _collect_period_stats(start_date, end_date)
    analysis_md, used_llm = _generate_ai_analysis(period_type, stats)
    md_path = _export_report_markdown(period_type, file_stem, stats, analysis_md)
    now_iso = datetime.now().isoformat(timespec="seconds")

    with db_cursor() as cur:
        cur.execute(
            """
            INSERT INTO reports (period_type, start_date, end_date, stats_json, ai_analysis, md_path, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?);
            """,
            (
                period_type,
                start_date,
                end_date,
                json.dumps(stats, ensure_ascii=False),
                analysis_md,
                str(md_path),
                now_iso,
            ),
        )
        report_id = cur.lastrowid

    return {
        "id": report_id,
        "period_type": period_type,
        "start_date": start_date,
        "end_date": end_date,
        "stats": stats,
        "ai_analysis": analysis_md,
        "used_llm": used_llm,
        "md_path": str(md_path),
        "created_at": now_iso,
    }


def list_saved_reports(limit: int = 20) -> list[dict[str, Any]]:
    """查询历史生成的周报/月报列表（按最新优先排序）"""
    with db_cursor() as cur:
        cur.execute(
            """
            SELECT id, period_type, start_date, end_date, stats_json, ai_analysis, md_path, created_at
            FROM reports
            ORDER BY id DESC
            LIMIT ?;
            """,
            (limit,),
        )
        rows = cur.fetchall()

    return [
        {
            "id": r["id"],
            "period_type": r["period_type"],
            "start_date": r["start_date"],
            "end_date": r["end_date"],
            "stats": json.loads(r["stats_json"] or "{}"),
            "ai_analysis": r["ai_analysis"],
            "md_path": r["md_path"],
            "created_at": r["created_at"],
        }
        for r in rows
    ]
