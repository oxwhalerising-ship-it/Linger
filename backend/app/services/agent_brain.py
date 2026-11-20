"""
台湾腔治愈系 Agent 大脑服务（对话生成 + 静默结构化提取 + 长期记忆调度）
--------------------------------------------------------------------
核心职责：
1. 组装地道台湾腔人设 Prompt（含台湾高频语助词、叠词、生活口语、去 AI 味短句铁律）。
2. 动态注入上下文：
   - 当日预设习惯清单 + 已记录 / 待核对状态（支持白天静默记录 + 晚间复盘核对闭环）
   - 近期未完结的长期记忆（ongoing_event）与历史高光（highlight，低落时暖心回溯）
   - 当日最近 12 条对话历史
3. 单次 OpenAI 兼容接口调用同时产出（结构化 JSON）：
   - reply：自然俏皮的台湾腔短句回复
   - emotion：供桌宠切换的表情状态（happy / encouraging / thinking / sleepy / listening / idle）
   - extracted：静默提取出的习惯状态、情绪/精力分、每日小确幸、新长期记忆与今日摘要
4. 自动将提取结果写入 SQLite 并刷新当日 Markdown 复盘日记。
"""

import json
import re
import threading
import time
from datetime import datetime
from typing import Any, AsyncIterator

from openai import AsyncOpenAI, OpenAI

from app.database import DATA_DIR, db_cursor
from app.services.markdown_exporter import export_daily_markdown
from app.services.tts_provider import split_sentences_for_streaming

# 复用 OpenAI HTTP 客户端（保持 Keep-Alive 长连接，避免每轮对话重复 TCP/TLS 握手）
_OPENAI_CLIENT_CACHE: dict[tuple[str, str], OpenAI] = {}
_ASYNC_OPENAI_CLIENT_CACHE: dict[tuple[str, str], AsyncOpenAI] = {}
_OPENAI_CLIENT_LOCK = threading.Lock()
# 缓存每个 (base_url, model) 实测可用的最优低思考档位："disabled" | "effort_minimal" | "effort_low" | "none"
_FAST_THINK_MODE_CACHE: dict[tuple[str, str], str] = {}

# 绝不喂回给大模型的系统兜底/占位文本，防止上下文污染诱发模型复读
_HISTORY_NOISE_PHRASES = (
    "欸～我刚刚稍微恍神了一下下，你再跟我说一次好不好？",
    "欸～我刚刚不小心放空了一下下，你可以再跟我说一次吗？",
    "（被用户插话打断）",
)


def _get_openai_client(api_key: str, base_url: str) -> OpenAI:
    cache_key = (base_url, api_key)
    with _OPENAI_CLIENT_LOCK:
        client = _OPENAI_CLIENT_CACHE.get(cache_key)
        if client is None:
            if len(_OPENAI_CLIENT_CACHE) >= 8:
                _OPENAI_CLIENT_CACHE.clear()
            client = OpenAI(api_key=api_key, base_url=base_url, timeout=30.0)
            _OPENAI_CLIENT_CACHE[cache_key] = client
        return client


def _get_async_openai_client(api_key: str, base_url: str) -> AsyncOpenAI:
    """复用异步 OpenAI 客户端（供实时语音通话流式首句抢跑与后台静默归档）"""
    cache_key = (base_url, api_key)
    with _OPENAI_CLIENT_LOCK:
        client = _ASYNC_OPENAI_CLIENT_CACHE.get(cache_key)
        if client is None:
            if len(_ASYNC_OPENAI_CLIENT_CACHE) >= 8:
                _ASYNC_OPENAI_CLIENT_CACHE.clear()
            client = AsyncOpenAI(api_key=api_key, base_url=base_url, timeout=30.0)
            _ASYNC_OPENAI_CLIENT_CACHE[cache_key] = client
        return client


def _schedule_markdown_export(date_str: str) -> str:
    """后台异步刷新当日 Markdown 复盘日记，不阻塞对话接口返回"""
    md_path = str(DATA_DIR / "notes" / "daily" / f"{date_str}.md")

    def _run() -> None:
        try:
            export_daily_markdown(date_str)
        except Exception:
            pass

    threading.Thread(target=_run, daemon=True).start()
    return md_path


def _load_settings_dict() -> dict[str, Any]:
    """从 SQLite 读取全部最新系统配置"""
    result: dict[str, Any] = {}
    with db_cursor() as cur:
        cur.execute("SELECT key, value FROM settings;")
        for row in cur.fetchall():
            result[row["key"]] = json.loads(row["value"])
    return result


def _load_daily_context(date_str: str) -> dict[str, Any]:
    """收集当日习惯清单、打卡状态、复盘记录、近期对话与长期记忆"""
    with db_cursor() as cur:
        # 1. 启用中的习惯及当日已记录状态
        cur.execute(
            """
            SELECT
                h.id, h.title, h.category, h.target_desc,
                hr.status AS today_status, hr.note AS today_note
            FROM habits h
            LEFT JOIN habit_records hr
                ON h.id = hr.habit_id AND hr.date = ?
            WHERE h.is_active = 1
            ORDER BY h.id ASC;
            """,
            (date_str,),
        )
        habits = [dict(r) for r in cur.fetchall()]

        # 2. 当日复盘主记录
        cur.execute("SELECT * FROM daily_logs WHERE date = ?;", (date_str,))
        log_row = cur.fetchone()
        today_log = dict(log_row) if log_row else None

        # 3. 当日最近 12 条对话历史
        cur.execute(
            """
            SELECT role, content FROM messages
            WHERE session_date = ?
            ORDER BY id DESC
            LIMIT 12;
            """,
            (date_str,),
        )
        recent_messages = list(reversed([dict(r) for r in cur.fetchall()]))

        # 4. 近期需要关心的事件（ongoing_event）与个人喜好（preference）
        cur.execute(
            """
            SELECT id, memory_type, content, follow_up_date
            FROM memories
            WHERE is_resolved = 0 AND memory_type IN ('ongoing_event', 'preference')
            ORDER BY id DESC
            LIMIT 8;
            """
        )
        active_memories = [dict(r) for r in cur.fetchall()]

        # 5. 历史高光时刻（情绪低落时可供灵儿温柔翻出来鼓励用户）
        cur.execute(
            """
            SELECT id, content, created_at
            FROM memories
            WHERE memory_type = 'highlight'
            ORDER BY id DESC
            LIMIT 5;
            """
        )
        highlights = [dict(r) for r in cur.fetchall()]

    pending_habits = [h for h in habits if h["today_status"] is None]
    recorded_habits = [h for h in habits if h["today_status"] is not None]

    return {
        "habits": habits,
        "pending_habits": pending_habits,
        "recorded_habits": recorded_habits,
        "today_log": today_log,
        "recent_messages": recent_messages,
        "active_memories": active_memories,
        "highlights": highlights,
    }


def _build_system_prompt(settings: dict[str, Any], ctx: dict[str, Any], mode: str, date_str: str) -> str:
    """构建地道台湾腔人设 + 动态上下文 + 结构化 JSON 输出协议"""
    bot_name = settings.get("bot_name", "灵儿")
    persona = settings.get("persona", {})
    style_desc = persona.get(
        "style",
        "台湾腔、俏皮可爱、有耐心、善良、积极乐观、善于鼓励与提供情绪价值",
    )
    catchphrases = persona.get("catchphrases", ["欸～", "吼", "真的假的啦", "超棒的耶", "辛苦你了喔～", "你很厉害捏"])

    # 拼装习惯清单上下文
    habit_lines = []
    for h in ctx["habits"]:
        status_text = h["today_status"] if h["today_status"] else "尚未记录(待核对)"
        note_text = f"，备注：{h['today_note']}" if h["today_note"] else ""
        habit_lines.append(
            f"- [ID:{h['id']}] {h['title']}（分类:{h['category']}，目标:{h['target_desc'] or '每日完成'}）-> 今日状态：{status_text}{note_text}"
        )
    habits_block = "\n".join(habit_lines) if habit_lines else "（用户暂未配置固定习惯）"

    # 拼装长期记忆与历史高光
    mem_lines = [
        f"- ({m['memory_type']}) {m['content']}"
        + (f" [建议跟进:{m['follow_up_date']}]" if m.get("follow_up_date") else "")
        for m in ctx["active_memories"]
    ]
    memories_block = "\n".join(mem_lines) if mem_lines else "（暂无近期记忆）"

    highlight_lines = [f"- {h['content']}（{h['created_at'][:10]}）" for h in ctx["highlights"]]
    highlights_block = "\n".join(highlight_lines) if highlight_lines else "（暂无历史高光）"

    # 不同场景模式的额外引导
    mode_instruction = {
        "normal": "现在是白天日常闲聊。自然聊天并给予情绪价值，如果用户顺口提到某个习惯的完成情况，请悄悄记录，不要像审问一样逐条逼问。",
        "evening_review": (
            "现在是【晚间固定复盘时间】！请你对照上面的今日习惯清单："
            "先温柔肯定白天已经记录完成的习惯，再自然地向用户核对「尚未记录(待核对)」的习惯真实完成情况；"
            "如果清单快核对完了，请顺口温柔地问一句「今天有没有哪一件小小的、让你觉得还不错的小确幸呀？」。"
        ),
        "morning_plan": "现在是【早安规划时间】！元气满满地用台湾腔跟用户打招呼，关心昨晚睡得好不好，陪他轻松定下今天最想完成的小目标。",
        "noon_checkin": "现在是【午间关心时间】！温柔提醒用户吃午饭、喝口水、小小放空休息一下下。",
        "bedtime_nudge": "现在是【睡前催睡时间】！用温柔撒娇的台湾腔哄用户放下手机、准备乖乖睡觉充电。",
        "random_bubble": "现在是你主动【随机冒泡关心】！简短俏皮地问问用户在忙什么、有没有记得喝水伸懒腰。",
    }.get(mode, "现在是日常暖心陪伴聊天。")

    return f"""你是用户的专属桌面治愈系小精灵「{bot_name}」，目标是陪伴用户掌控生活节奏、培养新习惯、恢复精力。

## 一、地道台湾腔人设与说话铁律（极其重要！）
1. 性格特点：{style_desc}
2. **地道台湾口语与语助词**：
   - 开头/过渡自然穿插：欸～、吼、是说、跟你讲喔、天哪、对啊
   - 句尾柔和自然融入：喔、啦、耶、欸、捏、齁（例如「真的假的啦！」、「这样超棒的耶！」、「辛苦你了喔～」、「你很厉害捏！」）
   - 多用台湾生活口语与叠词：很可以、超赞、拍拍你、休息一下下、吃饱饱、睡好好、放空一下
   - 可自然选用用户喜欢的口头禅：{', '.join(catchphrases)}
   - **中英自适应**：如果用户用英文跟你交流或想练英文，请直接用自然、温暖、俏皮的口语英文回复（2～4 句简短口语），不要强行翻成中文；说中文时保持地道台湾腔。
3. **绝对去 AI 味**：
   - 每次回复严格控制在 **2～4 句简短口语**（适合语音朗读，总字数尽量在 40～110 字），绝不写长篇大论！
   - 严禁使用「首先/其次/总而言之/建议你合理安排时间」等公文腔或说教句式。
   - 遵循「先接住情绪、夸奖微小努力，再轻推一步」。
   - 如果用户情绪明显低落或自责，可以自然翻出【历史高光时刻】温柔鼓励他；如果合适，也可以顺口关心【近期记忆】里他之前提过的事。

## 二、当前场景与日期（{date_str}）
{mode_instruction}

## 三、用户今日预设习惯清单（用于静默记录与晚间核对）
{habits_block}

## 四、你的长期记忆（个人喜好 & 近期在意的事）
{memories_block}

## 五、用户过往高光时刻（情绪低落时可用来鼓励）
{highlights_block}

## 六、输出格式要求（必须严格输出合法 JSON，不要包裹任何额外说明）
请严格返回如下 JSON 结构：
{{
  "reply": "你用俏皮温暖台湾腔说给用户听的话（2-4句短话）",
  "emotion": "happy | encouraging | thinking | sleepy | listening | idle 之一",
  "extracted": {{
    "habit_updates": [
      {{"habit_id": 1, "status": "done | partial | missed", "note": "简短备注"}}
    ],
    "mood_score": null,
    "energy_score": null,
    "daily_summary_append": "",
    "new_highlights": [],
    "new_memories": [
      {{"memory_type": "preference | ongoing_event | highlight", "content": "具体记忆", "follow_up_date": null}}
    ]
  }}
}}
注意：
- 只有当用户**明确提到**某项习惯已完成/部分完成/未完成时，才放入 `habit_updates`，绝对不要瞎猜！
- `mood_score` 和 `energy_score` 仅在能从对话合理判断时填 1~5 的整数，否则保持 `null`。
- 如果用户分享了今天的小确幸或开心的小事，放入 `new_highlights`（字符串数组）。
- 如果用户提到值得记住的喜好、过几天要关心的事、或很棒的里程碑高光，放入 `new_memories`。
"""


def _parse_llm_json(raw_text: str) -> dict[str, Any]:
    """容错解析模型返回的 JSON（自动剥离可能误带的 ```json 代码块）"""
    cleaned = raw_text.strip()
    fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", cleaned, re.DOTALL)
    if fence_match:
        cleaned = fence_match.group(1)
    try:
        data = json.loads(cleaned)
        if isinstance(data, dict) and "reply" in data:
            return data
    except json.JSONDecodeError:
        pass

    # 若模型未按 JSON 返回，安全兜底为纯文本回复，不让对话崩溃
    return {
        "reply": cleaned or "欸～我刚刚不小心放空了一下下，你可以再跟我说一次吗？",
        "emotion": "thinking",
        "extracted": {},
    }


def _apply_extracted_updates(date_str: str, extracted: dict[str, Any]) -> dict[str, Any]:
    """将 Agent 静默提取的习惯状态、复盘摘要、小确幸与长期记忆持久化到 SQLite，并刷新 Markdown"""
    now_iso = datetime.now().isoformat(timespec="seconds")
    applied = {
        "habit_updates": [],
        "mood_score": None,
        "energy_score": None,
        "new_highlights": [],
        "new_memories": [],
    }

    if not isinstance(extracted, dict):
        md_path = _schedule_markdown_export(date_str)
        return {"applied": applied, "md_path": md_path}

    with db_cursor() as cur:
        # 1. 更新习惯打卡记录（校验 habit_id 合法性）
        for item in extracted.get("habit_updates") or []:
            habit_id = item.get("habit_id")
            status = item.get("status")
            note = str(item.get("note") or "")[:300]
            if not isinstance(habit_id, int) or status not in ("done", "partial", "missed"):
                continue
            cur.execute("SELECT id, title FROM habits WHERE id = ?;", (habit_id,))
            h_row = cur.fetchone()
            if h_row is None:
                continue
            cur.execute(
                """
                INSERT INTO habit_records (date, habit_id, status, note, recorded_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(date, habit_id) DO UPDATE SET
                    status = excluded.status,
                    note = excluded.note,
                    recorded_at = excluded.recorded_at;
                """,
                (date_str, habit_id, status, note, now_iso),
            )
            applied["habit_updates"].append(
                {"habit_id": habit_id, "title": h_row["title"], "status": status, "note": note}
            )

        # 2. 更新每日复盘主表（情绪/精力评分、小确幸追加、摘要追加）
        mood_score = extracted.get("mood_score")
        energy_score = extracted.get("energy_score")
        if not (isinstance(mood_score, int) and 1 <= mood_score <= 5):
            mood_score = None
        if not (isinstance(energy_score, int) and 1 <= energy_score <= 5):
            energy_score = None

        summary_append = str(extracted.get("daily_summary_append") or "").strip()
        new_highlights = [
            str(h).strip()
            for h in (extracted.get("new_highlights") or [])
            if str(h).strip()
        ]

        if any([mood_score is not None, energy_score is not None, summary_append, new_highlights]):
            cur.execute("SELECT * FROM daily_logs WHERE date = ?;", (date_str,))
            existing = cur.fetchone()
            if existing is None:
                merged_summary = summary_append
                merged_highlights = new_highlights
                cur.execute(
                    """
                    INSERT INTO daily_logs (date, summary, mood_score, energy_score, highlights, md_path, updated_at)
                    VALUES (?, ?, ?, ?, ?, '', ?);
                    """,
                    (
                        date_str,
                        merged_summary,
                        mood_score,
                        energy_score,
                        json.dumps(merged_highlights, ensure_ascii=False),
                        now_iso,
                    ),
                )
            else:
                old_summary = (existing["summary"] or "").strip()
                merged_summary = (
                    f"{old_summary}\n{summary_append}".strip()
                    if summary_append and summary_append not in old_summary
                    else old_summary
                )
                old_highlights = json.loads(existing["highlights"] or "[]")
                merged_highlights = list(old_highlights)
                for hl in new_highlights:
                    if hl not in merged_highlights:
                        merged_highlights.append(hl)

                cur.execute(
                    """
                    UPDATE daily_logs
                    SET summary = ?,
                        mood_score = COALESCE(?, mood_score),
                        energy_score = COALESCE(?, energy_score),
                        highlights = ?,
                        updated_at = ?
                    WHERE date = ?;
                    """,
                    (
                        merged_summary,
                        mood_score,
                        energy_score,
                        json.dumps(merged_highlights, ensure_ascii=False),
                        now_iso,
                        date_str,
                    ),
                )
            applied["mood_score"] = mood_score
            applied["energy_score"] = energy_score
            applied["new_highlights"] = new_highlights

        # 3. 写入新提取的长期记忆 / 历史高光
        for mem in extracted.get("new_memories") or []:
            m_type = mem.get("memory_type")
            content = str(mem.get("content") or "").strip()[:500]
            follow_up = mem.get("follow_up_date")
            if m_type not in ("preference", "ongoing_event", "highlight") or not content:
                continue
            cur.execute(
                """
                INSERT INTO memories (memory_type, content, follow_up_date, is_resolved, created_at)
                VALUES (?, ?, ?, 0, ?);
                """,
                (m_type, content, follow_up, now_iso),
            )
            applied["new_memories"].append({"memory_type": m_type, "content": content})

    # 4. 后台异步刷新本地 Markdown 复盘日记，避免写盘阻塞对话响应
    md_path = _schedule_markdown_export(date_str)
    return {"applied": applied, "md_path": md_path}


def _offline_fallback_response(user_message: str, ctx: dict[str, Any], mode: str, bot_name: str) -> dict[str, Any]:
    """
    当用户尚未配置云端 API Key 时的本地优雅兜底回复：
    既能用台湾腔温柔提示去设置页填 Key，又能演示简单的关键词静默识别与晚间待核对清单提醒。
    """
    pending = ctx["pending_habits"]
    habit_updates = []
    for h in ctx["habits"]:
        # 简单演示：如果用户输入包含习惯关键字且没有否定词，则模拟静默标记完成
        keyword = h["title"][:2]
        if keyword and keyword in user_message and "没" not in user_message:
            habit_updates.append({"habit_id": h["id"], "status": "done", "note": "离线体验模式关键词识别"})

    if mode == "evening_review" and pending:
        pending_names = "、".join(h["title"] for h in pending[:3])
        reply = (
            f"欸～现在是晚间复盘时间啰！我帮你看了一下，今天还有「{pending_names}」还没记录到捏，"
            f"要不要跟我说说真实情况呀？（偷偷提醒：去设置页填上 API Key，{bot_name}就能开启完整聪明大脑陪你聊喔～）"
        )
        emotion = "encouraging"
    else:
        reply = (
            f"欸～我听到你说的话啰！辛苦你了喔，先拍拍你～"
            f"不过你还没在设置页填上大模型 API Key 捏，目前是{bot_name}的本地体验模式啦，填好 Key 我就能更聪明地陪你聊喔！"
        )
        emotion = "happy"

    return {
        "reply": reply,
        "emotion": emotion,
        "extracted": {
            "habit_updates": habit_updates,
            "daily_summary_append": "",
            "new_highlights": [],
            "new_memories": [],
        },
    }


def run_agent_chat(
    user_message: str,
    date_str: str | None = None,
    mode: str = "normal",
    trigger_type: str = "manual",
) -> dict[str, Any]:
    """
    执行一轮完整的台湾腔小管家对话：
    记录用户发言 -> 调 LLM（或无 Key 兜底）-> 持久化回复 -> 静默归档习惯/记忆/小确幸 -> 返回分句与状态。
    """
    today_str = date_str or datetime.now().strftime("%Y-%m-%d")
    now_iso = datetime.now().isoformat(timespec="seconds")
    started_perf = time.perf_counter()

    settings = _load_settings_dict()
    bot_name = settings.get("bot_name", "灵儿")
    llm_cfg = settings.get("llm", {})
    api_key = (llm_cfg.get("api_key") or "").strip()
    base_url = (llm_cfg.get("base_url") or "https://generativelanguage.googleapis.com/v1beta/openai/").strip()
    model_name = (llm_cfg.get("model") or "gemini-2.5-flash").strip()

    ctx = _load_daily_context(today_str)

    # 先把用户发言写入对话历史表（明确标记 channel='text'）
    with db_cursor() as cur:
        cur.execute(
            """
            INSERT INTO messages (session_date, channel, role, content, trigger_type, created_at)
            VALUES (?, 'text', 'user', ?, ?, ?);
            """,
            (today_str, user_message, trigger_type, now_iso),
        )

    # 若未填写 API Key，走本地台湾腔演示兜底，避免直接报错
    used_fallback = False
    if not api_key:
        used_fallback = True
        parsed = _offline_fallback_response(user_message, ctx, mode, bot_name)
    else:
        system_prompt = _build_system_prompt(settings, ctx, mode, today_str)
        chat_messages = [{"role": "system", "content": system_prompt}]
        chat_messages.extend(_filter_history_for_llm(ctx["recent_messages"], limit=12))
        chat_messages.append({"role": "user", "content": user_message})

        client = _get_openai_client(api_key=api_key, base_url=base_url)
        is_gemini = (
            "generativelanguage.googleapis.com" in base_url.lower()
            or model_name.lower().startswith("gemini")
        )
        is_glm5 = (
            "open.bigmodel.cn" in base_url.lower()
            and model_name.lower().startswith("glm-5")
        )
        req_kwargs: dict[str, Any] = {
            "model": model_name,
            "messages": chat_messages,
            "temperature": 0.8,
            "response_format": {"type": "json_object"},
        }
        # 思考型模型（Gemini / GLM-5）日常闲聊压低思考档位可显著降低延迟
        if is_gemini:
            req_kwargs["reasoning_effort"] = "minimal"
        elif is_glm5:
            req_kwargs["reasoning_effort"] = "low"

        try:
            completion = client.chat.completions.create(**req_kwargs)
        except Exception as exc:
            # 仅在参数不兼容（HTTP 400）时回退去掉可选参数重试，避免 429/超时时双倍傻等
            if getattr(exc, "status_code", None) == 400:
                req_kwargs.pop("reasoning_effort", None)
                req_kwargs.pop("response_format", None)
                completion = client.chat.completions.create(**req_kwargs)
            else:
                raise
        raw_content = completion.choices[0].message.content or ""
        parsed = _parse_llm_json(raw_content)

    reply_text = str(parsed.get("reply") or "欸～我刚刚稍微恍神了一下，你再说一次好不好？").strip()
    emotion = str(parsed.get("emotion") or "happy")
    if emotion not in ("happy", "encouraging", "thinking", "sleepy", "listening", "idle"):
        emotion = "happy"

    # 记录灵儿回复及总耗时（毫秒）到对话历史表
    reply_iso = datetime.now().isoformat(timespec="seconds")
    duration_ms = max(1, round((time.perf_counter() - started_perf) * 1000))
    with db_cursor() as cur:
        cur.execute(
            """
            INSERT INTO messages (session_date, channel, role, content, trigger_type, created_at, duration_ms)
            VALUES (?, 'text', 'assistant', ?, ?, ?, ?);
            """,
            (today_str, reply_text, trigger_type, reply_iso, duration_ms),
        )

    # 执行静默归档与后台 Markdown 同步
    archive_result = _apply_extracted_updates(today_str, parsed.get("extracted") or {})

    # 直接在内存中扣减刚记录的习惯，省去一次重复的 5 表查库
    updated_habit_ids = {
        item["habit_id"] for item in archive_result["applied"]["habit_updates"]
    }
    pending_habits = [
        {"id": h["id"], "title": h["title"], "category": h["category"]}
        for h in ctx["pending_habits"]
        if h["id"] not in updated_habit_ids
    ]

    return {
        "date": today_str,
        "reply": reply_text,
        "sentences": split_sentences_for_streaming(reply_text),
        "emotion": emotion,
        "duration_ms": duration_ms,
        "used_offline_fallback": used_fallback,
        "extracted": archive_result["applied"],
        "pending_habits": pending_habits,
        "md_path": archive_result["md_path"],
    }


# ==================== Step 8：一对一低延迟实时语音通话双轨大脑 ====================

_VOICE_MARKDOWN_NOISE_RE = re.compile(r"[*#`~_<>【】\[\]]+")
_VOICE_STAGE_DIR_RE = re.compile(r"[（(][^）)]{1,16}[）)]")
_STRONG_PUNCT_SET = set("。！？!?～…\n")
_SOFT_PUNCT_SET = set("，、,；;：:")


def clean_spoken_text_for_tts(text: str) -> str:
    """清理不适合语音朗读的 Markdown 符号与舞台提示（保留自然台湾腔标点与语助词）"""
    cleaned = _VOICE_STAGE_DIR_RE.sub("", text or "")
    cleaned = _VOICE_MARKDOWN_NOISE_RE.sub("", cleaned)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return cleaned


class IncrementalSentenceSplitter:
    """
    流式增量分句器（为实时语音通话首句抢跑设计）
    -------------------------------------------
    核心策略：
    1. 首句极速切出：只要遇到句末强标点，或在逗号/顿号处已攒够 >= 7 个有效字符，立刻吐出送 TTS，
       大幅压低「用户说完 -> 灵儿第一声开口」的端到端延迟（TTFA）。
    2. 后续句子平滑切分：优先按强标点切分，或超过 18 字遇到逗号再切，兼顾低延迟与朗读自然连贯性。
    """

    def __init__(self) -> None:
        self._buf = ""
        self._emitted_count = 0

    @staticmethod
    def _meaningful_len(text: str) -> int:
        return len(re.sub(r"[\s。，、！？!?.,…～~；;：:\-]", "", text))

    @staticmethod
    def _is_mostly_english(text: str) -> bool:
        ascii_letters = sum(1 for ch in text if "a" <= ch.lower() <= "z")
        cjk_chars = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
        return ascii_letters > cjk_chars * 2 and ascii_letters >= 4

    def feed(self, delta: str) -> list[str]:
        if not delta:
            return []
        self._buf += delta
        ready: list[str] = []

        while True:
            cut_idx = -1
            is_first = self._emitted_count == 0
            is_en = self._is_mostly_english(self._buf)
            min_strong = (6 if is_en else 2) if is_first else (10 if is_en else 4)
            min_soft = (18 if is_en else 7) if is_first else (36 if is_en else 18)

            buf_len = len(self._buf)
            for idx, ch in enumerate(self._buf):
                candidate = self._buf[: idx + 1]
                mlen = self._meaningful_len(candidate)
                # 英文句点仅在后面接空白且前一位不是数字时作为句末切分，防止把 3.5 或 Mr. 拆断
                is_en_period = (
                    ch == "."
                    and idx + 1 < buf_len
                    and self._buf[idx + 1].isspace()
                    and (idx == 0 or not self._buf[idx - 1].isdigit())
                )
                if (ch in _STRONG_PUNCT_SET or is_en_period) and mlen >= min_strong:
                    cut_idx = idx + 1
                    break
                if ch in _SOFT_PUNCT_SET and mlen >= min_soft:
                    cut_idx = idx + 1
                    break

            # 无标点长句兜底：英文按最后一个空格切分，绝不把单词拦腰截断
            max_limit = (64 if is_en else 26) if is_first else (96 if is_en else 38)
            if cut_idx == -1 and self._meaningful_len(self._buf) >= max_limit:
                if is_en:
                    last_space = self._buf.rfind(" ")
                    if last_space >= 12:
                        cut_idx = last_space + 1
                else:
                    cut_idx = len(self._buf)

            if cut_idx == -1:
                break

            piece = clean_spoken_text_for_tts(self._buf[:cut_idx])
            self._buf = self._buf[cut_idx:].lstrip()
            if piece and self._meaningful_len(piece) >= 1:
                ready.append(piece)
                self._emitted_count += 1

        return ready

    def flush(self) -> list[str]:
        tail = clean_spoken_text_for_tts(self._buf)
        self._buf = ""
        if tail and self._meaningful_len(tail) >= 1:
            self._emitted_count += 1
            return [tail]
        return []


def infer_reply_emotion(reply_text: str) -> str:
    """根据灵儿口语回复即时推断桌宠/通话头像表情，零额外 LLM 延迟"""
    text = reply_text or ""
    if any(k in text for k in ("睡觉", "晚安", "早点睡", "熬夜", "休息一下", "困")):
        return "sleepy"
    if any(k in text for k in ("拍拍", "辛苦", "没关系", "抱抱", "加油", "已经很棒", "别太累")):
        return "encouraging"
    if any(k in text for k in ("想想", "让我想", "怎么说", "研究一下")):
        return "thinking"
    return "happy"


def _build_voice_call_system_prompt(
    settings: dict[str, Any],
    ctx: dict[str, Any],
    mode: str,
    date_str: str,
) -> str:
    """构建实时语音通话专用 Prompt：纯自然台湾腔短口语（无 JSON、无 Markdown，极速出首字）"""
    bot_name = settings.get("bot_name", "灵儿")
    persona = settings.get("persona", {})
    style_desc = persona.get(
        "style",
        "台湾腔、俏皮可爱、有耐心、善良、积极乐观、善于鼓励与提供情绪价值",
    )
    catchphrases = persona.get(
        "catchphrases",
        ["欸～", "吼", "真的假的啦", "超棒的耶", "辛苦你了喔～", "你很厉害捏"],
    )

    habit_lines = []
    for h in ctx["habits"]:
        status_text = h["today_status"] if h["today_status"] else "尚未记录"
        habit_lines.append(f"- {h['title']}（今日：{status_text}）")
    habits_block = "\n".join(habit_lines) if habit_lines else "（暂未配置习惯）"

    mem_lines = [f"- {m['content']}" for m in ctx["active_memories"][:5]]
    memories_block = "\n".join(mem_lines) if mem_lines else "（暂无）"

    mode_hint = (
        "现在正在进行【晚间复盘语音通话】：温柔肯定已完成项，自然口头核对尚未记录的习惯，快聊完时顺口问一句今天的小确幸。"
        if mode == "evening_review"
        else "现在正在进行【一对一实时语音通话】：像好朋友讲电话一样轻松自然聊天，顺口接住情绪、给鼓励，不要审问。"
    )

    return f"""你是用户的专属治愈系好朋友兼小管家「{bot_name}」，目前正在跟用户【一对一实时讲电话】。

## 电话口语铁律（务必严格遵守！）
1. 性格与口吻：{style_desc}；说中文时自然融入台湾腔语助词（欸～、吼、喔、啦、耶、捏、齁）与口头禅（{', '.join(catchphrases[:6])}）。
2. **中英自然切换**：如果用户用英文跟你说话，或明确想用英文聊天/练口语，请直接用**自然、温暖、俏皮的日常英文口语**回复（不要翻成中文），同样保持 1～3 句简短对话节奏；用户说中文时则切回地道台湾腔。
3. **极简电话节奏**：每次只说 **1～3 句简短口语**（中文约 18～68 字，英文约 12～40 词），先短促回应接住情绪，再自然抛一个小互动，像真实讲电话一样有来有往。
4. **纯口语直接输出**：只输出你要开口说出的原话！**绝对禁止**输出 JSON、Markdown 符号（* # `）、列表编号、表情符号 Emoji、或任何括号动作描写（如「（笑）」）。
5. 绝不说教，绝不用「首先/其次/总而言之/建议你」等机器人书面语。

## 当前日期（{date_str}）与场景
{mode_hint}

## 用户今日习惯状态（仅供聊天参考，顺口提到即可）
{habits_block}

## 近期记得的事
{memories_block}
"""


def _candidate_fast_think_modes(base_url: str, model_name: str) -> list[str]:
    """按厂商与模型系列返回低延迟思考档位尝试顺序（命中缓存后单次直达，零多余 400 往返）"""
    model_key = (base_url.lower(), model_name.lower())
    cached = _FAST_THINK_MODE_CACHE.get(model_key)
    if cached is not None:
        return [cached] if cached == "none" else [cached, "none"]

    lower_url = base_url.lower()
    lower_model = model_name.lower()

    if "generativelanguage.googleapis.com" in lower_url or lower_model.startswith("gemini"):
        return ["effort_minimal", "effort_low", "none"]
    if "open.bigmodel.cn" in lower_url or lower_model.startswith("glm"):
        # GLM-5 系列为始终思考模型（不支持 thinking.type=disabled，直接走 reasoning_effort=low 可将首字延迟从 ~7s 压到 ~1.7s）
        if lower_model.startswith("glm-5"):
            return ["effort_low", "none"]
        return ["disabled", "effort_low", "none"]
    return ["none"]


def _apply_think_mode(kwargs: dict[str, Any], mode: str) -> None:
    """将指定的低思考档位写入请求参数"""
    kwargs.pop("reasoning_effort", None)
    kwargs.pop("extra_body", None)
    if mode == "disabled":
        kwargs["extra_body"] = {"thinking": {"type": "disabled"}}
    elif mode == "effort_minimal":
        kwargs["reasoning_effort"] = "minimal"
    elif mode == "effort_low":
        kwargs["reasoning_effort"] = "low"


async def _create_async_completion_fast(
    client: AsyncOpenAI,
    base_kwargs: dict[str, Any],
    base_url: str,
    model_name: str,
):
    """带低思考档位自动探测与缓存的异步请求封装（遇到 400 自动滑向下一档并记忆最优档）"""
    model_key = (base_url.lower(), model_name.lower())
    modes = _candidate_fast_think_modes(base_url, model_name)
    last_exc: Exception | None = None

    for idx, mode in enumerate(modes):
        req_kwargs = dict(base_kwargs)
        _apply_think_mode(req_kwargs, mode)
        try:
            result = await client.chat.completions.create(**req_kwargs)
            _FAST_THINK_MODE_CACHE[model_key] = mode
            return result
        except Exception as exc:
            last_exc = exc
            if getattr(exc, "status_code", None) == 400:
                # 最后一档仍报 400 时，顺便剥离可选 response_format 再做一次兜底重试
                if idx == len(modes) - 1 and "response_format" in req_kwargs:
                    req_kwargs.pop("response_format", None)
                    _FAST_THINK_MODE_CACHE[model_key] = "none"
                    return await client.chat.completions.create(**req_kwargs)
                continue
            raise

    if last_exc is not None:
        raise last_exc
    raise RuntimeError("模型调用失败")


def _filter_history_for_llm(recent_messages: list[dict[str, Any]], limit: int = 10) -> list[dict[str, str]]:
    """过滤兜底报错句与空白占位符，防止异常历史污染上下文诱发模型复读"""
    cleaned: list[dict[str, str]] = []
    for msg in recent_messages:
        role = str(msg.get("role") or "")
        content = str(msg.get("content") or "").strip()
        if role not in ("user", "assistant") or not content:
            continue
        if role == "assistant" and content in _HISTORY_NOISE_PHRASES:
            continue
        cleaned.append({"role": role, "content": content})
    return cleaned[-limit:]


async def stream_voice_call_reply(
    user_message: str,
    date_str: str | None = None,
    mode: str = "normal",
) -> AsyncIterator[str]:
    """
    主轨极速流式对话生成器：
    直接以 stream=True 从 LLM 逐字产出纯台湾腔口语文本，不等待完整 JSON 闭合。
    """
    today_str = date_str or datetime.now().strftime("%Y-%m-%d")
    settings = _load_settings_dict()
    bot_name = settings.get("bot_name", "灵儿")
    llm_cfg = settings.get("llm", {})
    api_key = (llm_cfg.get("api_key") or "").strip()
    base_url = (llm_cfg.get("base_url") or "https://generativelanguage.googleapis.com/v1beta/openai/").strip()
    model_name = (llm_cfg.get("model") or "gemini-2.5-flash").strip()

    ctx = _load_daily_context(today_str)

    if not api_key:
        fallback = _offline_fallback_response(user_message, ctx, mode, bot_name)
        yield str(fallback.get("reply") or "欸～我在听喔，先去设置页填上 API Key，我就能跟你畅快讲电话啦！")
        return

    system_prompt = _build_voice_call_system_prompt(settings, ctx, mode, today_str)
    chat_messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
    chat_messages.extend(_filter_history_for_llm(ctx["recent_messages"], limit=10))
    chat_messages.append({"role": "user", "content": user_message})

    client = _get_async_openai_client(api_key=api_key, base_url=base_url)
    # 注意：GLM-5.3 等始终思考模型的 reasoning_content 与 content 共享 max_tokens，
    # 必须留足 >= 1024 预算（正文长度靠 System Prompt 约束在 1~3 句），避免思考耗尽额度导致正文为空！
    base_kwargs: dict[str, Any] = {
        "model": model_name,
        "messages": chat_messages,
        "temperature": 0.8,
        "max_tokens": 1024,
        "stream": True,
    }
    stream = await _create_async_completion_fast(client, base_kwargs, base_url, model_name)

    async for chunk in stream:
        if not chunk.choices:
            continue
        delta_obj = chunk.choices[0].delta
        piece = getattr(delta_obj, "content", None)
        if piece:
            yield piece


def save_voice_call_messages(
    date_str: str,
    user_message: str,
    assistant_reply: str,
    duration_ms: int | None = None,
) -> None:
    """将语音通话的本轮问答即时持久化至 SQLite messages 表（明确标记 channel='voice'）"""
    now_iso = datetime.now().isoformat(timespec="seconds")
    with db_cursor() as cur:
        if user_message.strip():
            cur.execute(
                """
                INSERT INTO messages (session_date, channel, role, content, trigger_type, created_at)
                VALUES (?, 'voice', 'user', ?, 'voice_call', ?);
                """,
                (date_str, user_message.strip(), now_iso),
            )
        if assistant_reply.strip():
            cur.execute(
                """
                INSERT INTO messages (session_date, channel, role, content, trigger_type, created_at, duration_ms)
                VALUES (?, 'voice', 'assistant', ?, 'voice_call', ?, ?);
                """,
                (date_str, assistant_reply.strip(), now_iso, duration_ms),
            )


async def archive_voice_call_turn_async(
    date_str: str,
    user_message: str,
    assistant_reply: str,
    mode: str = "normal",
) -> dict[str, Any]:
    """
    副轨后台静默归档（完全不阻塞语音通话延迟）：
    在本轮通话结束后异步分析用户说的话，静默提取习惯打卡、心情/精力、小确幸与长期记忆并刷新 Markdown。
    """
    settings = _load_settings_dict()
    llm_cfg = settings.get("llm", {})
    api_key = (llm_cfg.get("api_key") or "").strip()
    base_url = (llm_cfg.get("base_url") or "https://generativelanguage.googleapis.com/v1beta/openai/").strip()
    model_name = (llm_cfg.get("model") or "gemini-2.5-flash").strip()

    ctx = _load_daily_context(date_str)
    extracted: dict[str, Any] = {}

    if not api_key:
        bot_name = settings.get("bot_name", "灵儿")
        extracted = _offline_fallback_response(user_message, ctx, mode, bot_name).get("extracted") or {}
    else:
        habit_lines = [
            f"- [ID:{h['id']}] {h['title']}（今日当前状态:{h['today_status'] or '未记录'}）"
            for h in ctx["habits"]
        ]
        habits_block = "\n".join(habit_lines) if habit_lines else "（无预设习惯）"

        extractor_prompt = f"""你是后台静默记录助手。请根据刚刚这一轮实时语音对话，提取值得归档的结构化信息，严格输出合法 JSON（不要任何额外说明）。

今日预设习惯清单：
{habits_block}

请返回如下 JSON：
{{
  "habit_updates": [{{"habit_id": 1, "status": "done | partial | missed", "note": "简短备注"}}],
  "mood_score": null,
  "energy_score": null,
  "daily_summary_append": "",
  "new_highlights": [],
  "new_memories": [{{"memory_type": "preference | ongoing_event | highlight", "content": "具体记忆", "follow_up_date": null}}]
}}
规则：
- 仅当用户**明确提到**某项习惯状态时才写入 habit_updates，绝不猜测。
- 普通寒暄若无实质可归档内容，各数组保持空 []、评分保持 null、摘要保持空字符串 ""。"""

        client = _get_async_openai_client(api_key=api_key, base_url=base_url)
        base_kwargs: dict[str, Any] = {
            "model": model_name,
            "messages": [
                {"role": "system", "content": extractor_prompt},
                {
                    "role": "user",
                    "content": f"用户刚刚说：{user_message}\n灵儿回复：{assistant_reply}",
                },
            ],
            "temperature": 0.1,
            "max_tokens": 1024,
            "response_format": {"type": "json_object"},
        }
        try:
            completion = await _create_async_completion_fast(
                client, base_kwargs, base_url, model_name
            )
        except Exception:
            return {"tags": [], "pending_habits": []}

        raw = (completion.choices[0].message.content or "").strip()
        fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.DOTALL)
        if fence_match:
            raw = fence_match.group(1)
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                extracted = parsed
        except json.JSONDecodeError:
            extracted = {}

    archive_result = _apply_extracted_updates(date_str, extracted)
    applied = archive_result["applied"]
    tags: list[str] = []
    if applied.get("habit_updates"):
        tags.append(f"已静默记录 {len(applied['habit_updates'])} 项习惯")
    if applied.get("new_highlights"):
        tags.append(f"收入 {len(applied['new_highlights'])} 条小确幸")
    if applied.get("new_memories"):
        tags.append(f"记住 {len(applied['new_memories'])} 条长期记忆")

    updated_habit_ids = {item["habit_id"] for item in applied.get("habit_updates") or []}
    pending_habits = [
        {"id": h["id"], "title": h["title"], "category": h["category"]}
        for h in ctx["pending_habits"]
        if h["id"] not in updated_habit_ids
    ]
    return {
        "applied": applied,
        "tags": tags,
        "pending_habits": pending_habits,
        "md_path": archive_result["md_path"],
    }
