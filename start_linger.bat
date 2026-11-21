@echo off
chcp 65001 >nul
title 灵儿 — 台湾腔治愈系自我管理桌面小管家

echo ==================================================
echo   正在启动灵儿的本地大脑和桌面浮窗...
echo   关闭本窗口会同时停下前后端
echo ==================================================

REM 清掉占用 8765 的旧后端，避免桌宠连到没有令牌的旧进程
"%~dp0backend\.venv\Scripts\python.exe" "%~dp0backend\cleanup_port.py" >nul 2>&1

REM 清掉本项目残留的 Electron，避免单实例锁挡住新窗口
powershell -NoProfile -Command "$root = (Resolve-Path '%~dp0frontend').Path; Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

cd /d "%~dp0frontend"
call npm run dev:all
pause
