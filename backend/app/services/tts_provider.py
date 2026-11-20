"""
可插拔台湾腔语音合成引擎（TTSProvider 抽象层）
---------------------------------------------
设计思路：
1. 定义统一抽象基类 BaseTTSProvider，内置：
   - EdgeTTSProvider（微软免费台湾腔神经语音）
   - FishAudioTTSProvider（Fish Audio 高情感自定义/收藏音色 API）
2. 内置「流式分句切分器」与「本地 0.3 秒台湾腔反应垫词缓存」，
   按当前引擎与音色分别缓存，大幅降低语音等待冷场感，提升活人感。
"""

import abc
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any, AsyncIterator

import aiohttp
import edge_tts

from app.database import DATA_DIR, ensure_data_dirs

# 本地反应垫词音频缓存目录（提前生成并缓存，点击说话结束 0.3 秒内即可秒播）
FILLER_CACHE_DIR = DATA_DIR / "audio_cache" / "fillers"
# 通用 TTS 分句本地磁盘缓存目录（重播与重复语句零网络延迟秒播、零重复扣费）
TTS_CACHE_DIR = DATA_DIR / "audio_cache" / "tts"
TTS_CACHE_MAX_FILES = 300

# 地道台湾腔超短反应垫词列表（用于消除 LLM 生成期间的等待死寂）
TAIWAN_FILLERS: dict[str, str] = {
    "uhhuh": "嗯嗯～",
    "really": "喔真的假的！",
    "let_me_see": "欸等我想一下吼～",
    "got_it": "懂你懂你～",
    "oh_nice": "哇塞听起来很可以耶！",
}

# 推荐的免费微软台湾腔神经音色
RECOMMENDED_TW_VOICES = [
    {"id": "zh-TW-HsiaoChenNeural", "name": "晓臻（甜美俏皮台湾女声，默认推荐）"},
    {"id": "zh-TW-HsiaoYuNeural", "name": "晓雨（温柔治愈台湾女声）"},
    {"id": "zh-TW-YunJheNeural", "name": "云哲（温和阳光台湾男声）"},
]

# Fish Audio 常用语音模型列表
FISH_AUDIO_MODELS = [
    {"id": "s2.1-pro", "name": "s2.1-pro（主力推荐 · 高情感低延迟）"},
    {"id": "s2.1-pro-free", "name": "s2.1-pro-free（免费体验档 · 公平限额）"},
    {"id": "s2-pro", "name": "s2-pro（标准情感模型）"},
]

# 分句正则：按中文/英文句末标点（含英文句点+空格，避开小数点）切分，方便前端拿到第一句就立刻合成并开始播放
SENTENCE_SPLIT_PATTERN = re.compile(r"(?:(?<=[。！？!?～~…\n])\s*|(?<!\d)(?<=\.)\s+)")


def split_sentences_for_streaming(text: str) -> list[str]:
    """
    将一段回复切分为适合流式逐句合成播放的短句列表。
    过短的孤立语气词会与相邻短句合并，避免音频停顿过于碎片化。
    """
    cleaned = text.strip()
    if not cleaned:
        return []

    raw_parts = [part.strip() for part in SENTENCE_SPLIT_PATTERN.split(cleaned) if part.strip()]
    merged: list[str] = []
    for part in raw_parts:
        # 过滤纯标点碎片
        if re.fullmatch(r"[。！？!?～~…、，,.\s]+", part):
            continue
        if merged and len(merged[-1]) < 6:
            joiner = " " if (merged[-1][-1].isascii() and part[0].isascii()) else ""
            merged[-1] = f"{merged[-1]}{joiner}{part}"
        else:
            merged.append(part)
    return merged or [cleaned]


class BaseTTSProvider(abc.ABC):
    """可插拔 TTS 引擎抽象基类"""

    @abc.abstractmethod
    async def synthesize_bytes(
        self,
        text: str,
        voice: str,
        rate: str = "+0%",
        pitch: str = "+0Hz",
    ) -> bytes:
        """将文本一次性合成为 MP3 字节流"""

    @abc.abstractmethod
    async def stream_chunks(
        self,
        text: str,
        voice: str,
        rate: str = "+0%",
        pitch: str = "+0Hz",
    ) -> AsyncIterator[bytes]:
        """流式产出音频分片，支持边合成边传输"""


class EdgeTTSProvider(BaseTTSProvider):
    """默认实现：微软免费 Edge-TTS（原生支持自然台湾腔 zh-TW 神经语音）"""

    async def synthesize_bytes(
        self,
        text: str,
        voice: str = "zh-TW-HsiaoChenNeural",
        rate: str = "+0%",
        pitch: str = "+0Hz",
    ) -> bytes:
        communicate = edge_tts.Communicate(text=text, voice=voice, rate=rate, pitch=pitch)
        chunks: list[bytes] = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
        return b"".join(chunks)

    async def stream_chunks(
        self,
        text: str,
        voice: str = "zh-TW-HsiaoChenNeural",
        rate: str = "+0%",
        pitch: str = "+0Hz",
    ) -> AsyncIterator[bytes]:
        communicate = edge_tts.Communicate(text=text, voice=voice, rate=rate, pitch=pitch)
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                yield chunk["data"]


class FishAudioTTSProvider(BaseTTSProvider):
    """Fish Audio 高情感 TTS 引擎（支持收藏/克隆音色 reference_id、连接池复用与流式 MP3 输出）"""

    API_URL = "https://api.fish.audio/v1/tts"
    _shared_session: aiohttp.ClientSession | None = None

    @classmethod
    async def _get_session(cls) -> aiohttp.ClientSession:
        if cls._shared_session is None or cls._shared_session.closed:
            connector = aiohttp.TCPConnector(limit=16, keepalive_timeout=60)
            timeout = aiohttp.ClientTimeout(total=30, connect=10)
            cls._shared_session = aiohttp.ClientSession(
                connector=connector,
                timeout=timeout,
            )
        return cls._shared_session

    @classmethod
    async def close_session(cls) -> None:
        if cls._shared_session is not None and not cls._shared_session.closed:
            await cls._shared_session.close()
        cls._shared_session = None

    def __init__(
        self,
        api_key: str,
        reference_id: str = "",
        model: str = "s2.1-pro",
    ) -> None:
        self.api_key = api_key.strip()
        self.reference_id = reference_id.strip()
        self.model = (model or "s2.1-pro").strip()

    @staticmethod
    def _parse_speed(rate: str) -> float:
        """将统一语速字符串（如 +20%、-10% 或 1.2）转换为 Fish Audio 的 speed 倍率（0.5~2.0）"""
        raw = (rate or "+0%").strip()
        try:
            if raw.endswith("%"):
                pct = float(raw[:-1])
                speed = 1.0 + pct / 100.0
            else:
                speed = float(raw)
        except ValueError:
            speed = 1.0
        return round(max(0.5, min(2.0, speed)), 2)

    def _build_request(self, text: str, rate: str = "+0%") -> tuple[dict[str, str], dict[str, Any]]:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "model": self.model,
            "Content-Type": "application/json",
        }
        speed = self._parse_speed(rate)
        body: dict[str, Any] = {
            "text": text,
            "format": "mp3",
            "latency": "balanced",
            "prosody": {
                "speed": speed,
                "volume": 0,
            },
        }
        if self.reference_id:
            body["reference_id"] = self.reference_id
        return headers, body

    async def synthesize_bytes(
        self,
        text: str,
        voice: str = "",
        rate: str = "+0%",
        pitch: str = "+0Hz",
    ) -> bytes:
        headers, body = self._build_request(text, rate)
        session = await self._get_session()
        async with session.post(self.API_URL, headers=headers, json=body) as resp:
            if resp.status >= 400:
                detail = (await resp.text())[:240].strip()
                raise RuntimeError(f"Fish Audio API 错误（HTTP {resp.status}）：{detail}")
            return await resp.read()

    async def stream_chunks(
        self,
        text: str,
        voice: str = "",
        rate: str = "+0%",
        pitch: str = "+0Hz",
    ) -> AsyncIterator[bytes]:
        headers, body = self._build_request(text, rate)
        session = await self._get_session()
        async with session.post(self.API_URL, headers=headers, json=body) as resp:
            if resp.status >= 400:
                detail = (await resp.text())[:240].strip()
                raise RuntimeError(f"Fish Audio API 错误（HTTP {resp.status}）：{detail}")
            async for chunk in resp.content.iter_chunked(4096):
                if chunk:
                    yield chunk


def get_tts_provider(tts_cfg: dict[str, Any] | str = "edge_tts") -> BaseTTSProvider:
    """
    TTS 引擎工厂函数
    支持传入配置字典或引擎名称字符串；Fish Audio 未填写 API Key 时安全降级回 Edge-TTS。
    """
    if isinstance(tts_cfg, str):
        return EdgeTTSProvider()

    provider_name = str(tts_cfg.get("provider", "edge_tts"))
    if provider_name == "fish_audio":
        api_key = str(tts_cfg.get("fish_api_key", "")).strip()
        if api_key:
            return FishAudioTTSProvider(
                api_key=api_key,
                reference_id=str(tts_cfg.get("fish_reference_id", "")).strip(),
                model=str(tts_cfg.get("fish_model", "s2.1-pro")).strip() or "s2.1-pro",
            )
    return EdgeTTSProvider()


async def get_or_create_filler_audio(
    filler_id: str,
    voice: str = "zh-TW-HsiaoChenNeural",
    rate: str = "+5%",
    pitch: str = "+0Hz",
    tts_cfg: dict[str, Any] | None = None,
) -> Path:
    """
    获取（或在首次使用时自动合成并缓存）本地 0.3 秒台湾腔反应垫词 MP3 文件。
    按 引擎 + 音色 + 垫词 ID 缓存，后续读取零网络延迟、零重复扣费。
    """
    if filler_id not in TAIWAN_FILLERS:
        raise ValueError(f"未知的反应垫词 ID: {filler_id}")

    ensure_data_dirs()
    FILLER_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    cfg = tts_cfg or {"provider": "edge_tts", "voice": voice}
    is_fish = (
        cfg.get("provider") == "fish_audio"
        and bool(str(cfg.get("fish_api_key", "")).strip())
    )

    if is_fish:
        ref_id = str(cfg.get("fish_reference_id", "default")).strip() or "default"
        safe_tag = f"fish_{re.sub(r'[^a-zA-Z0-9_-]', '_', ref_id)}"
    else:
        safe_tag = re.sub(r"[^a-zA-Z0-9_-]", "_", voice)

    cache_file = FILLER_CACHE_DIR / f"{safe_tag}_{filler_id}.mp3"

    if not cache_file.exists() or cache_file.stat().st_size == 0:
        provider = get_tts_provider(cfg)
        try:
            audio_bytes = await provider.synthesize_bytes(
                text=TAIWAN_FILLERS[filler_id],
                voice=voice,
                rate=rate,
                pitch=pitch,
            )
        except Exception:
            if is_fish:
                # 垫词合成异常时静默降级 Edge-TTS，不阻断对话
                audio_bytes = await EdgeTTSProvider().synthesize_bytes(
                    text=TAIWAN_FILLERS[filler_id],
                    voice=voice,
                    rate=rate,
                    pitch=pitch,
                )
            else:
                raise
        cache_file.write_bytes(audio_bytes)

    return cache_file


def get_tts_cache_path(
    provider_name: str,
    text: str,
    voice: str,
    rate: str,
    pitch: str,
    fish_reference_id: str = "",
    fish_model: str = "",
) -> Path:
    """按 引擎 + 音色/收藏ID + 模型 + 语速 + 音调 + 文本 计算稳定的本地 MP3 缓存路径"""
    ensure_data_dirs()
    TTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    voice_key = fish_reference_id.strip() if provider_name == "fish_audio" else voice.strip()
    model_key = fish_model.strip() if provider_name == "fish_audio" else ""
    payload = json.dumps(
        [provider_name, voice_key, model_key, rate.strip(), pitch.strip(), text.strip()],
        ensure_ascii=False,
    )
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]
    return TTS_CACHE_DIR / f"{provider_name}_{digest}.mp3"


def read_tts_cache(cache_path: Path) -> Path | None:
    """若命中非空本地缓存则刷新访问时间并返回路径"""
    try:
        if cache_path.exists() and cache_path.stat().st_size > 0:
            os.utime(cache_path, None)
            return cache_path
    except OSError:
        return None
    return None


def write_tts_cache(cache_path: Path, audio_bytes: bytes) -> None:
    """原子写入本地 TTS 缓存，并按 LRU 自动淘汰超出上限的旧音频文件"""
    if not audio_bytes:
        return
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = cache_path.with_suffix(".mp3.tmp")
        tmp_path.write_bytes(audio_bytes)
        os.replace(tmp_path, cache_path)

        files = list(TTS_CACHE_DIR.glob("*.mp3"))
        if len(files) > TTS_CACHE_MAX_FILES:
            files.sort(key=lambda p: p.stat().st_mtime)
            for old_file in files[: len(files) - TTS_CACHE_MAX_FILES]:
                try:
                    old_file.unlink(missing_ok=True)
                except OSError:
                    pass
    except OSError:
        # 磁盘缓存写入失败不影响正常播报
        pass
