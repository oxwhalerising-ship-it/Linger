"""
全天作息定时管家与「随机冒泡」主动陪伴引擎（APScheduler）
-------------------------------------------------------
核心职责：
1. 根据 settings 表中的 `schedule` 配置，在 AsyncIOScheduler 中注册：
   - 4 个固定每日作息节点：早安规划、午间提醒、晚间复盘、睡前催睡
   - 每日活跃时段内的 1~3 次「随机冒泡」主动关心
2. 支持点击「稍后再聊（默认 15 分钟后）」动态创建一次性延后任务（DateTrigger）。
3. 支持一键切换免打扰（DND）模式，免打扰期间所有定时与随机提醒均静默跳过。
4. 触发时结合当日待核对习惯与台湾腔暖心语库，通过 WebSocket `/ws/events` 推送给桌宠。
"""

import json
import random
from datetime import datetime, timedelta
from typing import Any, Literal
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger

from app.database import DEFAULT_SETTINGS, db_cursor
from app.services.event_bus import event_bus
from app.services.tts_provider import split_sentences_for_streaming

ScheduleEventType = Literal[
    "morning_plan",
    "noon_checkin",
    "evening_review",
    "bedtime_nudge",
    "random_bubble",
]

# 全局异步调度器实例
_scheduler: AsyncIOScheduler | None = None

# 随机冒泡的台湾腔俏皮暖心语库
RANDOM_BUBBLE_POOL: list[tuple[str, str]] = [
    ("happy", "欸～忙了这么久，记得抬起头看看窗外、喝一口温开水喔！"),
    ("encouraging", "偷偷冒出来拍拍你～你刚刚专心的样子真的很帅捏，继续保持喔！"),
    ("happy", "是说～肩膀是不是有点紧啦？跟我一起耸耸肩再放松三秒钟吧！"),
    ("encouraging", "嗨啰～只是想过来跟你说一声，今天你已经做得超棒了啦！"),
    ("speaking", "欸跟你讲喔，眼睛看屏幕太久会酸捏，稍微眨眨眼休息一下下啦～"),
]


def load_schedule_settings() -> dict[str, Any]:
    """从 SQLite settings 表读取作息与随机冒泡配置，缺失字段用默认配置补齐"""
    defaults = json.loads(json.dumps(DEFAULT_SETTINGS["schedule"]))
    with db_cursor() as cur:
        cur.execute("SELECT value FROM settings WHERE key = 'schedule';")
        row = cur.fetchone()
    if row:
        saved = json.loads(row["value"])
        if isinstance(saved, dict):
            defaults.update(saved)
    return defaults


def set_dnd_enabled(enabled: bool) -> dict[str, Any]:
    """持久化更新免打扰开关状态"""
    cfg = load_schedule_settings()
    cfg["dnd_enabled"] = bool(enabled)
    now_iso = datetime.now().isoformat(timespec="seconds")
    with db_cursor() as cur:
        cur.execute(
            """
            INSERT INTO settings (key, value, updated_at)
            VALUES ('schedule', ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at;
            """,
            (json.dumps(cfg, ensure_ascii=False), now_iso),
        )
    return cfg


def _parse_hhmm(time_str: str, fallback_h: int, fallback_m: int) -> tuple[int, int]:
    """安全解析 HH:MM 时间字符串"""
    try:
        parts = str(time_str).strip().split(":")
        h = int(parts[0])
        m = int(parts[1])
        if 0 <= h <= 23 and 0 <= m <= 59:
            return h, m
    except Exception:
        pass
    return fallback_h, fallback_m


def _get_today_habit_summary() -> tuple[int, int]:
    """统计今日启用习惯总数与已完成数，让主动提醒更有针对性"""
    today_str = datetime.now().strftime("%Y-%m-%d")
    with db_cursor() as cur:
        cur.execute("SELECT COUNT(*) AS cnt FROM habits WHERE is_active = 1;")
        total = int(cur.fetchone()["cnt"])
        cur.execute(
            "SELECT COUNT(*) AS cnt FROM habit_records WHERE date = ? AND status = 'done';",
            (today_str,),
        )
        done = int(cur.fetchone()["cnt"])
    return total, done


def _compose_nudge_payload(
    event_type: ScheduleEventType,
    is_snoozed: bool = False,
    snooze_minutes: int = 15,
) -> dict[str, Any]:
    """根据节点类型组装台湾腔主动关怀事件载荷"""
    total_habits, done_habits = _get_today_habit_summary()
    pending_count = max(total_habits - done_habits, 0)
    prefix = f"欸～{snooze_minutes} 分钟到啰，我又轻轻探头来找你啦！" if is_snoozed else ""

    if event_type == "morning_plan":
        emotion = "happy"
        title = "早安规划"
        text = (
            f"{prefix}早安呀～新的一天开始啰！今天清单里有 {total_habits} 个小习惯，我们先从最轻松的那个慢慢启动好不好？"
            if total_habits > 0
            else f"{prefix}早安呀～睡得还好吗？今天想先安排哪件最重要的小事呢，跟我讲一下吧！"
        )
    elif event_type == "noon_checkin":
        emotion = "encouraging"
        title = "午间提醒"
        text = f"{prefix}中午到啰～先放下手边的事去吃饱饱啦！顺便喝杯温开水，下午才会有满满电量喔！"
    elif event_type == "evening_review":
        emotion = "speaking"
        title = "晚间清单复盘"
        if pending_count > 0:
            text = f"{prefix}晚上好呀～今天辛苦你了喔！清单里还有 {pending_count} 项还没核对捏，现在方便花两分钟跟我聊聊今天的真实情况吗？"
        else:
            text = f"{prefix}晚上好呀～今天的习惯都记录得超棒的耶！睡前再来跟我分享一颗今天的小确幸吧～"
    elif event_type == "bedtime_nudge":
        emotion = "sleepy"
        title = "睡前催睡"
        text = f"{prefix}呼啊～时间不早了捏，手机先放一边去好不好？早点躺平休息，明天才会元气满满喔～晚安啦！"
    else:
        emotion, base_text = random.choice(RANDOM_BUBBLE_POOL)
        title = "随机冒泡关心"
        text = f"{prefix}{base_text}"

    return {
        "type": "proactive_nudge",
        "event_type": event_type,
        "title": title,
        "emotion": emotion,
        "text": text,
        "sentences": split_sentences_for_streaming(text),
        "can_snooze": True,
        "snooze_minutes": 15,
        "triggered_at": datetime.now().isoformat(timespec="seconds"),
    }


async def trigger_proactive_event(
    event_type: ScheduleEventType,
    *,
    force: bool = False,
    is_snoozed: bool = False,
    snooze_minutes: int = 15,
) -> dict[str, Any]:
    """
    触发一次主动陪伴推送：
    - force=False（定时自动触发）时遵守免打扰开关；
    - force=True（用户在设置页点击“模拟触发”）时无视免打扰立即推送以便验收。
    """
    cfg = load_schedule_settings()
    if cfg.get("dnd_enabled") and not force:
        return {
            "sent": False,
            "reason": "dnd_enabled",
            "event_type": event_type,
        }

    payload = _compose_nudge_payload(
        event_type,
        is_snoozed=is_snoozed,
        snooze_minutes=snooze_minutes,
    )
    delivered = await event_bus.broadcast(payload)
    return {
        "sent": True,
        "delivered_clients": delivered,
        "payload": payload,
    }


def _schedule_today_random_bubbles(scheduler: AsyncIOScheduler, cfg: dict[str, Any]) -> None:
    """在当日活跃时段内随机抽取 1~3 个未来时间点，安排「随机冒泡」主动陪伴"""
    # 先清理旧的随机冒泡任务
    for job in list(scheduler.get_jobs()):
        if job.id.startswith("random_bubble_"):
            job.remove()

    rb = cfg.get("random_bubble") or {}
    if not rb.get("enabled", True):
        return

    count = max(1, min(int(rb.get("daily_count", 2)), 3))
    sh, sm = _parse_hhmm(rb.get("start_time", "10:00"), 10, 0)
    eh, em = _parse_hhmm(rb.get("end_time", "21:00"), 21, 0)

    now = datetime.now()
    start_dt = now.replace(hour=sh, minute=sm, second=0, microsecond=0)
    end_dt = now.replace(hour=eh, minute=em, second=0, microsecond=0)

    # 仅规划当前时刻之后仍在活跃窗口内的时间点
    effective_start = max(start_dt, now + timedelta(minutes=2))
    if effective_start >= end_dt:
        return

    total_seconds = int((end_dt - effective_start).total_seconds())
    if total_seconds < 120:
        return

    # 将剩余窗口均分为 count 段，在每段内随机选 1 个时间点，避免两次冒泡挤在一起
    segment = total_seconds // count
    for idx in range(count):
        seg_start = idx * segment
        seg_end = (idx + 1) * segment - 30 if idx < count - 1 else total_seconds
        offset = random.randint(seg_start, max(seg_start, seg_end))
        run_dt = effective_start + timedelta(seconds=offset)
        scheduler.add_job(
            trigger_proactive_event,
            trigger=DateTrigger(run_date=run_dt),
            kwargs={"event_type": "random_bubble", "force": False},
            id=f"random_bubble_{idx + 1}",
            name=f"随机冒泡 #{idx + 1}",
            replace_existing=True,
        )


def reload_schedule_jobs() -> list[dict[str, Any]]:
    """根据最新配置重新注册全部固定作息节点与当日随机冒泡任务"""
    global _scheduler
    if _scheduler is None:
        return []

    cfg = load_schedule_settings()

    # 1. 注册 4 个固定每日作息节点
    node_defaults = {
        "morning_plan": ("早安规划", 8, 30),
        "noon_checkin": ("午间提醒", 12, 30),
        "evening_review": ("晚间复盘", 21, 30),
        "bedtime_nudge": ("睡前催睡", 23, 0),
    }

    for node_key, (default_label, def_h, def_m) in node_defaults.items():
        job_id = f"daily_{node_key}"
        if _scheduler.get_job(job_id):
            _scheduler.remove_job(job_id)

        node_cfg = cfg.get(node_key) or {}
        if node_cfg.get("enabled", True):
            hh, mm = _parse_hhmm(node_cfg.get("time", f"{def_h:02d}:{def_m:02d}"), def_h, def_m)
            _scheduler.add_job(
                trigger_proactive_event,
                trigger=CronTrigger(hour=hh, minute=mm),
                kwargs={"event_type": node_key, "force": False},
                id=job_id,
                name=node_cfg.get("label") or default_label,
                replace_existing=True,
            )

    # 2. 注册每日凌晨 00:05 刷新次日随机冒泡的元任务
    _scheduler.add_job(
        reload_schedule_jobs,
        trigger=CronTrigger(hour=0, minute=5),
        id="daily_random_bubble_planner",
        name="每日随机冒泡时间抽签",
        replace_existing=True,
    )

    # 3. 规划今天的随机冒泡点
    _schedule_today_random_bubbles(_scheduler, cfg)

    return get_scheduler_status()["jobs"]


def snooze_proactive_event(
    event_type: ScheduleEventType,
    delay_minutes: int = 15,
) -> dict[str, Any]:
    """安排一次“稍后再聊（默认 15 分钟后）”的延后提醒"""
    global _scheduler
    actual_delay = max(1, min(delay_minutes, 180))
    run_at = datetime.now() + timedelta(minutes=actual_delay)
    job_id = f"snooze_{event_type}_{int(run_at.timestamp())}"

    if _scheduler is not None:
        _scheduler.add_job(
            trigger_proactive_event,
            trigger=DateTrigger(run_date=run_at),
            kwargs={
                "event_type": event_type,
                "force": False,
                "is_snoozed": True,
                "snooze_minutes": actual_delay,
            },
            id=job_id,
            name=f"稍后再聊（{event_type}）",
            replace_existing=True,
        )

    return {
        "snoozed": True,
        "job_id": job_id,
        "event_type": event_type,
        "delay_minutes": actual_delay,
        "resume_at": run_at.isoformat(timespec="seconds"),
    }


def get_scheduler_status() -> dict[str, Any]:
    """返回当前调度器状态、免打扰开关及所有待触发任务列表"""
    cfg = load_schedule_settings()
    jobs_info: list[dict[str, Any]] = []
    if _scheduler is not None:
        for job in _scheduler.get_jobs():
            if job.id == "daily_random_bubble_planner":
                continue
            next_run = job.next_run_time.isoformat(timespec="seconds") if job.next_run_time else None
            jobs_info.append(
                {
                    "id": job.id,
                    "name": job.name,
                    "next_run_time": next_run,
                }
            )
    jobs_info.sort(key=lambda j: j["next_run_time"] or "9999")
    return {
        "running": bool(_scheduler and _scheduler.running),
        "dnd_enabled": bool(cfg.get("dnd_enabled", False)),
        "connected_clients": event_bus.active_count,
        "schedule": cfg,
        "jobs": jobs_info,
    }


def start_scheduler() -> None:
    """在 FastAPI 启动生命周期中启动 AsyncIOScheduler"""
    global _scheduler
    if _scheduler is None:
        # 显式指定默认时区为 Asia/Shanghai，避免受限环境下 tzlocal 探测阻塞
        _scheduler = AsyncIOScheduler(timezone="Asia/Shanghai")
    if not _scheduler.running:
        _scheduler.start()
    reload_schedule_jobs()


def shutdown_scheduler() -> None:
    """在 FastAPI 关闭生命周期中优雅停止调度器"""
    global _scheduler
    if _scheduler is not None and _scheduler.running:
        _scheduler.shutdown(wait=False)
