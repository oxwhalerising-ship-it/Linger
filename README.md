# 灵儿

常驻 Windows 桌面的台湾腔小管家。她坐在角落里陪你说话，把一天里提到的习惯、心情和小确幸收进本地日记。

产品名是灵儿。数据库文件仍叫 `taiwanbot.db`，这样已经在用的记录不会因为改名丢。

## 你打开之后会看到什么

两个窗口一起出来：

- **桌宠。** 透明、置顶，空白处点得穿。可以拖，可以贴到别的窗口边上，也可以缩到屏幕边缘探头。水晶环菜单里能发文字、打电话、换表情。`Alt+Shift+L` 把她叫出来。关掉主面板不会退出，她进系统托盘。
- **主控面板。** 对话、历史消息、习惯清单、日历和小确幸、周报月报、设置和长期记忆。

本地大脑是 FastAPI，只听 `127.0.0.1:8765`。日记在 `data/`：

- `data/taiwanbot.db`：习惯、对话、记忆、设置
- `data/notes/daily|weekly|monthly`：带 YAML frontmatter 的 Markdown，可以直接丢进 Obsidian
- `data/linger.token`：本机接口令牌，桌宠用它访问大脑。不要把它发给别人

## 一轮对话怎么走

文字和电话共用同一套口语。模型按短句往外说，第一句凑齐就先念出来，不用等整段结束。习惯打卡、心情、小确幸和长期记忆在这段话说完之后再写进数据库和当天的 Markdown。

没填 API Key 时，她仍用本地台湾腔回你，并提醒去设置里补上。默认模型接口是 Gemini 2.5 Flash，任何 OpenAI 兼容地址都可以。

听写只用本地 **SenseVoice Small**。电话和按住说话都走这条路径，不再把录音送到云端识别。说话仍可用 Edge TTS 的台湾腔 `zh-TW-HsiaoChenNeural`，设置里也可以换成 Fish Audio 合成。

唤醒词默认关着，词是「灵儿」。作息有早安、午间、晚间复盘、睡前四档，外加活跃时段里一到两次随口关心。免打扰和「稍后再聊」都在。

## 启动

双击项目根目录的 [start_linger.bat](start_linger.bat)。它会拉起后端、Vite 和 Electron。旧的 `start_taiwanbot.bat` 只是转去这个脚本。

命令行：

```powershell
cd D:\02_LingerBot\frontend
npm run dev:all
```

第一次启动如果 `data/models/` 里还没有语音模型，后端会在后台下载 SenseVoice Small 和唤醒词模型。桌宠和侧边栏会显示「正在下载」。文字聊天不用等下载结束。

依赖只需要装一次：

```powershell
backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt -r backend\requirements-dev.txt
cd frontend
npm install
```

## 换到另一台电脑

开发机继续用上面的 bat。要做成安装包：

```powershell
cd D:\02_LingerBot\frontend
npm run package:win
```

安装包会带上后端源码。第一次在新电脑打开时，灵儿会在用户目录里建一个 Python 虚拟环境、安装依赖，并把日记和模型放到本机用户数据目录，而不是安装目录。那台电脑需要能运行 `py -3` 或已安装的 Python 3.11+。模型仍在第一次打开时下载。

侧边栏的圆点会告诉你大脑在不在：绿色是在线，黄色是还在准备模型，红色是没连上。桌宠头顶也会写一句人话。

## 本机令牌

除了浏览器预检，所有 HTTP 请求都要带 `X-Linger-Token`。WebSocket 用子协议 `linger-auth.<令牌>`，这样令牌不会出现在访问日志的网址里。Electron 从 `data/linger.token` 读取。日志里的 API Key 会被抹掉。

## 测试

```powershell
backend\.venv\Scripts\python.exe -m pytest backend/tests
```

覆盖模型 JSON 的容错解析、习惯提取（不猜、不重复）、每日 Markdown、旧对话表补上 text/voice 渠道、文字对话先出句再结束、听写引擎顺序，以及令牌会挡住没带凭证的请求。
