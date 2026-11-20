"""
一对一低延迟实时语音通话全双工 WebSocket 路由（/ws/voice-call）
------------------------------------------------------------
核心架构（极速流式双轨管道）：
1. 连接建立（start_call）：后台立即预热本地 Faster-Whisper 模型，同时秒播缓存的台湾腔接听问候语。
2. 语音轮次（audio_meta + 二进制 WAV / audio_turn / text_turn）：
   - 阶段 A（极速 STT）：本地 Faster-Whisper fast_mode（beam_size=1 + VAD 静音幻觉过滤）或 Fish Audio ASR 兜底。
   - 阶段 B（流式 LLM 首句抢跑）：AsyncOpenAI(stream=True) 直接输出纯台湾腔短口语，增量分句器在第一句/首短语一完成就立即抛给 TTS。
   - 阶段 C（并发有序 TTS 推送）：最多 2 路并发合成后续句子，按 seq 严格顺序推送 MP3 音频帧给前端无缝播放；Fish Audio 异常时自动兜底 Edge-TTS，绝不冷场断音。
   - 阶段 D（副轨后台静默归档）：本轮结束后异步提取习惯打卡、心情、小确幸与长期记忆并导出 Markdown，零增加通话延迟。
3. 随时插话打断（interrupt）：毫秒级取消当前轮次的 LLM 流与所有待合成 TTS 任务，按 turn_id 严格隔离旧音频。
"""

import asyncio
import base64
import json
import time
from contextlib import suppress
from datetime import datetime
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.database import db_cursor
from app.services.agent_brain import (
    IncrementalSentenceSplitter,
    archive_voice_call_turn_async,
    infer_reply_emotion,
    save_voice_call_messages,
    stream_voice_call_reply,
)
from app.services.stt_service import (
    get_fish_asr_api_key,
    get_stt_status,
    polish_asr_transcript,
    transcribe_wav_bytes,
    transcribe_with_fish_audio,
    warmup_stt_engine,
)
from app.services.tts_provider import (
    EdgeTTSProvider,
    get_tts_cache_path,
    get_tts_provider,
    read_tts_cache,
    write_tts_cache,
)

router = APIRouter(tags=["VoiceCall"])


def _load_call_settings() -> tuple[str, dict[str, Any]]:
    """读取当前小管家昵称与最新 TTS 配置"""
    bot_name = "灵儿"
    tts_cfg: dict[str, Any] = {
        "provider": "edge_tts",
        "voice": "zh-TW-HsiaoChenNeural",
        "rate": "+25%",
        "pitch": "+0Hz",
    }
    with db_cursor() as cur:
        cur.execute("SELECT key, value FROM settings WHERE key IN ('bot_name', 'tts');")
        for row in cur.fetchall():
            if row["key"] == "bot_name":
                bot_name = str(json.loads(row["value"]) or "灵儿")
            elif row["key"] == "tts":
                loaded = json.loads(row["value"])
                if isinstance(loaded, dict):
                    tts_cfg.update(loaded)
    return bot_name, tts_cfg


async def _transcribe_turn_audio(wav_bytes: bytes) -> tuple[str, str]:
    """执行实时通话语音识别（优先阿里 SenseVoiceSmall，其次 Faster-Whisper / Fish Audio）并自动纠错整理"""
    status = get_stt_status()
    if status.get("engine") in ("faster-whisper", "sherpa-onnx") and status.get("ready"):
        result = await asyncio.to_thread(transcribe_wav_bytes, wav_bytes, fast_mode=True)
        raw_text = str(result.get("text") or "").strip()
        engine = str(result.get("engine") or status["engine"])
    else:
        fish_key = get_fish_asr_api_key()
        if fish_key:
            result = await transcribe_with_fish_audio(wav_bytes, fish_key)
            raw_text = str(result.get("text") or "").strip()
            engine = "fish-audio"
        else:
            result = await asyncio.to_thread(transcribe_wav_bytes, wav_bytes, fast_mode=True)
            raw_text = str(result.get("text") or "").strip()
            engine = str(result.get("engine") or "local")

    if not raw_text:
        return "", engine

    polished_text = await polish_asr_transcript(raw_text)
    return polished_text, engine


async def _synthesize_clause_bytes(
    text: str,
    tts_cfg: dict[str, Any],
    rate_override: str | None,
    tts_semaphore: asyncio.Semaphore,
) -> tuple[bytes, str]:
    """
    合成单句 MP3 音频：
    1. 优先命中本地磁盘缓存（零网络延迟）。
    2. 受限于 Semaphore(2) 并发合成，既能让下一句提前抢跑，又避免触发 Fish Audio 并发限流。
    3. 若 Fish Audio 临时报错或超时，自动降级 Edge-TTS，保证通话不断音。
    """
    voice = str(tts_cfg.get("voice") or "zh-TW-HsiaoChenNeural")
    rate = str(rate_override or tts_cfg.get("rate") or "+25%")
    pitch = str(tts_cfg.get("pitch") or "+0Hz")
    use_fish = (
        tts_cfg.get("provider") == "fish_audio"
        and bool(str(tts_cfg.get("fish_api_key", "")).strip())
    )
    actual_provider = "fish_audio" if use_fish else "edge_tts"
    fish_ref = str(tts_cfg.get("fish_reference_id", ""))
    fish_model = str(tts_cfg.get("fish_model", "s2.1-pro"))

    cache_path = get_tts_cache_path(
        provider_name=actual_provider,
        text=text,
        voice=voice,
        rate=rate,
        pitch=pitch,
        fish_reference_id=fish_ref,
        fish_model=fish_model,
    )
    cached = read_tts_cache(cache_path)
    if cached is not None:
        return cached.read_bytes(), actual_provider

    async with tts_semaphore:
        provider = get_tts_provider(tts_cfg)
        try:
            audio_bytes = await provider.synthesize_bytes(
                text=text,
                voice=voice,
                rate=rate,
                pitch=pitch,
            )
            if audio_bytes:
                write_tts_cache(cache_path, audio_bytes)
                return audio_bytes, actual_provider
        except Exception:
            if not use_fish:
                raise

        # Fish Audio 失败或返回空音频时，无感降级到微软台湾腔 Edge-TTS
        fallback_path = get_tts_cache_path(
            provider_name="edge_tts",
            text=text,
            voice=voice,
            rate=rate,
            pitch=pitch,
        )
        fallback_cached = read_tts_cache(fallback_path)
        if fallback_cached is not None:
            return fallback_cached.read_bytes(), "edge_tts"

        audio_bytes = await EdgeTTSProvider().synthesize_bytes(
            text=text,
            voice=voice,
            rate=rate,
            pitch=pitch,
        )
        if audio_bytes:
            write_tts_cache(fallback_path, audio_bytes)
        return audio_bytes, "edge_tts"


@router.websocket("/ws/voice-call")
async def voice_call_websocket(websocket: WebSocket):
    """一对一低延迟实时语音通话全双工通道"""
    await websocket.accept()

    send_lock = asyncio.Lock()
    ws_closed = False

    async def safe_send(payload: dict[str, Any]) -> bool:
        nonlocal ws_closed
        if ws_closed:
            return False
        async with send_lock:
            if ws_closed:
                return False
            try:
                await websocket.send_json(payload)
                return True
            except Exception:
                ws_closed = True
                return False

    # 会话级状态
    current_mode = "normal"
    current_rate: str | None = None
    active_turn_task: asyncio.Task[None] | None = None
    active_turn_id: int = 0
    active_turn_user_text: str = ""
    active_turn_saved: bool = False
    pending_audio_meta: dict[str, Any] | None = None
    background_tasks: set[asyncio.Task[Any]] = set()
    tts_semaphore = asyncio.Semaphore(2)

    def _track_bg_task(task: asyncio.Task[Any]) -> None:
        background_tasks.add(task)
        task.add_done_callback(background_tasks.discard)

    def _safe_turn_id(raw_val: Any, fallback: int) -> int:
        try:
            if raw_val is None or isinstance(raw_val, bool):
                return fallback
            return int(raw_val)
        except (TypeError, ValueError):
            return fallback

    async def cancel_active_turn(
        spoken_text: str = "",
        *,
        reason: str = "interrupted",
    ) -> None:
        """立即中止正在进行的 LLM 流式生成与 TTS 合成任务，并在必要时保存已说出口的部分上下文"""
        nonlocal active_turn_task, active_turn_saved
        task = active_turn_task
        active_turn_task = None
        if task is not None and not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await task

        # 若灵儿已被打断且尚未落库，但用户已经说过有效内容，保存本轮真实发生的片段以保持上下文连贯
        if active_turn_user_text and not active_turn_saved:
            active_turn_saved = True
            partial = spoken_text.strip()
            today_str = datetime.now().strftime("%Y-%m-%d")
            fallback_note = (
                "（通话已挂断）" if reason in ("end_call", "disconnect") else "（被用户插话打断）"
            )
            await asyncio.to_thread(
                save_voice_call_messages,
                today_str,
                active_turn_user_text,
                f"{partial}…" if partial else fallback_note,
                None,
            )

    async def run_turn(
        turn_id: int,
        *,
        wav_bytes: bytes | None = None,
        preset_text: str | None = None,
        mode: str = "normal",
        rate_override: str | None = None,
    ) -> None:
        nonlocal active_turn_user_text, active_turn_saved
        turn_started = time.perf_counter()
        today_str = datetime.now().strftime("%Y-%m-%d")
        active_turn_user_text = ""
        active_turn_saved = False

        # 用于中断时统一清理所有待合成的 TTS 任务
        spawned_tts_tasks: list[asyncio.Task[tuple[bytes, str]]] = []
        consumer_task: asyncio.Task[None] | None = None

        try:
            # 1. 语音转文字（若直接传入文本轮次则跳过 STT）
            stt_ms = 0
            if preset_text is not None:
                user_text = preset_text.strip()
            else:
                await safe_send({"type": "state", "turn_id": turn_id, "state": "transcribing"})
                stt_t0 = time.perf_counter()
                user_text, _stt_engine = await _transcribe_turn_audio(wav_bytes or b"")
                stt_ms = round((time.perf_counter() - stt_t0) * 1000)

            if not user_text:
                await safe_send({"type": "no_speech", "turn_id": turn_id, "stt_ms": stt_ms})
                return

            active_turn_user_text = user_text
            await safe_send(
                {
                    "type": "user_transcript",
                    "turn_id": turn_id,
                    "text": user_text,
                    "stt_ms": stt_ms,
                }
            )
            await safe_send({"type": "state", "turn_id": turn_id, "state": "thinking"})

            # 2. 启动主轨流式 LLM + 增量首句抢跑分句 + 并发有序 TTS 推送管道
            _bot_name, tts_cfg = _load_call_settings()
            splitter = IncrementalSentenceSplitter()
            tts_queue: asyncio.Queue[tuple[int, str, asyncio.Task[tuple[bytes, str]]] | None] = (
                asyncio.Queue()
            )

            first_token_ms: int | None = None
            first_audio_ms: int | None = None
            full_reply_parts: list[str] = []
            clause_seq = 0
            llm_t0 = time.perf_counter()

            async def tts_sender_loop() -> None:
                nonlocal first_audio_ms
                while True:
                    item = await tts_queue.get()
                    if item is None:
                        break
                    seq_idx, clause_text, synth_task = item
                    try:
                        audio_bytes, actual_provider = await synth_task
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:
                        await safe_send(
                            {
                                "type": "warning",
                                "turn_id": turn_id,
                                "message": f"第 {seq_idx + 1} 句语音合成失败：{exc}",
                            }
                        )
                        continue

                    if not audio_bytes:
                        continue

                    if first_audio_ms is None:
                        first_audio_ms = round((time.perf_counter() - turn_started) * 1000)
                        await safe_send(
                            {"type": "state", "turn_id": turn_id, "state": "speaking"}
                        )

                    await safe_send(
                        {
                            "type": "tts_audio",
                            "turn_id": turn_id,
                            "seq": seq_idx,
                            "sentence": clause_text,
                            "mime": "audio/mpeg",
                            "audio_b64": base64.b64encode(audio_bytes).decode("ascii"),
                            "provider": actual_provider,
                            "ttfa_ms": first_audio_ms,
                        }
                    )

            consumer_task = asyncio.create_task(tts_sender_loop())

            async for delta in stream_voice_call_reply(
                user_message=user_text,
                date_str=today_str,
                mode=mode,
            ):
                if first_token_ms is None:
                    first_token_ms = round((time.perf_counter() - llm_t0) * 1000)

                full_reply_parts.append(delta)
                full_so_far = "".join(full_reply_parts)
                await safe_send(
                    {
                        "type": "assistant_delta",
                        "turn_id": turn_id,
                        "delta": delta,
                        "full_text": full_so_far,
                    }
                )

                for clause in splitter.feed(delta):
                    synth_task = asyncio.create_task(
                        _synthesize_clause_bytes(clause, tts_cfg, rate_override, tts_semaphore)
                    )
                    spawned_tts_tasks.append(synth_task)
                    await tts_queue.put((clause_seq, clause, synth_task))
                    clause_seq += 1

            # 冲刷尾句
            for tail_clause in splitter.flush():
                synth_task = asyncio.create_task(
                    _synthesize_clause_bytes(tail_clause, tts_cfg, rate_override, tts_semaphore)
                )
                spawned_tts_tasks.append(synth_task)
                await tts_queue.put((clause_seq, tail_clause, synth_task))
                clause_seq += 1

            await tts_queue.put(None)
            await consumer_task

            full_reply = "".join(full_reply_parts).strip()
            total_ms = max(1, round((time.perf_counter() - turn_started) * 1000))

            if not full_reply:
                # 兜底：若云端模型返回空正文，绝不写入 SQLite 历史（防止污染后续上下文造成复读），
                # 而是发出温和提示并让前端顺畅切回倾听态
                active_turn_saved = True
                retry_hint = "欸～刚刚信号有点小卡顿没听到回音，你可以再跟我说一次吗？"
                try:
                    audio_bytes, actual_provider = await _synthesize_clause_bytes(
                        retry_hint, tts_cfg, rate_override, tts_semaphore
                    )
                    if audio_bytes:
                        await safe_send({"type": "state", "turn_id": turn_id, "state": "speaking"})
                        await safe_send(
                            {
                                "type": "tts_audio",
                                "turn_id": turn_id,
                                "seq": 0,
                                "sentence": retry_hint,
                                "mime": "audio/mpeg",
                                "audio_b64": base64.b64encode(audio_bytes).decode("ascii"),
                                "provider": actual_provider,
                            }
                        )
                except Exception:
                    pass
                await safe_send(
                    {
                        "type": "warning",
                        "turn_id": turn_id,
                        "message": "云端模型本次未输出正文内容，已跳过写入历史，可直接继续说话",
                    }
                )
                await safe_send(
                    {
                        "type": "turn_done",
                        "turn_id": turn_id,
                        "reply": "",
                        "emotion": "thinking",
                        "stt_ms": stt_ms,
                        "llm_first_token_ms": first_token_ms or 0,
                        "first_audio_ms": first_audio_ms or total_ms,
                        "total_ms": total_ms,
                    }
                )
                return

            emotion = infer_reply_emotion(full_reply)

            # 3. 立即保存本轮有效对话到 SQLite，与主聊天室完全同步
            active_turn_saved = True
            await asyncio.to_thread(
                save_voice_call_messages,
                today_str,
                user_text,
                full_reply,
                total_ms,
            )

            await safe_send(
                {
                    "type": "turn_done",
                    "turn_id": turn_id,
                    "reply": full_reply,
                    "emotion": emotion,
                    "stt_ms": stt_ms,
                    "llm_first_token_ms": first_token_ms or 0,
                    "first_audio_ms": first_audio_ms or total_ms,
                    "total_ms": total_ms,
                }
            )

            # 4. 副轨后台异步静默归档：主动避让主轨实时通话，避免与下一轮语音并发抢占同一模型配额
            async def _bg_archive() -> None:
                try:
                    await asyncio.sleep(1.5)
                    waited = 0.0
                    while (
                        active_turn_task is not None
                        and not active_turn_task.done()
                        and waited < 8.0
                    ):
                        await asyncio.sleep(0.4)
                        waited += 0.4

                    result = await archive_voice_call_turn_async(
                        date_str=today_str,
                        user_message=user_text,
                        assistant_reply=full_reply,
                        mode=mode,
                    )
                    await safe_send(
                        {
                            "type": "archived",
                            "turn_id": turn_id,
                            "tags": result.get("tags") or [],
                            "pending_habits": result.get("pending_habits") or [],
                        }
                    )
                except Exception:
                    pass

            _track_bg_task(asyncio.create_task(_bg_archive()))

        except asyncio.CancelledError:
            for t in spawned_tts_tasks:
                if not t.done():
                    t.cancel()
            if consumer_task and not consumer_task.done():
                consumer_task.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await consumer_task
            raise
        except Exception as exc:
            for t in spawned_tts_tasks:
                if not t.done():
                    t.cancel()
            if consumer_task and not consumer_task.done():
                consumer_task.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await consumer_task
            await safe_send(
                {
                    "type": "error",
                    "turn_id": turn_id,
                    "message": f"本轮语音处理遇到一点状况：{exc}",
                }
            )

    async def send_opening_greeting(mode: str, rate_override: str | None) -> None:
        """接通电话后秒播一句本地缓存的台湾腔接听问候语（可随时被用户插话打断）"""
        bot_name, tts_cfg = _load_call_settings()
        greeting_text = (
            f"喂～晚上好呀！我是{bot_name}，我们一起轻松聊聊今天的复盘吧～"
            if mode == "evening_review"
            else f"喂～嗨啰！我是{bot_name}，随时都可以直接跟我聊喔！"
        )
        try:
            audio_bytes, actual_provider = await _synthesize_clause_bytes(
                greeting_text,
                tts_cfg,
                rate_override,
                tts_semaphore,
            )
            if audio_bytes:
                await safe_send({"type": "state", "turn_id": 0, "state": "speaking"})
                await safe_send(
                    {
                        "type": "tts_audio",
                        "turn_id": 0,
                        "seq": 0,
                        "sentence": greeting_text,
                        "mime": "audio/mpeg",
                        "audio_b64": base64.b64encode(audio_bytes).decode("ascii"),
                        "provider": actual_provider,
                        "is_greeting": True,
                    }
                )
                await safe_send(
                    {
                        "type": "greeting_done",
                        "turn_id": 0,
                        "text": greeting_text,
                    }
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            # 问候语失败不阻断通话，直接切入倾听
            await safe_send({"type": "state", "turn_id": 0, "state": "listening"})

    try:
        while True:
            message = await websocket.receive()
            msg_type = message.get("type")
            if msg_type == "websocket.disconnect":
                break

            # 二进制帧：前端先发 audio_meta，再发原始 16kHz PCM WAV 字节（零 Base64 开销）
            if message.get("bytes") is not None:
                wav_bytes = message["bytes"]
                meta = pending_audio_meta or {}
                pending_audio_meta = None
                turn_id = _safe_turn_id(meta.get("turn_id"), active_turn_id + 1)
                mode = str(meta.get("mode") or current_mode)
                rate = meta.get("rate") or current_rate

                await cancel_active_turn()
                active_turn_id = turn_id
                active_turn_task = asyncio.create_task(
                    run_turn(turn_id, wav_bytes=wav_bytes, mode=mode, rate_override=rate)
                )
                continue

            raw_text = message.get("text")
            if not raw_text:
                continue

            try:
                data = json.loads(raw_text)
            except json.JSONDecodeError:
                continue

            event_type = str(data.get("type") or "")

            if event_type == "start_call":
                pending_audio_meta = None
                current_mode = str(data.get("mode") or "normal")
                current_rate = data.get("rate") or None
                play_greeting = bool(data.get("play_greeting", True))

                bot_name, tts_cfg = _load_call_settings()
                stt_status = get_stt_status()
                use_fish = (
                    tts_cfg.get("provider") == "fish_audio"
                    and bool(str(tts_cfg.get("fish_api_key", "")).strip())
                )

                # 后台立即预热本地离线 STT，消除第一轮说话时的 1.8s 模型加载等待
                _track_bg_task(asyncio.create_task(asyncio.to_thread(warmup_stt_engine)))

                await safe_send(
                    {
                        "type": "call_ready",
                        "bot_name": bot_name,
                        "mode": current_mode,
                        "stt_ready": bool(stt_status.get("ready")),
                        "stt_engine": str(stt_status.get("engine") or "unknown"),
                        "tts_provider": "fish_audio" if use_fish else "edge_tts",
                    }
                )

                if play_greeting:
                    await cancel_active_turn()
                    active_turn_id = 0
                    active_turn_task = asyncio.create_task(
                        send_opening_greeting(current_mode, current_rate)
                    )

            elif event_type == "update_config":
                if data.get("mode"):
                    current_mode = str(data["mode"])
                if data.get("rate"):
                    current_rate = str(data["rate"])

            elif event_type == "audio_meta":
                pending_audio_meta = data

            elif event_type == "audio_turn":
                pending_audio_meta = None
                turn_id = _safe_turn_id(data.get("turn_id"), active_turn_id + 1)
                mode = str(data.get("mode") or current_mode)
                rate = data.get("rate") or current_rate
                audio_b64 = str(data.get("audio_b64") or "")
                try:
                    wav_bytes = base64.b64decode(audio_b64) if audio_b64 else b""
                except Exception:
                    await safe_send(
                        {"type": "error", "turn_id": turn_id, "detail": "音频 Base64 格式无效"}
                    )
                    continue

                await cancel_active_turn()
                active_turn_id = turn_id
                active_turn_task = asyncio.create_task(
                    run_turn(turn_id, wav_bytes=wav_bytes, mode=mode, rate_override=rate)
                )

            elif event_type == "text_turn":
                pending_audio_meta = None
                turn_id = _safe_turn_id(data.get("turn_id"), active_turn_id + 1)
                mode = str(data.get("mode") or current_mode)
                rate = data.get("rate") or current_rate
                text = str(data.get("text") or "").strip()
                if not text:
                    continue

                await cancel_active_turn()
                active_turn_id = turn_id
                active_turn_task = asyncio.create_task(
                    run_turn(turn_id, preset_text=text, mode=mode, rate_override=rate)
                )

            elif event_type == "interrupt":
                pending_audio_meta = None
                spoken = str(data.get("spoken_text") or "")
                interrupted_id = _safe_turn_id(data.get("turn_id"), active_turn_id)
                await cancel_active_turn(spoken_text=spoken, reason="interrupted")
                await safe_send({"type": "interrupted", "turn_id": interrupted_id})

            elif event_type == "ping":
                await safe_send({"type": "pong"})

            elif event_type == "end_call":
                pending_audio_meta = None
                await cancel_active_turn(reason="end_call")
                break

    except WebSocketDisconnect:
        pass
    finally:
        ws_closed = True
        await cancel_active_turn(reason="disconnect")
