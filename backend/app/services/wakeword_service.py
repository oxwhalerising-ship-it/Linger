"""
纯本地离线中文语音唤醒引擎（sherpa-onnx KWS）
--------------------------------------------
核心隐私铁律（Zero Network, Zero Disk）：
1. 未命中唤醒词前，麦克风 16kHz 音频流仅在本地内存中逐帧送入 sherpa-onnx KeywordSpotter，
   用完即弃，绝不写入硬盘、绝不发起任何网络请求。
2. 支持用户在设置页自定义中文唤醒词（默认「灵儿」）。
3. 命中唤醒词后，通过本地 WebSocket 事件总线（/ws/events）即时推送 `wakeword_detected`，
   桌宠在 1 秒内点亮、播放台湾腔应答音并进入倾听对话态。
4. 优雅降级：若本机尚未安装 sherpa-onnx / sounddevice 或尚未放置 KWS 模型文件，
   会通过 get_wakeword_status() 返回清晰指引，并支持模拟唤醒接口用于端到端联调验收。
"""

import asyncio
import json
import re
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from app.core.settings_store import invalidate_settings_cache
from app.database import DATA_DIR, DEFAULT_SETTINGS, db_cursor
from app.services.event_bus import event_bus
from app.services.tts_provider import split_sentences_for_streaming

# 离线中文 KWS 唤醒模型存放目录（例如 sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01）
KWS_MODEL_DIR = DATA_DIR / "models" / "kws"

# 唤醒命中后的冷却时间（秒），防止同一句话重复触发或扬声器应答回声二次唤醒
WAKEWORD_COOLDOWN_SEC = 5.0

# 内置常用默认中文唤醒词音素映射（避免未装 pypinyin 时无法启动默认唤醒词）
BUILTIN_KEYWORD_TOKENS: dict[str, str] = {
    "灵儿": "l íng ér @灵儿",
    "你好灵儿": "n ǐ h ǎo l íng ér @你好灵儿",
    "小管家": "x iǎo g uǎn j iā @小管家",
    "小团团": "x iǎo t uán t uán @小团团",
}


class OfflineWakewordEngine:
    """后台线程运行的纯本地离线关键词唤醒管理器"""

    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._started_event = threading.Event()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._is_listening = False
        self._last_error: str | None = None
        self._last_triggered_at: str | None = None
        self._last_trigger_monotonic: float = 0.0

    def _load_config(self) -> dict[str, Any]:
        defaults = json.loads(json.dumps(DEFAULT_SETTINGS["wakeword"]))
        with db_cursor() as cur:
            cur.execute("SELECT value FROM settings WHERE key = 'wakeword';")
            row = cur.fetchone()
        if row:
            saved = json.loads(row["value"])
            if isinstance(saved, dict):
                defaults.update(saved)
        return defaults

    def _save_config(self, enabled: bool, keyword: str) -> dict[str, Any]:
        cfg = {"enabled": bool(enabled), "keyword": keyword.strip() or "灵儿"}
        now_iso = datetime.now().isoformat(timespec="seconds")
        with db_cursor() as cur:
            cur.execute(
                """
                INSERT INTO settings (key, value, updated_at)
                VALUES ('wakeword', ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at;
                """,
                (json.dumps(cfg, ensure_ascii=False), now_iso),
            )
        invalidate_settings_cache()
        return cfg

    def _find_kws_model_files(self) -> dict[str, Path] | None:
        """在 data/models/kws 下自动探测 sherpa-onnx KWS Transducer 模型文件（确保三件套同版本配对）"""
        if not KWS_MODEL_DIR.exists():
            return None
        for tokens_path in KWS_MODEL_DIR.rglob("tokens.txt"):
            folder = tokens_path.parent
            encoders = sorted(
                folder.glob("encoder*.onnx"),
                key=lambda p: (0 if ".int8." in p.name else 1, p.name),
            )
            for encoder in encoders:
                suffix = encoder.name[len("encoder") :]
                decoder = folder / f"decoder{suffix}"
                joiner = folder / f"joiner{suffix}"
                if decoder.exists() and joiner.exists():
                    return {
                        "dir": folder,
                        "tokens": tokens_path,
                        "encoder": encoder,
                        "decoder": decoder,
                        "joiner": joiner,
                    }
            # 兜底：若命名不遵循统一后缀，回退按前缀匹配
            encoder = next(folder.glob("encoder*.onnx"), None)
            decoder = next(folder.glob("decoder*.onnx"), None)
            joiner = next(folder.glob("joiner*.onnx"), None)
            if encoder and decoder and joiner:
                return {
                    "dir": folder,
                    "tokens": tokens_path,
                    "encoder": encoder,
                    "decoder": decoder,
                    "joiner": joiner,
                }
        return None

    def _load_valid_tokens(self, tokens_path: Path) -> set[str]:
        """读取模型 tokens.txt 中的有效音素集合"""
        valid: set[str] = set()
        for raw_line in tokens_path.read_text(encoding="utf-8").splitlines():
            parts = raw_line.strip().split()
            if parts:
                valid.add(parts[0])
        return valid

    def _build_keywords_file(self, keyword: str, model_files: dict[str, Path]) -> Path:
        """根据自定义中文唤醒词生成本地临时 custom_keywords.txt 供 sherpa-onnx 加载"""
        clean_kw = re.sub(r"\s+", "", keyword.strip()) or "灵儿"
        line = BUILTIN_KEYWORD_TOKENS.get(clean_kw)

        if not line:
            try:
                from pypinyin import Style, pinyin
            except ImportError as exc:
                raise RuntimeError(
                    f"自定义唤醒词「{clean_kw}」需要 pypinyin 转换为拼音音素，"
                    "请在后端虚拟环境中安装：pip install pypinyin"
                ) from exc

            valid_tokens = self._load_valid_tokens(model_files["tokens"])
            initials = pinyin(clean_kw, style=Style.INITIALS, strict=False)
            finals = pinyin(clean_kw, style=Style.FINALS_TONE, strict=False)
            tokens: list[str] = []
            for ini, fin in zip(initials, finals):
                if ini and ini[0] and ini[0] in valid_tokens:
                    tokens.append(ini[0])
                if fin and fin[0]:
                    if fin[0] in valid_tokens:
                        tokens.append(fin[0])
                    else:
                        # 轻声或罕见韵母尝试去掉无法匹配的符号
                        raise ValueError(
                            f"唤醒词「{clean_kw}」包含模型不支持的音素「{fin[0]}」，请换一个常见中文词（如 2-4 个汉字）"
                        )
            if not tokens:
                raise ValueError(f"无法将唤醒词「{clean_kw}」转换为有效中文拼音音素，请使用 2-4 个常见汉字")
            line = f"{' '.join(tokens)} @{clean_kw}"

        kw_file = model_files["dir"] / "custom_keywords.txt"
        kw_file.write_text(line + "\n", encoding="utf-8")
        return kw_file

    def get_status(self) -> dict[str, Any]:
        """返回离线唤醒引擎就绪状态、监听状态与隐私声明"""
        cfg = self._load_config()
        keyword = str(cfg.get("keyword", "灵儿")).strip() or "灵儿"
        try:
            import sherpa_onnx  # noqa: F401

            has_sherpa = True
        except ImportError:
            has_sherpa = False

        try:
            import sounddevice  # noqa: F401

            has_sd = True
        except ImportError:
            has_sd = False

        try:
            import pypinyin  # noqa: F401

            has_pypinyin = True
        except ImportError:
            has_pypinyin = False

        model_files = self._find_kws_model_files()
        has_model = model_files is not None
        need_pypinyin = keyword not in BUILTIN_KEYWORD_TOKENS
        ready = has_sherpa and has_sd and has_model and (has_pypinyin or not need_pypinyin)

        hints: list[str] = []
        if not has_sherpa:
            hints.append("安装离线推理引擎：backend\\.venv\\Scripts\\python.exe -m pip install sherpa-onnx")
        if not has_sd:
            hints.append("安装麦克风采集库：backend\\.venv\\Scripts\\python.exe -m pip install sounddevice")
        if not has_pypinyin:
            hints.append("安装自定义中文唤醒词拼音库：backend\\.venv\\Scripts\\python.exe -m pip install pypinyin")
        if not has_model:
            hints.append(
                f"下载中文 KWS 模型（如 sherpa-onnx-kws-zipformer-wenetspeech-3.3M）并解压至：{KWS_MODEL_DIR}"
            )

        return {
            "enabled": bool(cfg.get("enabled", False)),
            "listening": self._is_listening,
            "keyword": keyword,
            "ready": ready,
            "privacy_mode": "local_ram_only",
            "model_dir": str(KWS_MODEL_DIR),
            "last_triggered_at": self._last_triggered_at,
            "last_error": self._last_error,
            "setup_hints": hints,
        }

    async def broadcast_wakeup(self, keyword: str, simulated: bool = False) -> dict[str, Any]:
        """通过 WebSocket 广播唤醒命中事件，让桌宠在 1 秒内响应并进入对话态"""
        from app.services.scheduler_service import load_schedule_settings

        # 免打扰已把唤醒关掉时，真实命中和模拟唤醒都不再把桌宠叫起来。
        if load_schedule_settings().get("dnd_enabled") and not self._load_config().get("enabled", False):
            return {
                "triggered": False,
                "reason": "dnd_enabled",
                "delivered_clients": 0,
            }

        self._last_triggered_at = datetime.now().isoformat(timespec="seconds")
        # 应答词不重复念出唤醒词本身，避免扬声器外放导致麦克风回声二次误触发
        reply_text = "欸～我在喔！有什么事直接说吧！"
        payload = {
            "type": "wakeword_detected",
            "keyword": keyword,
            "simulated": simulated,
            "emotion": "listening",
            "text": reply_text,
            "sentences": split_sentences_for_streaming(reply_text),
            "filler_id": "uhhuh",
            "triggered_at": self._last_triggered_at,
        }
        delivered = await event_bus.broadcast(payload)
        return {
            "triggered": True,
            "delivered_clients": delivered,
            "payload": payload,
        }

    def _listen_worker(self, keyword: str, model_files: dict[str, Path]) -> None:
        """后台纯本地内存音频流监听线程（未唤醒绝不落盘、绝不联网）"""
        try:
            import sherpa_onnx
            import sounddevice as sd

            kw_file = self._build_keywords_file(keyword, model_files)
            spotter = sherpa_onnx.KeywordSpotter(
                tokens=str(model_files["tokens"]),
                encoder=str(model_files["encoder"]),
                decoder=str(model_files["decoder"]),
                joiner=str(model_files["joiner"]),
                num_threads=2,
                keywords_file=str(kw_file),
                provider="cpu",
            )
            stream = spotter.create_stream()
            sample_rate = 16000
            samples_per_read = int(0.1 * sample_rate)  # 每次读取 100ms 音频帧

            with sd.InputStream(channels=1, dtype="float32", samplerate=sample_rate) as mic:
                self._is_listening = True
                self._last_error = None
                self._started_event.set()

                while not self._stop_event.is_set():
                    samples, _overflowed = mic.read(samples_per_read)
                    mono = samples.reshape(-1)
                    stream.accept_waveform(sample_rate, mono)

                    detected = ""
                    while spotter.is_ready(stream):
                        spotter.decode_stream(stream)
                        res = spotter.get_result(stream)
                        if res:
                            detected = res
                            spotter.reset_stream(stream)
                            break

                    if detected:
                        now_mono = time.monotonic()
                        if now_mono - self._last_trigger_monotonic >= WAKEWORD_COOLDOWN_SEC:
                            self._last_trigger_monotonic = now_mono
                            if self._loop and self._loop.is_running():
                                asyncio.run_coroutine_threadsafe(
                                    self.broadcast_wakeup(keyword=keyword, simulated=False),
                                    self._loop,
                                )
        except Exception as exc:
            self._last_error = str(exc)
        finally:
            self._is_listening = False
            self._started_event.set()

    def _start_listener(
        self,
        keyword: str,
        loop: asyncio.AbstractEventLoop | None,
    ) -> None:
        """内部启动监听线程并等待麦克风与模型初始化完成（最多 3 秒）"""
        model_files = self._find_kws_model_files()
        if not model_files:
            self._last_error = f"未在 {KWS_MODEL_DIR} 下找到完整的 KWS 模型文件。"
            return

        self._loop = loop
        self._stop_event.clear()
        self._started_event.clear()
        self._last_error = None
        self._thread = threading.Thread(
            target=self._listen_worker,
            args=(keyword, model_files),
            name="taiwanbot-kws-listener",
            daemon=True,
        )
        self._thread.start()
        self._started_event.wait(timeout=3.0)

    def start_if_enabled(self, loop: asyncio.AbstractEventLoop | None = None) -> dict[str, Any]:
        """后端启动时自动检查数据库配置，若用户已启用唤醒则自动拉起本地监听线程"""
        from app.services.scheduler_service import load_schedule_settings

        cfg = self._load_config()
        if load_schedule_settings().get("dnd_enabled"):
            # 重启时如果免打扰还开着，唤醒不能自己回来。
            if cfg.get("enabled", False):
                self._save_config(enabled=False, keyword=str(cfg.get("keyword") or "灵儿"))
            self.stop()
            return self.get_status()

        if not cfg.get("enabled", False):
            return self.get_status()

        status = self.get_status()
        if not status["ready"]:
            self._last_error = "本地离线 KWS 依赖或模型尚未就绪，暂未自动启动麦克风监听。"
            return self.get_status()

        self.stop()
        self._start_listener(status["keyword"], loop)
        return self.get_status()

    def toggle(
        self,
        enabled: bool,
        keyword: str | None = None,
        loop: asyncio.AbstractEventLoop | None = None,
    ) -> dict[str, Any]:
        """开启或关闭纯本地离线语音唤醒监听，并持久化配置"""
        current_cfg = self._load_config()
        target_keyword = (keyword or current_cfg.get("keyword") or "灵儿").strip() or "灵儿"
        self._save_config(enabled=enabled, keyword=target_keyword)

        # 先停止旧监听线程
        self.stop()
        self._last_error = None

        if not enabled:
            return self.get_status()

        status = self.get_status()
        if not status["ready"]:
            self._last_error = "本地离线 KWS 依赖或模型尚未就绪，配置已保存但暂未启动麦克风监听。"
            return self.get_status()

        self._start_listener(target_keyword, loop)
        return self.get_status()

    def stop(self) -> None:
        """优雅停止后台麦克风监听线程"""
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.5)
        self._thread = None
        self._is_listening = False


# 全局单例离线语音唤醒管理器
wakeword_engine = OfflineWakewordEngine()
