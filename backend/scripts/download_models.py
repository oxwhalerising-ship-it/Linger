"""TaiwanBot 本地离线 AI 模型检查与一键拉取脚本。

用法：
    python backend/scripts/download_models.py --check
    python backend/scripts/download_models.py
    python backend/scripts/download_models.py --only asr kws
"""

from __future__ import annotations

import argparse
import glob
import json
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = PROJECT_ROOT / "backend" / "models.json"


def _is_installed(model: dict) -> bool:
    if "check_file" in model:
        return (PROJECT_ROOT / model["check_file"]).is_file()
    if "check_glob" in model:
        pattern = str(PROJECT_ROOT / model["check_glob"])
        return len(glob.glob(pattern)) > 0
    return False


def _download_tar_bz2(model: dict) -> None:
    target_dir = PROJECT_ROOT / model["target_dir"]
    target_dir.mkdir(parents=True, exist_ok=True)
    url = model["url"]
    print(f"[下载] {model['name']} <- {url}")

    with tempfile.NamedTemporaryFile(suffix=".tar.bz2", delete=False) as tmp:
        tmp_path = Path(tmp.name)

    try:
        def _progress(block_num: int, block_size: int, total_size: int) -> None:
            if total_size > 0:
                pct = min(100.0, block_num * block_size * 100.0 / total_size)
                print(f"\r  进度: {pct:5.1f}%", end="", flush=True)

        urllib.request.urlretrieve(url, tmp_path, reporthook=_progress)
        print()
        print(f"[解压] -> {target_dir}")
        with tarfile.open(tmp_path, "r:bz2") as tar:
            tar.extractall(path=target_dir, filter="data")
        print(f"[完成] {model['name']}")
    finally:
        tmp_path.unlink(missing_ok=True)


def _download_huggingface(model: dict) -> None:
    try:
        from huggingface_hub import snapshot_download
    except ImportError as exc:
        raise RuntimeError(
            "缺少 huggingface-hub 依赖，请先执行 `pip install -r backend/requirements.txt`"
        ) from exc

    target_dir = PROJECT_ROOT / model["target_dir"]
    target_dir.mkdir(parents=True, exist_ok=True)
    repo_id = model["repo_id"]
    print(f"[下载] {repo_id} -> {target_dir}")
    snapshot_download(repo_id=repo_id, cache_dir=str(target_dir))
    print(f"[完成] {repo_id}")


def main() -> int:
    parser = argparse.ArgumentParser(description="检查或下载 TaiwanBot 本地离线语音模型")
    parser.add_argument(
        "--check",
        action="store_true",
        help="仅检查模型就绪状态，不执行下载",
    )
    parser.add_argument(
        "--only",
        nargs="+",
        choices=["asr", "kws", "whisper"],
        help="仅处理指定模型 ID",
    )
    args = parser.parse_args()

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    models = manifest.get("models", [])
    if args.only:
        models = [m for m in models if m["id"] in args.only]

    missing = []
    for model in models:
        ready = _is_installed(model)
        status = "已就绪" if ready else "未安装"
        print(f"- [{model['id']:7s}] {status} | {model['name']} — {model['description']}")
        if not ready:
            missing.append(model)

    if args.check or not missing:
        if not missing:
            print("\n所有选定本地模型均已就绪。")
        return 0

    print()
    for model in missing:
        if model["type"] == "tar.bz2":
            _download_tar_bz2(model)
        elif model["type"] == "huggingface":
            _download_huggingface(model)
        else:
            print(f"[跳过] 未知模型类型: {model['type']}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
