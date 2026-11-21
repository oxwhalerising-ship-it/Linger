"""
本地离线语音识别。
通话和按住说话只用 sherpa-onnx SenseVoice Small。
云端 Fish Audio 不再走听写热路径。Fish 仍只作为可选的语音合成。
"""

import asyncio
import io
import os
import re
import threading
import wave
from pathlib import Path
from typing import Any

import numpy as np

from app.core.settings_store import get_all_settings, get_setting
from app.database import DATA_DIR
from app.services.llm.client import (
    get_async_openai_client,
    get_cached_fast_think_mode,
)

# 离线模型存放目录
ASR_MODEL_DIR = DATA_DIR / "models" / "asr"

# 清洗 ASR 返回中的说话人标记与环境音标签（如 <|speaker:0|>、[噪音]、[背景音]）
_SPEAKER_TAG_RE = re.compile(r"<\|[^|>]+\|>")
_BRACKET_NOISE_RE = re.compile(
    r"\[(?:噪音|噪声|背景音|静音|空白|音乐|掌声|咳嗽|笑声|叹气|停顿|喘息|杂音|noise|silence|music|applause|laughter|cough)\]",
    re.IGNORECASE,
)
# 常见静音幻觉片段（避免环境白噪声误触发对话，覆盖中英文常见片尾词，不误伤正常对话）
_HALLUCINATION_RE = re.compile(
    r"^(?:请不吝点赞.*|点赞订阅.*|订阅.*频道.*|字幕由.*|中文字幕.*|感谢收看.*|谢谢观看.*|谢谢大家收看.*|Amara\.org.*|MBC.*|以下是普通话或台湾腔.*|Thank you for watching[.!]?|Thanks for watching[.!]?|Please subscribe[.!]?|Subtitles by .*)$",
    re.IGNORECASE,
)
_PURE_PUNCT_RE = re.compile(r"^[\s。，、！？!?.,…～~·—\-_\"'“”‘’()（）]+$")

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
    """从内存配置缓存读取机器人名字与自定义唤醒词（零 SQLite 开销）"""
    bot_name = str(get_setting("bot_name", "灵儿") or "灵儿").strip() or "灵儿"
    ww_cfg = get_setting("wakeword", {})
    wakeword = (
        str(ww_cfg.get("keyword") or "").strip()
        if isinstance(ww_cfg, dict)
        else ""
    ) or bot_name
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
    """在语音通话建立瞬间预热 SenseVoice Small，消除第一轮对话的冷启动加载延迟"""
    status = get_stt_status()
    if status.get("engine") == "sherpa-onnx" and status.get("ready"):
        _get_recognizer()
        return {**status, "warmed": True}
    return {**status, "warmed": False}


def _is_sensevoice_dir(model_dir: Path) -> bool:
    dir_name = model_dir.name.lower()
    return "sense-voice" in dir_name or "sensevoice" in dir_name


def _find_asr_model_files() -> dict[str, Path] | None:
    """在 data/models/asr 下探测 sherpa-onnx 模型，优先 SenseVoice Small 的 int8 权重。"""
    if not ASR_MODEL_DIR.exists():
        return None

    candidates: list[dict[str, Path]] = []
    for tokens_path in ASR_MODEL_DIR.rglob("tokens.txt"):
        folder = tokens_path.parent
        for model_name in ("model.int8.onnx", "model.onnx"):
            model_path = folder / model_name
            if model_path.exists():
                candidates.append({"model": model_path, "tokens": tokens_path, "dir": folder})
                break
    if not candidates:
        return None

    def _rank(item: dict[str, Path]) -> tuple[int, int]:
        sensevoice = 0 if _is_sensevoice_dir(item["dir"]) else 1
        int8 = 0 if item["model"].name == "model.int8.onnx" else 1
        return sensevoice, int8

    candidates.sort(key=_rank)
    return candidates[0]


def _has_sherpa_onnx_pkg() -> bool:
    try:
        import sherpa_onnx  # noqa: F401

        return True
    except ImportError:
        return False


def _detect_sherpa_model_label(model_dir: Path) -> str:
    if _is_sensevoice_dir(model_dir):
        return "阿里 SenseVoice Small"
    dir_name = model_dir.name.lower()
    if "paraformer" in dir_name:
        return "阿里 Paraformer"
    return model_dir.name


def choose_stt_engine(*, sherpa_ready: bool) -> str:
    """听写只有 SenseVoice Small。模型或 sherpa-onnx 没就绪时就是没有引擎。"""
    if sherpa_ready:
        return "sherpa-onnx"
    return "none"


def get_stt_status() -> dict[str, Any]:
    """查询当前听写引擎。顺序与 transcribe_wav_bytes 一致。"""
    model_files = _find_asr_model_files()
    sherpa_ready = _has_sherpa_onnx_pkg() and model_files is not None
    engine = choose_stt_engine(sherpa_ready=sherpa_ready)
    if engine == "sherpa-onnx" and model_files is not None:
        model_label = _detect_sherpa_model_label(model_files["dir"])
        return {
            "ready": True,
            "engine": "sherpa-onnx",
            "model_name": model_label,
            "model_dir": str(model_files["dir"]),
            "message": f"通话使用本地 {model_label}",
        }
    return {
        "ready": False,
        "engine": "sherpa-onnx",
        "model_dir": str(ASR_MODEL_DIR),
        "message": "SenseVoice Small 还没就绪。",
        "setup_hints": [
            "pip install sherpa-onnx",
            f"把 SenseVoice Small 模型放到：{ASR_MODEL_DIR}",
        ],
    }


def _get_recognizer():
    """懒加载并缓存 sherpa-onnx OfflineRecognizer 实例（线程安全双重检查，优先 SenseVoiceSmall）"""
    global _recognizer_cache, _recognizer_checked, _recognizer_model_label
    if _recognizer_checked and _recognizer_cache is not None:
        return _recognizer_cache

    with _recognizer_load_lock:
        if _recognizer_checked and _recognizer_cache is not None:
            return _recognizer_cache

        try:
            import sherpa_onnx
        except ImportError:
            return None

        model_files = _find_asr_model_files()
        if not model_files:
            return None

        _recognizer_checked = True

        model_path = str(model_files["model"])
        tokens_path = str(model_files["tokens"])
        num_threads = max(2, min(4, (os.cpu_count() or 4) // 2))
        _recognizer_model_label = _detect_sherpa_model_label(model_files["dir"])

        if _is_sensevoice_dir(model_files["dir"]):
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


def _decode_pcm_wav(wav_bytes: bytes) -> tuple[int, np.ndarray]:
    """NumPy 向量化解码 16-bit PCM WAV 字节流为 [-1.0, 1.0] float32 单声道采样数组（比纯 Python 循环快 ~50x）"""
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        channels = wf.getnchannels()
        sample_width = wf.getsampwidth()
        sample_rate = wf.getframerate()
        frame_count = wf.getnframes()
        raw_frames = wf.readframes(frame_count)

    if sample_width != 2:
        raise ValueError("仅支持 16-bit PCM WAV 音频格式")

    samples = np.frombuffer(raw_frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples[::channels]
    return sample_rate, samples


def _split_long_audio_at_silence(
    samples: np.ndarray,
    sample_rate: int,
    max_chunk_sec: float = 24.0,
    min_chunk_sec: float = 14.0,
) -> list[np.ndarray]:
    """
    NumPy 前缀和向量化静音谷底切分：将 1~3 分钟超长语音按自然静音谷底切分为 <=24 秒片段。
    """
    total = int(samples.size)
    if sample_rate <= 0 or total == 0:
        return [samples] if total > 0 else []

    max_len = int(max_chunk_sec * sample_rate)
    if total <= max_len:
        return [samples]

    min_len = int(min_chunk_sec * sample_rate)
    win_len = max(1, int(0.15 * sample_rate))  # 150ms 能量检测窗
    step = max(1, int(0.05 * sample_rate))     # 50ms 步进
    silence_rms_threshold = 0.004

    # 预计算平方和前缀数组，O(1) 计算任意窗口均方能量
    sq_cumsum = np.empty(total + 1, dtype=np.float64)
    sq_cumsum[0] = 0.0
    np.cumsum(samples.astype(np.float64) ** 2, out=sq_cumsum[1:])

    chunks: list[np.ndarray] = []
    start = 0

    while start < total:
        remaining = total - start
        if remaining <= max_len:
            end = total
        else:
            search_lo = start + min_len
            search_hi = min(total - win_len, start + max_len)
            if search_hi >= search_lo:
                positions = np.arange(search_lo, search_hi + 1, step)
                energies = (sq_cumsum[positions + win_len] - sq_cumsum[positions]) / win_len
                best_idx = int(np.argmin(energies))
                end = int(positions[best_idx]) + win_len // 2
            else:
                end = start + max_len

        seg_len = end - start
        if seg_len > 0:
            seg_rms = float(np.sqrt((sq_cumsum[end] - sq_cumsum[start]) / seg_len))
            if seg_rms >= silence_rms_threshold:
                chunks.append(samples[start:end])
        start = end

    return chunks


def _transcribe_with_sherpa(wav_bytes: bytes) -> dict[str, Any]:
    """SenseVoice Small / sherpa-onnx 离线转写。这是通话和按住说话的默认路径。"""
    recognizer = _get_recognizer()
    if recognizer is None:
        raise RuntimeError("SenseVoice 模型还没就绪")
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


def transcribe_wav_bytes(wav_bytes: bytes) -> dict[str, Any]:
    """本地听写。只走 SenseVoice Small。"""
    try:
        if _get_recognizer() is None:
            status = get_stt_status()
            hints = status.get("setup_hints") or []
            extra = f" {'；'.join(hints)}" if hints else ""
            raise RuntimeError(str(status["message"]) + extra)
        return _transcribe_with_sherpa(wav_bytes)
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"SenseVoice 听写失败：{exc}") from exc


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
        settings = get_all_settings()
        llm_cfg = settings.get("llm") or {}
        api_key = str(llm_cfg.get("api_key") or "").strip()
        base_url = str(llm_cfg.get("base_url") or "").strip()
        model = str(llm_cfg.get("model") or "").strip()
        if not api_key or not base_url or not model:
            return text

        bot_name, wakeword = _load_bot_and_wakeword_names()
        hotwords = sorted({bot_name, wakeword, "灵儿"})
        system_prompt = (
            "你是一个专业的中文语音转文字（ASR）纠错与口语整理器。"
            f"常用专有名词参考：{'、'.join(hotwords)}。\n"
            "任务要求：\n"
            f"1. 纠正语音识别产生的同音错别字（尤其是把与「{bot_name}」发音相近的误识别词按语境纠正为「{bot_name}」）。\n"
            "2. 轻微去除卡壳重复和多余口头禅（如连续的「呃、那个、就是啊」），补全准确标点，让句子自然通顺。\n"
            "3. 严禁改变用户原意，严禁回答用户的问题，严禁添加任何解释或前缀。\n"
            "4. 直接输出整理后的纯文本结果。"
        )

        client = get_async_openai_client(api_key=api_key, base_url=base_url)
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": text},
            ],
            "temperature": 0.1,
            "max_tokens": max(160, min(2048, len(text) * 2 + 80)),
        }

        think_mode = get_cached_fast_think_mode(base_url, model)
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
