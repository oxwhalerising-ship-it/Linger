"""
启动前端口清理工具（Windows 8765 端口残留进程树清理）
---------------------------------------------------
彻底清理可能残留占用 8765 端口的旧后端进程及其孤儿 multiprocessing 子进程，
避免 Windows SO_REUSEADDR 导致新旧后端同时监听同一端口引发 404/403 错乱。
"""

import json
import re
import subprocess


def main() -> None:
    target_port = 8765
    try:
        netstat_out = subprocess.check_output(
            "netstat -ano",
            shell=True,
            text=True,
            errors="ignore",
        )
    except Exception:
        netstat_out = ""

    listening_pids: set[str] = set()
    for line in netstat_out.splitlines():
        if f":{target_port} " in line and "LISTENING" in line:
            match = re.search(r"(\d+)\s*$", line)
            if match and match.group(1) != "0":
                listening_pids.add(match.group(1))

    extra_pids: set[str] = set()
    try:
        ps_out = subprocess.check_output(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" "
                "| Select-Object ProcessId,ParentProcessId,CommandLine "
                "| ConvertTo-Json -Compress",
            ],
            text=True,
            errors="ignore",
        )
        if ps_out.strip():
            parsed = json.loads(ps_out)
            procs = [parsed] if isinstance(parsed, dict) else parsed
            for p in procs:
                pid = str(p.get("ProcessId") or "")
                ppid = str(p.get("ParentProcessId") or "")
                cmd = str(p.get("CommandLine") or "")
                if ppid in listening_pids or "app.main:app" in cmd:
                    if pid and pid != "0":
                        extra_pids.add(pid)
    except Exception:
        pass

    for pid in listening_pids | extra_pids:
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", pid],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )


if __name__ == "__main__":
    main()
