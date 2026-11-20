"""流式口语分句器、TTS 文本清洗与零延迟情绪推断。"""

from __future__ import annotations

import re

_VOICE_MARKDOWN_NOISE_RE = re.compile(r"[*#`~_<>【】\[\]]+")
_VOICE_STAGE_DIR_RE = re.compile(r"[（(][^）)]{1,16}[）)]")
_STRONG_PUNCT_SET = set("。！？!?～…\n")
_SOFT_PUNCT_SET = set("，、,；;：:")


def clean_spoken_text_for_tts(text: str) -> str:
    """清理不适合语音朗读的 Markdown 符号与舞台提示（保留自然台湾腔标点与语助词）。"""
    cleaned = _VOICE_STAGE_DIR_RE.sub("", text or "")
    cleaned = _VOICE_MARKDOWN_NOISE_RE.sub("", cleaned)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return cleaned


class IncrementalSentenceSplitter:
    """
    流式增量分句器（为实时语音通话首句抢跑设计）
    -------------------------------------------
    1. 首句极速切出：只要遇到句末强标点，或在逗号/顿号处已攒够 >= 7 个有效字符，立刻吐出送 TTS。
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
    """根据灵儿口语回复即时推断桌宠/通话头像表情，零额外 LLM 延迟。"""
    text = reply_text or ""
    if any(k in text for k in ("睡觉", "晚安", "早点睡", "熬夜", "休息一下", "困")):
        return "sleepy"
    if any(k in text for k in ("拍拍", "辛苦", "没关系", "抱抱", "加油", "已经很棒", "别太累")):
        return "encouraging"
    if any(k in text for k in ("想想", "让我想", "怎么说", "研究一下")):
        return "thinking"
    return "happy"
