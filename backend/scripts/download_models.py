"""灵儿本地离线语音模型检查与下载。

用法：
    python backend/scripts/download_models.py --check
    python backend/scripts/download_models.py
    python backend/scripts/download_models.py --only asr kws
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services.model_catalog import download_missing_models, get_model_status  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="检查或下载灵儿的本地离线语音模型")
    parser.add_argument("--check", action="store_true", help="只检查，不下载")
    parser.add_argument(
        "--only",
        nargs="+",
        choices=["asr", "kws"],
        help="只处理指定模型",
    )
    args = parser.parse_args()

    status = get_model_status()
    if status.get("error") and not status["items"]:
        print(status["error"], file=sys.stderr)
        return 1

    selected = set(args.only or [])
    missing: list[str] = []
    for item in status["items"]:
        if selected and item["id"] not in selected:
            continue
        label = "已就绪" if item["ready"] else "未安装"
        print(f"- [{item['id']:7s}] {label} | {item['name']} — {item['description']}")
        if not item["ready"]:
            missing.append(item["id"])

    if args.check or not missing:
        if not missing:
            print("\n选定的本地模型都已就绪。")
        return 0

    print()
    download_missing_models(missing)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
