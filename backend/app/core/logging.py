"""统一日志初始化。格式化时抹掉 API Key 和本地令牌，避免它们进控制台。"""

from __future__ import annotations

import logging
import re
import sys

_CONFIGURED = False

_SECRET_VALUE = re.compile(
    r"(?i)((?:api[_-]?key|x-linger-token|authorization)[\"']?\s*[:=]\s*[\"']?(?:bearer\s+)?)([^\"'\s,}]{6,})"
)
_SK_TOKEN = re.compile(r"sk-[A-Za-z0-9_\-]{8,}")
_GOOGLE_KEY = re.compile(r"AIza[0-9A-Za-z_\-]{20,}")


def redact_secrets(text: str) -> str:
    """把日志里的密钥和本地令牌换成 ***。"""
    cleaned = _SK_TOKEN.sub("***", text or "")
    cleaned = _GOOGLE_KEY.sub("***", cleaned)
    cleaned = _SECRET_VALUE.sub(r"\1***", cleaned)
    return cleaned


class RedactingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return redact_secrets(super().format(record))


def configure_logging(level: int = logging.INFO) -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return
    _CONFIGURED = True
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        RedactingFormatter(
            fmt="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%H:%M:%S",
        )
    )
    root = logging.getLogger("linger")
    root.setLevel(level)
    if not root.handlers:
        root.addHandler(handler)
    root.propagate = False


def get_logger(name: str) -> logging.Logger:
    configure_logging()
    return logging.getLogger(f"linger.{name}")
