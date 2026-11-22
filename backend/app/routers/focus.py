"""
番茄钟记录（/api/focus）
-----------------------
只保存已经结束的一轮。进行中的倒计时留在面板本机，避免刷新或切页把钟重置。
"""

import asyncio
import random
from datetime import date, datetime

from fastapi import APIRouter, HTTPException

from app.core.logging import get_logger
from app.core.settings_store import get_all_settings
from app.core.utils import validate_date_str
from app.database import db_cursor
from app.schemas import (
    FocusCompanionOut,
    FocusCompanionRequest,
    FocusDayOut,
    FocusOverviewOut,
    FocusRecordDay,
    FocusSessionCreate,
    FocusSessionOut,
)
from app.services.llm.client import create_async_completion_fast, get_async_openai_client
from app.services.llm.text_pipeline import clean_spoken_text_for_tts, infer_reply_emotion
from app.services.tts_provider import split_sentences_for_streaming

router = APIRouter(prefix="/api/focus", tags=["Focus"])
logger = get_logger("focus")

_REST_ANGLES: list[tuple[str, str]] = [
    ("喝口水", "提醒用户去倒杯水或喝两口温水润润喉"),
    ("伸懒腰", "提醒用户站起来伸个大懒腰、动动肩膀和腰背"),
    ("远眺护眼", "提醒用户离开屏幕看看窗外或远处 20 秒让眼睛歇一下"),
    ("走动放松", "提醒用户起身走两步、晃晃手腕脚踝让血液循环起来"),
    ("深呼吸", "提醒用户放下鼠标深呼吸几口，把紧绷的肩膀松下来"),
    ("补点能量", "提醒用户稍微歇口气，顺便喝口茶或吃口小点心"),
]

_NEXT_ROUND_ANGLES: list[tuple[str, str]] = [
    ("温柔续轮", "温柔询问休息得够不够，要不要一起再开下一个番茄钟"),
    ("活力打气", "俏皮打气问能量充好电没，要不要趁热打铁再来一轮"),
    ("轻松选择", "轻松问现在状态还可以吗，想继续冲一轮还是先自由安排"),
]

_LAST_ANGLE_INDEX: dict[str, int] = {}


def _pick_random_angle(kind: str, pool: list[tuple[str, str]]) -> tuple[str, str]:
    indices = list(range(len(pool)))
    last = _LAST_ANGLE_INDEX.get(kind)
    if last in indices and len(indices) > 1:
        indices.remove(last)
    chosen = random.choice(indices)
    _LAST_ANGLE_INDEX[kind] = chosen
    return pool[chosen]


def _fallback_companion_reply(
    payload: FocusCompanionRequest,
    suggestion_tag: str,
) -> str:
    task = payload.task_title.strip()
    mins = payload.focus_minutes
    task_lead = f"刚刚专心处理「{task}」" if task else f"刚刚认真专注了 {mins} 分钟"

    if payload.event == "focus_completed":
        break_desc = "长休息一下" if payload.break_type == "long" else "稍微休息几分钟"
        templates = {
            "喝口水": [
                f"耶～{task_lead}超棒的捏！先停下来喝几口水润润喉，{break_desc}再继续喔～",
                f"辛苦你了喔～{task_lead}真的好厉害！快去倒杯水喝一下，让脑袋喘口气吧！",
            ],
            "伸懒腰": [
                f"太赞了啦！{task_lead}顺利完成啰～快站起来伸个大懒腰，把肩膀晃一晃放松一下嘛！",
                f"欸～你超专注的耶，{task_lead}辛苦啦！现在起来扭扭脖子伸伸腰，{break_desc}喔～",
            ],
            "远眺护眼": [
                f"哇塞～{task_lead}超稳的耶！眼睛盯屏幕这么久辛苦了，快抬头看看窗外远处歇二十秒喔～",
                f"好厉害捏，{task_lead}告一段落啰！先离开屏幕远眺一下让眼睛休息，等下更有精神喔！",
            ],
            "走动放松": [
                f"超棒的耶～{task_lead}完成这一轮啦！快起身走两步甩甩手腕，别一直坐着喔～",
                f"辛苦你啦！{task_lead}这么认真，现在起来溜达两圈活动一下筋骨，{break_desc}吧～",
            ],
            "深呼吸": [
                f"耶～{task_lead}超专注的捏！先把肩膀放轻松深呼吸几口，好好享受这几分钟小憩喔～",
                f"你很厉害耶，{task_lead}撑完这一轮了！闭眼深呼吸放松一下下，别太紧绷啰～",
            ],
            "补点能量": [
                f"哇～{task_lead}超赞的啦！稍微喘口气，喝口茶或吃点小零食犒劳自己一下嘛～",
                f"辛苦了喔～{task_lead}真的超认真！快去倒杯喜欢的饮料缓一缓，{break_desc}喔！",
            ],
        }
        return random.choice(templates.get(suggestion_tag, templates["喝口水"]))

    task_hint = f"继续推进「{task}」" if task else "再开启下一个番茄钟"
    next_templates = [
        f"欸～休息时间到啰！充完电感觉怎么样，要不要跟我一起{task_hint}呀？",
        f"叮咚～小歇结束啦！精神回来一点了吗，咱们要不要趁热打铁{task_hint}捏？",
        f"哈啰～休息好啰！如果状态不错的话，要不要再来一轮专注，还是先歇着呀？",
        f"休息完毕啦～你刚刚节奏超棒的耶，现在要不要再开一个番茄钟冲一下呢？",
    ]
    return random.choice(next_templates)


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


@router.post("/companion-message", response_model=FocusCompanionOut)
async def generate_focus_companion_message(payload: FocusCompanionRequest):
    """番茄钟完成或休息结束时，由灵儿结合任务内容随机生成温暖台湾腔提醒（超时/离线自动降级内置文案库）。"""
    if payload.event == "focus_completed":
        suggestion_tag, angle_prompt = _pick_random_angle("focus_completed", _REST_ANGLES)
    else:
        suggestion_tag, angle_prompt = _pick_random_angle("break_completed", _NEXT_ROUND_ANGLES)

    settings = get_all_settings()
    bot_name = str(settings.get("bot_name") or "灵儿")
    llm_cfg = settings.get("llm") if isinstance(settings.get("llm"), dict) else {}
    api_key = str(llm_cfg.get("api_key") or "").strip()
    base_url = str(
        llm_cfg.get("base_url") or "https://generativelanguage.googleapis.com/v1beta/openai/"
    ).strip()
    model_name = str(llm_cfg.get("model") or "gemini-2.5-flash").strip()

    reply = ""
    used_fallback = False

    if api_key:
        task_info = payload.task_title.strip() or "自由专注"
        if payload.event == "focus_completed":
            break_label = "15 分钟长休息" if payload.break_type == "long" else "5 分钟小休息"
            user_prompt = (
                f"用户刚刚完成了一轮 {payload.focus_minutes} 分钟的专注任务「{task_info}」"
                f"（这是今天的第 {max(1, payload.round)} 轮番茄），即将进入 {break_label}。"
                f"请你自然夸奖用户的专注（顺口带到任务内容），并{angle_prompt}。"
            )
        else:
            user_prompt = (
                f"用户刚刚结束休息时间，上一轮专注了 {payload.focus_minutes} 分钟的「{task_info}」。"
                f"请你{angle_prompt}。"
            )

        system_prompt = (
            f"你是用户的治愈系台湾腔桌面小精灵「{bot_name}」。"
            "请直接输出 1～2 句自然可爱的台湾腔口语（20～55 字，融入欸～、喔、啦、耶、捏等语气词），"
            "每次措辞保持新鲜不套路；绝对不要输出 Emoji、Markdown、引号或任何括号动作描写。"
        )
        try:
            client = get_async_openai_client(api_key=api_key, base_url=base_url, timeout=6.0)
            completion = await asyncio.wait_for(
                create_async_completion_fast(
                    client,
                    {
                        "model": model_name,
                        "messages": [
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_prompt},
                        ],
                        "temperature": 0.95,
                        "max_tokens": 256,
                    },
                    base_url,
                    model_name,
                ),
                timeout=4.5,
            )
            raw = (completion.choices[0].message.content or "").strip()
            cleaned = clean_spoken_text_for_tts(raw).strip("「」\"' ")
            if cleaned and len(cleaned) >= 6:
                reply = cleaned
        except Exception as exc:
            logger.warning("生成番茄陪伴提醒失败，已降级随机文案库: %s", exc)

    if not reply:
        used_fallback = True
        reply = _fallback_companion_reply(payload, suggestion_tag)

    sentences = split_sentences_for_streaming(reply) or [reply]
    emotion = infer_reply_emotion(reply)
    if payload.event == "focus_completed" and emotion == "thinking":
        emotion = "happy"
    elif payload.event == "break_completed" and emotion == "thinking":
        emotion = "expectant"

    return FocusCompanionOut(
        reply=reply,
        sentences=sentences,
        emotion=emotion,
        suggestion_tag=suggestion_tag,
        used_fallback=used_fallback,
    )

