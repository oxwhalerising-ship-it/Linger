@echo off
chcp 65001 >nul
title 灵儿 — 台湾腔治愈系自我管理桌面小管家

echo ==================================================
echo   正在启动 灵儿 (TaiwanBot) 本地大脑与桌面浮窗...
echo   关闭本窗口将同时停止前后端服务
echo ==================================================

REM 彻底清理可能残留占用 8765 端口的旧后端进程（含孤儿 multiprocessing 子进程）
"%~dp0backend\.venv\Scripts\python.exe" "%~dp0backend\cleanup_port.py" >nul 2>&1

REM 清理可能驻留在托盘中的本项目旧 Electron 主进程，防止单实例锁导致 main.cjs 窗口尺寸更新不生效
powershell -NoProfile -Command "$root = (Resolve-Path '%~dp0frontend').Path; Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

cd /d "%~dp0frontend"
call npm run dev:all
pause
