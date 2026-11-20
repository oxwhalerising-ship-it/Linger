"""
台湾腔语音合成与反应垫词路由（/api/voice）
-----------------------------------------
提供流式 MP3 语音合成、推荐台湾腔音色列表、以及 0.3 秒本地反应垫词音频接口。
"""

import asyncio
import json
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from app.database import db_cursor
from app.schemas import TTSRequest, WakewordToggleRequest
from app.services.stt_service import (
    get_fish_asr_api_key,
    get_stt_status,
    polish_asr_transcript,
    transcribe_wav_bytes,
    transcribe_with_fish_audio,
)
from app.services.tts_provider import (
    FISH_AUDIO_MODELS,
    RECOMMENDED_TW_VOICES,
    TAIWAN_FILLERS,
    get_or_create_filler_audio,
    get_tts_cache_path,
    get_tts_provider,
    read_tts_cache,
    write_tts_cache,
)
from app.services.wakeword_service import wakeword_engine

router = APIRouter(prefix="/api/voice", tags=["Voice"])


def _get_tts_settings() -> dict:
    """读取 settings 表中的 TTS 默认参数"""
    with db_cursor() as cur:
        cur.execute("SELECT value FROM settings WHERE key = 'tts';")
        row = cur.fetchone()
    if row:
        return json.loads(row["value"])
    return {
        "provider": "edge_tts",
        "voice": "zh-TW-HsiaoChenNeural",
        "rate": "+0%",
        "pitch": "+0Hz",
    }


@router.get("/voices")
def list_voices():
    """返回推荐的免费台湾腔神经音色列表与 Fish Audio 模型选项"""
    return {
        "voices": RECOMMENDED_TW_VOICES,
        "fish_models": FISH_AUDIO_MODELS,
        "current": _get_tts_settings(),
    }


@router.post("/tts")
async def synthesize_speech(payload: TTSRequest):
    """
    将一段台湾腔文本合成为 MP3 音频流返回。
    支持 Edge-TTS 与 Fish Audio；配合前端对 /api/chat 返回的 sentences 逐句请求，可实现低延迟播报。
    """
    tts_cfg = dict(_get_tts_settings())
    if payload.provider:
        tts_cfg["provider"] = payload.provider
    if payload.fish_api_key is not None:
        tts_cfg["fish_api_key"] = payload.fish_api_key
    if payload.fish_reference_id is not None:
        tts_cfg["fish_reference_id"] = payload.fish_reference_id
    if payload.fish_model:
        tts_cfg["fish_model"] = payload.fish_model

    provider = get_tts_provider(tts_cfg)
    voice = payload.voice or tts_cfg.get("voice", "zh-TW-HsiaoChenNeural")
    rate = payload.rate or tts_cfg.get("rate", "+0%")
    pitch = payload.pitch or tts_cfg.get("pitch", "+0Hz")
    use_fish = (
        tts_cfg.get("provider") == "fish_audio"
        and bool(str(tts_cfg.get("fish_api_key", "")).strip())
    )
    actual_provider = "fish_audio" if use_fish else "edge_tts"
    cache_path = get_tts_cache_path(
        provider_name=actual_provider,
        text=payload.text,
        voice=voice,
        rate=rate,
        pitch=pitch,
        fish_reference_id=str(tts_cfg.get("fish_reference_id", "")),
        fish_model=str(tts_cfg.get("fish_model", "s2.1-pro")),
    )

    # 命中本地缓存直接秒回（点击「重新朗读」无需再请求云端，零延迟且不重复扣费）
    cached_file = read_tts_cache(cache_path)
    if cached_file is not None:
        return FileResponse(
            path=str(cached_file),
            media_type="audio/mpeg",
            headers={
                "X-TTS-Provider": actual_provider,
                "X-TTS-Cache": "HIT",
                "Access-Control-Expose-Headers": "X-TTS-Provider, X-TTS-Cache",
            },
        )

    try:
        # Fish Audio 先行拉取整句并落盘缓存，确保认证/余额等 HTTP 错误能准确返回给前端
        if use_fish:
            audio_bytes = await provider.synthesize_bytes(
                text=payload.text, voice=voice, rate=rate, pitch=pitch
            )
            write_tts_cache(cache_path, audio_bytes)
            return StreamingResponse(
                iter([audio_bytes]),
                media_type="audio/mpeg",
                headers={
                    "X-TTS-Provider": "fish_audio",
                    "X-TTS-Cache": "MISS",
                    "Access-Control-Expose-Headers": "X-TTS-Provider, X-TTS-Cache",
                },
            )

        # Edge-TTS 边流式输出边收集分片，流结束后写入本地缓存供重播秒开
        async def _stream_and_cache():
            collected: list[bytes] = []
            async for chunk in provider.stream_chunks(
                text=payload.text, voice=voice, rate=rate, pitch=pitch
            ):
                collected.append(chunk)
                yield chunk
            if collected:
                write_tts_cache(cache_path, b"".join(collected))

        return StreamingResponse(
            _stream_and_cache(),
            media_type="audio/mpeg",
            headers={
                "X-TTS-Provider": "edge_tts",
                "X-TTS-Cache": "MISS",
                "Access-Control-Expose-Headers": "X-TTS-Provider, X-TTS-Cache",
            },
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"语音合成失败：{exc}") from exc


@router.get("/fillers")
def list_fillers():
    """返回所有可用的台湾腔超短反应垫词列表"""
    return {
        "fillers": [
            {"id": fid, "text": text, "audio_url": f"/api/voice/fillers/{fid}"}
            for fid, text in TAIWAN_FILLERS.items()
        ]
    }


@router.get("/fillers/{filler_id}")
async def get_filler_audio(filler_id: str):
    """获取单条反应垫词的本地缓存 MP3（首次请求自动合成并缓存，之后零延迟读取）"""
    if filler_id not in TAIWAN_FILLERS:
        raise HTTPException(status_code=404, detail="找不到对应的反应垫词")

    tts_cfg = _get_tts_settings()
    voice = tts_cfg.get("voice", "zh-TW-HsiaoChenNeural")
    try:
        audio_path = await get_or_create_filler_audio(
            filler_id=filler_id,
            voice=voice,
            tts_cfg=tts_cfg,
        )
        return FileResponse(path=str(audio_path), media_type="audio/mpeg")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"生成反应垫词音频失败：{exc}") from exc


@router.get("/stt/status")
def stt_engine_status():
    """查询本地离线语音识别（sherpa-onnx ASR）是否就绪"""
    return get_stt_status()


@router.post("/stt")
async def speech_to_text(audio: UploadFile = File(..., description="16kHz 单声道 PCM WAV 音频文件")):
    """接收前端录制的 WAV 音频，优先本地离线 Faster-Whisper / sherpa-onnx，未装离线引擎时兜底 Fish Audio ASR"""
    wav_bytes = await audio.read()
    if not wav_bytes:
        raise HTTPException(status_code=400, detail="上传的音频内容为空")

    status = get_stt_status()
    try:
        if status.get("engine") in ("faster-whisper", "sherpa-onnx") and status.get("ready"):
            result = await asyncio.to_thread(transcribe_wav_bytes, wav_bytes)
        else:
            fish_key = get_fish_asr_api_key()
            if fish_key:
                result = await transcribe_with_fish_audio(wav_bytes, fish_key)
            else:
                result = await asyncio.to_thread(transcribe_wav_bytes, wav_bytes)

        raw_text = str(result.get("text") or "").strip()
        if raw_text:
            result["raw_text"] = raw_text
            result["text"] = await polish_asr_transcript(raw_text)
        return result
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"音频解析或识别失败：{exc}") from exc


@router.get("/wakeword/status")
def wakeword_status():
    """查询纯本地离线语音唤醒（sherpa-onnx KWS）状态与自定义唤醒词"""
    return wakeword_engine.get_status()


@router.post("/wakeword/toggle")
async def toggle_wakeword(payload: WakewordToggleRequest):
    """开启/关闭本地离线语音唤醒并保存自定义唤醒词"""
    loop = asyncio.get_running_loop()
    return wakeword_engine.toggle(
        enabled=payload.enabled,
        keyword=payload.keyword,
        loop=loop,
    )


@router.post("/wakeword/simulate")
async def simulate_wakeword():
    """模拟命中唤醒词（通过 WebSocket 推送 wakeword_detected，用于端到端联调验收）"""
    status = wakeword_engine.get_status()
    return await wakeword_engine.broadcast_wakeup(
        keyword=status["keyword"],
        simulated=True,
    )
