"""
本地离线语音识别服务（优先阿里 SenseVoiceSmall / sherpa-onnx，兼容 Faster-Whisper 与 Fish Audio ASR）
------------------------------------------------------------------------------------------------
优先级顺序：
1. 本地离线 sherpa-onnx（若 data/models/asr 下已放置阿里 SenseVoiceSmall / Paraformer 模型，CPU 极速推理）
2. 本地离线 Faster-Whisper（small 模型，零 API 费用、自动检测 CUDA / CPU int8）
3. Fish Audio 云端 ASR（若已配置 Fish Audio API Key，作为免下载兜底）
"""

import io
import json
import os
import re
import struct
import tempfile
import threading
import wave
from pathlib import Path
from typing import Any

import aiohttp

from app.database import DATA_DIR, db_cursor

# 离线模型存放目录
ASR_MODEL_DIR = DATA_DIR / "models" / "asr"
WHISPER_CACHE_DIR = DATA_DIR / "models" / "faster-whisper"
DEFAULT_WHISPER_MODEL = "small"

# Fish Audio 云端语音识别地址
FISH_ASR_URL = "https://api.fish.audio/v1/asr"

# 清洗 ASR 返回中的说话人标记与环境音标签（如 <|speaker:0|>、[噪音]、[背景音]）
_SPEAKER_TAG_RE = re.compile(r"<\|[^|>]+\|>")
_BRACKET_NOISE_RE = re.compile(
    r"\[(?:噪音|噪声|背景音|静音|空白|音乐|掌声|咳嗽|笑声|叹气|停顿|喘息|杂音|noise|silence|music|applause|laughter|cough)\]",
    re.IGNORECASE,
)
# 常见 Whisper 静音幻觉片段（避免环境白噪声误触发对话，覆盖中英文常见片尾词，不误伤正常对话）
_HALLUCINATION_RE = re.compile(
    r"^(?:请不吝点赞.*|点赞订阅.*|订阅.*频道.*|字幕由.*|中文字幕.*|感谢收看.*|谢谢观看.*|谢谢大家收看.*|Amara\.org.*|MBC.*|以下是普通话或台湾腔.*|Thank you for watching[.!]?|Thanks for watching[.!]?|Please subscribe[.!]?|Subtitles by .*)$",
    re.IGNORECASE,
)
_PURE_PUNCT_RE = re.compile(r"^[\s。，、！？!?.,…～~·—\-_\"'“”‘’()（）]+$")

_whisper_model_cache: Any = None
_whisper_device_used: str = "cpu"
_whisper_load_lock = threading.Lock()
_recognizer_cache: Any = None
_recognizer_checked = False
_recognizer_model_label: str = "sherpa-onnx"
_recognizer_load_lock = threading.Lock()


# 常见中文同音错字热词纠偏表（针对纯声学 CTC 模型易误听的称呼与高频词，零延迟纠偏）
_DEFAULT_HOMOPHONE_FIXES: tuple[tuple[re.Pattern[str], str], ...] = (
    # 「灵儿」高频同音误识别
    (re.compile(r"(?:铃|凌|菱|玲|零|聆|绫)儿|灵二"), "灵儿"),
)


def _load_bot_and_wakeword_names() -> tuple[str, str]:
    """读取当前配置的机器人名字与自定义唤醒词（供热词纠偏与智能整理参考）"""
    bot_name = "灵儿"
    wakeword = "灵儿"
    try:
        with db_cursor() as cur:
            cur.execute("SELECT key, value FROM settings WHERE key IN ('bot_name', 'wakeword');")
            for row in cur.fetchall():
                if row["key"] == "bot_name":
                    val = str(json.loads(row["value"]) or "").strip()
                    if val:
                        bot_name = val
                elif row["key"] == "wakeword":
                    cfg = json.loads(row["value"])
                    if isinstance(cfg, dict) and str(cfg.get("keyword") or "").strip():
                        wakeword = str(cfg["keyword"]).strip()
    except Exception:
        pass
    return bot_name, wakeword


def _apply_hotword_corrections(text: str) -> str:
    """对本地声学模型输出做零延迟同音热词纠偏"""
    if not text:
        return ""
    result = text
    bot_name, _wakeword = _load_bot_and_wakeword_names()
    if bot_name == "灵儿":
        for pattern, replacement in _DEFAULT_HOMOPHONE_FIXES:
            result = pattern.sub(replacement, result)
    return result


def _clean_asr_text(raw: str) -> str:
    """去除 ASR 结果中的 <|speaker:0|>、[噪音] 等标注标记，过滤明显的静音幻觉，并执行同音热词纠偏"""
    cleaned = _SPEAKER_TAG_RE.sub("", raw or "")
    cleaned = _BRACKET_NOISE_RE.sub("", cleaned)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    if not cleaned or _PURE_PUNCT_RE.fullmatch(cleaned) or _HALLUCINATION_RE.fullmatch(cleaned):
        return ""
    return _apply_hotword_corrections(cleaned)


def warmup_stt_engine() -> dict[str, Any]:
    """在语音通话建立瞬间预热本地离线 STT 模型，消除第一轮对话的冷启动加载延迟"""
    status = get_stt_status()
    if status.get("engine") == "faster-whisper" and status.get("ready"):
        _get_whisper_model()
        return {**status, "device": _whisper_device_used, "warmed": True}
    if status.get("engine") == "sherpa-onnx" and status.get("ready"):
        _get_recognizer()
        return {**status, "warmed": True}
    return {**status, "warmed": False}


def _has_faster_whisper_pkg() -> bool:
    try:
        import faster_whisper  # noqa: F401

        return True
    except ImportError:
        return False


def _find_asr_model_files() -> dict[str, Path] | None:
    """在 data/models/asr 下探测可用的 sherpa-onnx 中文识别模型文件"""
    if not ASR_MODEL_DIR.exists():
        return None

    tokens_files = list(ASR_MODEL_DIR.rglob("tokens.txt"))
    if not tokens_files:
        return None

    for tokens_path in tokens_files:
        folder = tokens_path.parent
        for model_name in ("model.int8.onnx", "model.onnx"):
            model_path = folder / model_name
            if model_path.exists():
                return {"model": model_path, "tokens": tokens_path, "dir": folder}
    return None


def get_fish_asr_api_key() -> str:
    """从本地 settings.tts 中读取已配置的 Fish Audio API Key（供云端 ASR 兜底复用）"""
    try:
        with db_cursor() as cur:
            cur.execute("SELECT value FROM settings WHERE key = 'tts';")
            row = cur.fetchone()
        if row:
            tts_cfg = json.loads(row["value"])
            return str(tts_cfg.get("fish_api_key", "")).strip()
    except Exception:
        return ""
    return ""


def _has_sherpa_onnx_pkg() -> bool:
    try:
        import sherpa_onnx  # noqa: F401

        return True
    except ImportError:
        return False


def _detect_sherpa_model_label(model_dir: Path) -> str:
    dir_name = model_dir.name.lower()
    if "sense-voice" in dir_name or "sensevoice" in dir_name:
        return "阿里 SenseVoiceSmall"
    if "paraformer" in dir_name:
        return "阿里 Paraformer"
    return model_dir.name


def get_stt_status() -> dict[str, Any]:
    """查询当前语音识别引擎可用状态（优先本地 sherpa-onnx SenseVoiceSmall，其次 Faster-Whisper，最后 Fish Audio）"""
    model_files = _find_asr_model_files()
    if _has_sherpa_onnx_pkg() and model_files is not None:
        model_label = _detect_sherpa_model_label(model_files["dir"])
        return {
            "ready": True,
            "engine": "sherpa-onnx",
            "model_name": model_label,
            "model_dir": str(model_files["dir"]),
            "message": f"本地离线 {model_label}（sherpa-onnx）已就绪，完全离线高速识别",
        }

    if _has_faster_whisper_pkg():
        return {
            "ready": True,
            "engine": "faster-whisper",
            "model_name": f"faster-whisper-{DEFAULT_WHISPER_MODEL}",
            "model_dir": str(WHISPER_CACHE_DIR),
            "message": f"本地离线 Faster-Whisper（{DEFAULT_WHISPER_MODEL}）已就绪，完全离线免费",
        }

    fish_key = get_fish_asr_api_key()
    if fish_key:
        return {
            "ready": True,
            "engine": "fish-audio",
            "model_dir": str(ASR_MODEL_DIR),
            "message": "已启用 Fish Audio 云端语音识别（复用当前 API Key）",
        }

    return {
        "ready": False,
        "engine": "sherpa-onnx",
        "model_dir": str(ASR_MODEL_DIR),
        "message": "离线语音识别尚未安装，请放置 SenseVoiceSmall 模型或安装 faster-whisper。",
        "setup_hints": [
            "安装依赖：pip install sherpa-onnx",
            f"放置 SenseVoiceSmall 模型至：{ASR_MODEL_DIR}",
        ],
    }


def _is_cuda_runtime_available() -> bool:
    """
    检测当前进程能否实际加载 CUDA 12 运行时（cublas64_12.dll）。
    Windows 下仅有 NVIDIA 驱动但未装 CUDA Toolkit / nvidia-cublas-cu12 时，
    WhisperModel(device='cuda') 初始化不会报错，但真正推理会因缺少 cublas64_12.dll 崩溃。
    """
    if os.name != "nt":
        return True

    import ctypes
    import sys

    # 若 .venv 中通过 pip 安装了 nvidia-cublas-cu12 / nvidia-cudnn-cu12，自动把 bin 加入 DLL 搜索路径
    site_nvidia = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    if site_nvidia.exists():
        for sub in ("cublas", "cudnn", "cuda_runtime"):
            bin_dir = site_nvidia / sub / "bin"
            if bin_dir.is_dir():
                try:
                    os.add_dll_directory(str(bin_dir))
                except Exception:
                    pass
                os.environ["PATH"] = f"{bin_dir};{os.environ.get('PATH', '')}"

    try:
        ctypes.WinDLL("cublas64_12.dll")
        return True
    except OSError:
        return False


def _create_whisper_model(device: str, compute_type: str):
    """优先纯离线加载本地已缓存模型（零网络检查延迟），未缓存时再联网拉取"""
    from faster_whisper import WhisperModel

    WHISPER_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if not os.environ.get("HF_ENDPOINT"):
        os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

    common_kwargs: dict[str, Any] = {
        "device": device,
        "compute_type": compute_type,
        "download_root": str(WHISPER_CACHE_DIR),
    }
    if device == "cpu":
        common_kwargs["cpu_threads"] = max(2, (os.cpu_count() or 4) // 2)

    try:
        return WhisperModel(DEFAULT_WHISPER_MODEL, local_files_only=True, **common_kwargs)
    except Exception:
        return WhisperModel(DEFAULT_WHISPER_MODEL, local_files_only=False, **common_kwargs)


def _load_cpu_whisper_model():
    """加载并缓存 CPU int8 模式的 Faster-Whisper small 模型（稳定、低延迟）"""
    global _whisper_model_cache, _whisper_device_used
    _whisper_model_cache = _create_whisper_model(device="cpu", compute_type="int8")
    _whisper_device_used = "cpu"
    return _whisper_model_cache


def _get_whisper_model():
    """懒加载并缓存本地 Faster-Whisper small 模型（线程安全双重检查，防止预热与首轮请求并发重复加载）"""
    global _whisper_model_cache, _whisper_device_used
    if _whisper_model_cache is not None:
        return _whisper_model_cache

    with _whisper_load_lock:
        if _whisper_model_cache is not None:
            return _whisper_model_cache

        if _is_cuda_runtime_available():
            try:
                _whisper_model_cache = _create_whisper_model(device="cuda", compute_type="float16")
                _whisper_device_used = "cuda"
                return _whisper_model_cache
            except Exception:
                pass

        return _load_cpu_whisper_model()


def transcribe_with_faster_whisper(
    wav_bytes: bytes,
    *,
    fast_mode: bool = False,
) -> dict[str, Any]:
    """
    使用本地离线 Faster-Whisper 将 16kHz WAV 音频直接解码为 numpy float32 数组并转写。
    直接传入 numpy 数组可彻底绕开新版 PyAV (av>=16) 与 faster-whisper 的 metadata_errors 兼容问题，
    且音频全程不落盘、延迟更低。若 CUDA 运行时缺库，自动无缝回退 CPU int8 重试。
    当 fast_mode=True（实时语音通话模式）时，使用 greedy 解码（beam_size=1）与无时间戳极速参数大幅压低延迟。
    """
    import numpy as np

    model = _get_whisper_model()
    sample_rate, samples = _decode_pcm_wav(wav_bytes)
    audio_np = np.asarray(samples, dtype=np.float32)

    # 若采样率不是 16000Hz，做一次轻量线性重采样对齐 Whisper 要求的 16kHz
    if sample_rate != 16000 and audio_np.size > 1:
        target_len = max(1, int(round(audio_np.size * 16000.0 / sample_rate)))
        old_idx = np.linspace(0.0, audio_np.size - 1, num=audio_np.size)
        new_idx = np.linspace(0.0, audio_np.size - 1, num=target_len)
        audio_np = np.interp(new_idx, old_idx, audio_np).astype(np.float32)

    def _run_transcribe(target_model, force_lang: str | None = None):
        # 默认不写死 language="zh"、不注入纯中文 initial_prompt，避免英文语音被强行翻译成中文；
        # 显式指定 task="transcribe" 保证说英文保留英文原文、说中文保留中文原文。
        kwargs: dict[str, Any] = {
            "language": force_lang,
            "task": "transcribe",
            "beam_size": 1 if fast_mode else 5,
            "vad_filter": True,
            "condition_on_previous_text": not fast_mode,
        }
        if force_lang == "zh":
            kwargs["initial_prompt"] = "普通话或台湾腔日常对话，灵儿。"
        if fast_mode:
            kwargs["best_of"] = 1
            kwargs["without_timestamps"] = True
            kwargs["vad_parameters"] = {
                "min_silence_duration_ms": 300,
                "speech_pad_ms": 150,
            }
        segments, info = target_model.transcribe(audio_np, **kwargs)
        raw_text = "".join(seg.text for seg in segments)
        return raw_text, info

    try:
        raw_text, info = _run_transcribe(model)
    except RuntimeError as exc:
        err_lower = str(exc).lower()
        if _whisper_device_used == "cuda" and any(
            k in err_lower for k in ("cublas", "cudnn", "cuda", "dll")
        ):
            model = _load_cpu_whisper_model()
            raw_text, info = _run_transcribe(model)
        else:
            raise

    # 仅在极短语音被误判为非中/非英小语种（如挪威语/日语/粤语）且置信度不高时，
    # 按已算出的中英概率择优重跑一次，既不拖慢正常中英文，又防止短句乱码
    detected_lang = str(getattr(info, "language", "") or "")
    lang_prob = float(getattr(info, "language_probability", 0.0) or 0.0)
    if detected_lang and detected_lang not in ("zh", "en") and lang_prob < 0.8:
        all_probs = dict(getattr(info, "all_language_probs", None) or [])
        preferred = "en" if all_probs.get("en", 0.0) > all_probs.get("zh", 0.0) else "zh"
        raw_text, info = _run_transcribe(model, force_lang=preferred)
        detected_lang = preferred

    text = _clean_asr_text(raw_text)
    duration = round(float(getattr(info, "duration", 0.0) or (audio_np.size / 16000.0)), 2)
    return {
        "text": text,
        "language": detected_lang or "auto",
        "engine": f"faster-whisper ({_whisper_device_used})",
        "duration_sec": duration,
    }


def _get_recognizer():
    """懒加载并缓存 sherpa-onnx OfflineRecognizer 实例（线程安全双重检查，优先 SenseVoiceSmall）"""
    global _recognizer_cache, _recognizer_checked, _recognizer_model_label
    if _recognizer_checked:
        return _recognizer_cache

    with _recognizer_load_lock:
        if _recognizer_checked:
            return _recognizer_cache

        _recognizer_checked = True
        try:
            import sherpa_onnx
        except ImportError:
            return None

        model_files = _find_asr_model_files()
        if not model_files:
            return None

        model_path = str(model_files["model"])
        tokens_path = str(model_files["tokens"])
        num_threads = max(2, min(4, (os.cpu_count() or 4) // 2))
        _recognizer_model_label = _detect_sherpa_model_label(model_files["dir"])

        dir_name = model_files["dir"].name.lower()
        if "sense-voice" in dir_name or "sensevoice" in dir_name:
            # 固定 language="zh" 可显著减少中文短句被误判成粤语/日语/韩语的概率，同时仍兼容中英混说
            _recognizer_cache = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=model_path,
                tokens=tokens_path,
                num_threads=num_threads,
                use_itn=True,
                language="zh",
                provider="cpu",
            )
        else:
            _recognizer_cache = sherpa_onnx.OfflineRecognizer.from_paraformer(
                paraformer=model_path,
                tokens=tokens_path,
                num_threads=num_threads,
                provider="cpu",
            )
        return _recognizer_cache


def _decode_pcm_wav(wav_bytes: bytes) -> tuple[int, list[float]]:
    """纯标准库解码 16-bit PCM WAV 字节流为 [-1.0, 1.0] 浮点采样数组"""
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        channels = wf.getnchannels()
        sample_width = wf.getsampwidth()
        sample_rate = wf.getframerate()
        frame_count = wf.getnframes()
        raw_frames = wf.readframes(frame_count)

    if sample_width != 2:
        raise ValueError("仅支持 16-bit PCM WAV 音频格式")

    total_samples = len(raw_frames) // 2
    int_samples = struct.unpack(f"<{total_samples}h", raw_frames)

    if channels > 1:
        mono = [int_samples[i] / 32768.0 for i in range(0, total_samples, channels)]
    else:
        mono = [s / 32768.0 for s in int_samples]

    return sample_rate, mono


def _split_long_audio_at_silence(
    samples: list[float],
    sample_rate: int,
    max_chunk_sec: float = 24.0,
    min_chunk_sec: float = 14.0,
) -> list[list[float]]:
    """
    将超长语音（如 1~3 分钟）按自然静音停顿谷底智能切分为 <=24 秒的片段。
    原因：SenseVoiceSmall 编码器针对 <=30 秒片段最优；按静音谷底切分既不会截断字词，
    还能跳过用户长时间思考的纯静音段，保证 3 分钟大段口述依然高精度、低延迟。
    """
    if sample_rate <= 0:
        return [samples]

    max_len = int(max_chunk_sec * sample_rate)
    if len(samples) <= max_len:
        return [samples]

    min_len = int(min_chunk_sec * sample_rate)
    win_len = max(1, int(0.15 * sample_rate))  # 150ms 能量检测窗
    step = max(1, int(0.05 * sample_rate))     # 50ms 步进
    silence_rms_threshold = 0.004

    chunks: list[list[float]] = []
    start = 0
    total = len(samples)

    while start < total:
        remaining = total - start
        if remaining <= max_len:
            segment = samples[start:total]
            start = total
        else:
            search_lo = start + min_len
            search_hi = min(total - win_len, start + max_len)
            best_pos = start + max_len
            best_energy = float("inf")

            pos = search_lo
            while pos <= search_hi:
                window = samples[pos : pos + win_len]
                energy = sum(v * v for v in window) / len(window)
                if energy < best_energy:
                    best_energy = energy
                    best_pos = pos + win_len // 2
                pos += step

            segment = samples[start:best_pos]
            start = best_pos

        if segment:
            seg_rms = (sum(v * v for v in segment) / len(segment)) ** 0.5
            if seg_rms >= silence_rms_threshold:
                chunks.append(segment)

    return chunks


def transcribe_wav_bytes(wav_bytes: bytes, *, fast_mode: bool = False) -> dict[str, Any]:
    """执行本地离线语音转文字（优先阿里 SenseVoiceSmall / sherpa-onnx，支持最长 3 分钟自动分段，其次 Faster-Whisper）"""
    recognizer = _get_recognizer()
    if recognizer is not None:
        sample_rate, samples = _decode_pcm_wav(wav_bytes)
        audio_chunks = _split_long_audio_at_silence(samples, sample_rate)
        parts: list[str] = []
        detected_lang = "zh"

        for chunk in audio_chunks:
            stream = recognizer.create_stream()
            stream.accept_waveform(sample_rate, chunk)
            recognizer.decode_stream(stream)
            piece = _clean_asr_text(stream.result.text or "")
            if piece:
                parts.append(piece)
            lang = str(getattr(stream.result, "lang", "") or "").strip("<|>")
            if lang:
                detected_lang = lang

        text = _apply_hotword_corrections("".join(parts))
        return {
            "text": text,
            "language": detected_lang,
            "engine": f"sherpa-onnx ({_recognizer_model_label})",
            "sample_rate": sample_rate,
            "duration_sec": round(len(samples) / max(sample_rate, 1), 2),
        }

    if _has_faster_whisper_pkg():
        return transcribe_with_faster_whisper(wav_bytes, fast_mode=fast_mode)

    status = get_stt_status()
    raise RuntimeError(
        status["message"]
        + (" " + "；".join(status.get("setup_hints", [])) if status.get("setup_hints") else "")
    )


async def transcribe_with_fish_audio(wav_bytes: bytes, api_key: str) -> dict[str, Any]:
    """使用 Fish Audio /v1/asr 接口将 WAV 录音识别为中文文本"""
    form = aiohttp.FormData()
    form.add_field(
        "audio",
        wav_bytes,
        filename="speech.wav",
        content_type="audio/wav",
    )
    # 不写死 language="zh"，支持自动识别中文与英文原文输出
    form.add_field("ignore_timestamps", "true")

    headers = {
        "Authorization": f"Bearer {api_key.strip()}",
        "model": "transcribe-1-pro",
    }

    timeout = aiohttp.ClientTimeout(total=30, connect=10)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(FISH_ASR_URL, headers=headers, data=form) as resp:
            if resp.status >= 400:
                detail = (await resp.text())[:240].strip()
                raise RuntimeError(f"Fish Audio 语音识别失败（HTTP {resp.status}）：{detail}")
            data = await resp.json()

    text = _clean_asr_text(str(data.get("text", "")))
    return {
        "text": text,
        "engine": "fish-audio",
        "duration_sec": float(data.get("duration", 0.0) or 0.0),
    }


async def polish_asr_transcript(raw_text: str) -> str:
    """
    语音转文字智能纠错与口语整理（类豆包输入法后处理）：
    1. 结合当前对话助手名字（如「灵儿」）与唤醒词，自动修正声学模型的同音错别字。
    2. 去除明显口吃/无意义口头禅（如重复的「呃、那个、就是啊」）并补全自然标点，使语句通顺。
    3. 严格保留用户原意与语气，绝不回答问题、绝不添加用户没说过的内容。
    4. 内置 3.5 秒超时与安全兜底：若未配置 LLM 或超时/异常，无损返回原文本。
    """
    text = (raw_text or "").strip()
    # 极短 1~2 字（如「好」「嗯」）无需走大模型整理，直接秒回
    if len(text) <= 2:
        return text

    try:
        import asyncio
        from app.services.agent_brain import (
            _FAST_THINK_MODE_CACHE,
            _get_async_openai_client,
            _load_settings_dict,
        )

        settings = _load_settings_dict()
        llm_cfg = settings.get("llm") or {}
        api_key = str(llm_cfg.get("api_key") or "").strip()
        base_url = str(llm_cfg.get("base_url") or "").strip()
        model = str(llm_cfg.get("model") or "").strip()
        if not api_key or not base_url or not model:
            return text

        bot_name, wakeword = _load_bot_and_wakeword_names()
        hotwords = sorted({bot_name, wakeword, "灵儿", "TaiwanBot"})
        system_prompt = (
            "你是一个专业的中文语音转文字（ASR）纠错与口语整理器。"
            f"常用专有名词参考：{'、'.join(hotwords)}。\n"
            "任务要求：\n"
            "1. 纠正语音识别产生的同音错别字（尤其是把「小易/小意/小一/晓艺」等按语境纠正为「"
            f"{bot_name}」）。\n"
            "2. 轻微去除卡壳重复和多余口头禅（如连续的「呃、那个、就是啊」），补全准确标点，让句子自然通顺。\n"
            "3. 严禁改变用户原意，严禁回答用户的问题，严禁添加任何解释或前缀。\n"
            "4. 直接输出整理后的纯文本结果。"
        )

        client = _get_async_openai_client(api_key=api_key, base_url=base_url)
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": text},
            ],
            "temperature": 0.1,
            "max_tokens": max(160, min(2048, len(text) * 2 + 80)),
        }

        think_mode = _FAST_THINK_MODE_CACHE.get((base_url, model))
        if think_mode == "disabled":
            kwargs["extra_body"] = {"thinking": {"type": "disabled"}}
        elif think_mode == "effort_minimal":
            kwargs["reasoning_effort"] = "minimal"
        elif think_mode == "effort_low":
            kwargs["reasoning_effort"] = "low"

        # 短句保持 4 秒极速超时；1~3 分钟长段口述自动放宽到最多 12 秒，避免长文整理被截断
        timeout_sec = min(12.0, 4.0 + len(text) / 100.0)
        resp = await asyncio.wait_for(
            client.chat.completions.create(**kwargs),
            timeout=timeout_sec,
        )
        polished = (resp.choices[0].message.content or "").strip()
        # 防止异常输出把整句话删光或胡乱扩写过长
        if not polished or len(polished) > max(len(text) * 2 + 20, 60):
            return text
        return _apply_hotword_corrections(polished)
    except Exception:
        return text
