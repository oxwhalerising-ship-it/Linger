# 小艺（TaiwanBot）— 台湾腔治愈系自我管理桌面小管家

一款常驻 Windows 桌面右下角的治愈系 AI 桌宠与苹果风自我管理主控面板，陪伴你建立日常习惯、掌控生活节奏、收集每日小确幸，并自动归档为 Obsidian 兼容的本地 Markdown 日记与周/月报。

---

## 核心特性

- **地道台湾腔治愈陪伴**：内置「去 AI 味」短句口语人设，支持免费微软台湾腔神经语音（`edge-tts`：`zh-TW-HsiaoChenNeural` / `zh-TW-HsiaoYuNeural`）、0.3 秒本地反应垫词与流式分句播报。
- **白天静默记录 + 晚间清单兜底核对**：白天聊天自然提取习惯、情绪/精力、长期记忆与高光时刻；晚间复盘自动比对固定习惯清单，逐项温柔核对并收集「每日小确幸罐子」。
- **Windows 透明置顶桌宠浮窗**：无边框透明、空白区鼠标穿透（不打扰正常办公）、平滑拖拽、系统托盘常驻、7 表情矢量治愈系小精灵（支持自定义换图与 Live2D 扩展接口）。
- **苹果风主控面板**：macOS 毛玻璃侧边栏 + 5 大视图（语音/文字聊天室、习惯清单、日历热力图与小确幸罐子、周/月报 AI 分析、设置与长期记忆）。
- **全天作息定时管家与「随机冒泡」**：4 个可自定义作息节点 + 活跃时段随机主动关怀 + 「稍后再聊（15 分钟）」 + 一键免打扰。
- **隐私优先的纯本地离线语音（`sherpa-onnx`）**：离线语音识别（ASR）与离线中文唤醒词（KWS），未唤醒前音频仅在本地内存推理，**零联网、零落盘**。

---

## 快速启动

### 方式一：一键双击启动（推荐）
直接双击项目根目录的 [start_taiwanbot.bat](start_taiwanbot.bat)，即可同时拉起本地 FastAPI 后端（`127.0.0.1:8765`）与 Electron 桌面端。

### 方式二：命令行启动
```powershell
cd d:\02_TaiwanBot\frontend
npm run dev:all
```

> 启动后，小艺会出现在屏幕右下角：
> - **左键拖拽**：自由移动位置
> - **单击轻戳**：俏皮台湾腔互动并展开快捷聊天条
> - **双击小精灵 / 单击系统托盘**：打开苹果风主控面板
> - **右键小精灵**：切换表情预览、开启免打扰、隐藏至托盘或退出

---

## 可选：配置大模型与纯本地离线语音模型

1. **安装后端依赖**（包含本地离线语音模型推理引擎 `sherpa-onnx`、`faster-whisper`、`sounddevice`、`pypinyin`、`aiohttp`、`numpy` 等）：
   ```powershell
   backend\.venv\Scripts\pip.exe install -r backend\requirements.txt
   ```
2. **一键拉取本地离线语音模型**（模型权重不提交至 Git，详见 `backend/models.json`）：
   ```powershell
   # 检查模型就绪状态
   backend\.venv\Scripts\python.exe backend\scripts\download_models.py --check

   # 自动下载缺失的本地模型至 data/models/（SenseVoice ASR、Zipformer KWS、Faster-Whisper Small）
   backend\.venv\Scripts\python.exe backend\scripts\download_models.py
   ```
3. **大模型 API Key**：打开主控面板 →「设置与记忆」→ 填写任意 OpenAI 兼容接口（默认推荐免费额度的 Google AI Studio `gemini-2.5-flash`，也支持 DeepSeek、硅基流动等）。留空时自动进入本地台湾腔体验模式。

---

## Windows 桌面打包（可选）

1. **打包 Electron 安装包**：
   ```powershell
   cd d:\02_TaiwanBot\frontend
   npm run package:win
   ```
   安装包将输出至 `frontend/release/`。
2. **（可选）将 Python 后端打包为单文件可执行程序**：
   ```powershell
   cd d:\02_TaiwanBot\backend
   .\.venv\Scripts\pip.exe install pyinstaller
   .\.venv\Scripts\pyinstaller.exe --onefile --name taiwanbot-backend -m uvicorn
   ```

---

## 本地数据目录

所有数据 100% 存储在本地 `data/` 目录下：
- `data/taiwanbot.db`：SQLite 数据库（习惯、打卡、对话、长期记忆、周月报、设置）
- `data/notes/daily/YYYY-MM-DD.md`：每日复盘日记（带 YAML Frontmatter，兼容 Obsidian）
- `data/notes/weekly/` & `data/notes/monthly/`：周报与月报 Markdown 档案
