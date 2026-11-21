# 产品需求与架构设计文档（PRD）— 治愈系自我管理小管家（灵儿）

> 现行产品名是灵儿。下文里的「小艺 / TaiwanBot」是早期设计名。启动方式、听写顺序和窗口行为以仓库根目录的 README 为准。

> **项目愿景**：打造一位常驻 Windows 桌面的治愈系小精灵 Agent（默认昵称「小艺」，可自定义）。她俏皮可爱、温暖有耐心，通过全天作息陪伴、随机语音冒泡与自然的语音聊天，帮你无痛记录每日习惯、沉淀复盘日记、定期生成成长洞察，让生活重回正轨、恢复满满精力。

---

## 1. 核心业务流（Core Business Flow）

### 1.1 系统总体数据流向
```text
[用户语音 / 文字]
   │
   ├─(待机态)─► 本地离线唤醒引擎 (sherpa-onnx KWS，纯内存检测，不联网不落盘)
   │               └─ 命中「小艺」─► 点亮桌宠 + 播放应答音 + 进入对话态
   │
   └─(对话态)─► VAD 自动停顿检测 / 按住说话 ─► 本地离线 STT (sherpa-onnx ASR) ─► 文本
                                                                                    │
   ┌────────────────────────────────────────────────────────────────────────────────┘
   ▼
[本地 Python FastAPI Agent 核心]
   ├─ 1. 组装上下文：人设 Prompt + 预设习惯清单 + 今日已记录状态 + 近期记忆摘要
   ├─ 2. 调用云端 LLM（OpenAI 兼容协议：DeepSeek / Gemini / 硅基流动等）
   │       ├─ 输出 A：自然对话回复（俏皮、鼓励、穿插引导未聊到的习惯）
   │       └─ 输出 B（静默后台）：结构化提取今日习惯打卡、事件摘要、精力/情绪分
   ├─ 3. 语音合成：微软 Edge-TTS (zh-TW-HsiaoChenNeural / HsiaoYuNeural) ─► 音频流返回桌宠播放
   └─ 4. 自动归档：写入本地 SQLite + 自动生成/更新 `data/notes/daily/YYYY-MM-DD.md`
```

### 1.2 核心业务场景
1. **白天静默记录 + 晚间复盘清单核对（无痛且精准）**：
   - 用户提前在面板中配置「每日习惯清单」（如早起、喝水、运动、阅读、早睡）和「每日关注问题」（如今天最开心的事、精力状态如何）。
   - **白天对话**：Agent 像朋友一样聊天，后台自动静默识别并记录顺口提到的习惯与事件，不打扰聊天节奏。
   - **晚间固定复盘**：小艺自动对照当日固定清单，核对“哪些白天已记下、哪些尚未记录”，用自然口吻向用户逐一确认真实情况，确保每天应记项**无遗漏、无误判**后再锁定当日归档。
   - **口语与去 AI 味规范**：
     - 每次回复保持 2–4 句短句口语，遵循「先接住情绪、再轻推行动、绝不说教」原则。
     - **高频台湾语助词与句尾**（自然融入、不生硬堆砌）：开头/过渡善用「欸～、吼、是说、跟你讲喔、天哪」；句尾善用「喔、啦、耶、欸、捏、齁」（如“真的假的啦！”、“这样超棒的耶！”、“辛苦你了喔～”、“你超厉害捏！”）。
     - **台湾生活化表达与叠词**：多用「很可以、超赞、拍拍你、休息一下下、吃饱饱、放空一下」等自然台湾口语，禁用大陆公文腔与“首先/其次/总而言之”等机器人句式；且支持用户在设置页随时自定义补充喜欢的口头禅。
2. **全天作息管家（多节点定时触发）**：
   - 内置 4 个可自定义时间与开关的作息节点：**早安规划**、**午间提醒**、**晚间复盘**、**睡前催睡**。
   - 到点时桌宠自动切换表情动画、弹出气泡并播放轻柔提示语音；若用户正忙，可一键点击「稍后再聊（15 分钟后）」或开启「免打扰」。
3. **随机冒泡陪伴（活人感互动）**：
   - 在用户设定的活跃时段内（如 10:00–21:00），调度器每天随机抽取 1–2 个时间点，由桌宠主动探头发起轻互动（如“欸～你现在在忙什么呀？要不要起来伸个懒腰喝口水呀？”）。
4. **周期性复盘分析（周报 / 月报）**：
   - 自动汇总过去 7 天 / 30 天的习惯完成率、情绪与精力趋势、高频关键词以及本周收集的「小确幸」，由 Agent 以温柔鼓励的口吻生成周报/月报分析与下阶段微调建议，既可在面板查看，也同步导出为本地 Markdown 报告。
5. **长期记忆与高光回溯（Memory Capsule）**：
   - 后台自动从对话中提炼关键长期记忆（如你的个人喜好、正在攻克的目标、近期在意的事情及跟进日期、历史高光时刻）。
   - 下次聊天或随机冒泡时，小艺会自然主动关心前几天聊过的事（如“欸，你前天说有点担心的那件事，后来顺利吗？”）；当你情绪低落时，她还能翻出你过往的高光记录温柔鼓励你。
6. **每日小确幸罐子（Gratitude Jar）**：
   - 晚间复盘收尾时，小艺会温柔地多问一句今天有没有哪件小小的、让你觉得不错的事（哪怕只是喝到一杯好喝的奶茶或按时吃了饭），自动装进本地「小确幸罐子」并同步写入当日 Markdown 日记与周报，持续积累正向自我认知。
7. **隐私优先的纯本地离线唤醒**：
   - 后台常驻监听麦克风时，音频流仅在本地 `sherpa-onnx` 模型内存中滑窗推理，用完即弃，**绝不上传任何音频或文本到云端**。仅在命中自定义中文唤醒词后，才开始当前轮次的语音对话。

---

## 2. 前端架构（Frontend Architecture）

采用 **Electron + React + TypeScript + Vite + Tailwind CSS** 构建 Windows 桌面端双窗口应用：

### 2.1 窗口划分
1. **桌宠浮窗（Pet Window）**：
   - 无边框、背景完全透明、置顶（Always-on-Top）、支持鼠标拖拽与忽略透明区域点击。
   - 承载治愈系小精灵渲染层、对话气泡、快捷语音按钮（按住说话 / 免提开关 / 静音）。
2. **主控面板窗口（Dashboard Window）**：
   - 点击桌宠或系统托盘图标呼出，包含聊天记录、习惯管理、日历热力图、周/月分析报告、人设与系统设置。

### 2.2 组件树划分
```text
src/
├── windows/
│   ├── PetWindow/                    # 透明桌宠窗口
│   │   ├── AvatarRenderer.tsx        # 可插拔形象渲染层（默认 2D 多表情治愈小精灵；预留自定义换图 & Live2D 插槽）
│   │   ├── SpeechBubble.tsx          # 文字气泡 & 「稍后再聊」快捷操作
│   │   └── QuickVoiceBar.tsx         # 悬浮操作栏（免提连续通话 / 按住说话 / 打开主面板）
│   └── DashboardWindow/              # 主控面板窗口
│       ├── ChatPanel.tsx             # 语音 + 文字对话区（显示实时识别状态、音频波形、自动归档提示胶囊）
│       ├── HabitManager.tsx          # 每日习惯清单 & 预设关注问题管理
│       ├── CalendarJournal.tsx       # 每日复盘日历、习惯打卡热力图、精力/情绪曲线、小确幸罐子 & Markdown 预览
│       ├── AnalyticsReport.tsx       # 周报 / 月报 AI 深度分析面板与导出
│       └── SettingsPanel.tsx         # API Key/模型配置、人设与音色、作息时间表、随机冒泡、唤醒词与长期记忆管理
└── shared/
    ├── stores/                       # 状态管理（Zustand）
    │   ├── usePetStore.ts            # 桌宠当前情绪状态（idle/happy/listening/thinking/speaking/sleepy）、免打扰状态
    │   ├── useChatStore.ts           # 当前会话消息、录音/VAD 状态、播放队列
    │   └── useConfigStore.ts         # 人设、API、定时规则、唤醒词配置
    └── services/
        ├── apiClient.ts              # 与本地 FastAPI 通信的 REST & WebSocket 客户端
        └── audioPlayer.ts            # Edge-TTS 音频流播放与口型/弹跳联动
```

---

## 3. 后端与数据库（Backend & Database）

采用 **本地 Python FastAPI** 作为后端常驻服务（与 Electron 协同启动），充分利用 Python 在语音与 AI 生态上的零成本优势：
- **语音合成（可插拔 `TTSProvider` 架构）**：默认采用免费 `edge-tts`（`zh-TW-HsiaoChenNeural` 晓臻 / `zh-TW-HsiaoYuNeural` 晓雨），结合**流式分句播放**与**本地 0.3 秒反应垫词**（如“嗯嗯～”、“喔真的假的！”）消除等待冷场、提升活人感；底层抽象为统一接口，后续可在设置页无痛切换至高情感商业 TTS（Fish Audio / MiniMax）或 Gemini Live 实时语音。
- **离线唤醒 & 语音识别（KWS & STT）**：`sherpa-onnx`（纯 CPU 离线运行，支持自定义中文唤醒词与中文语音转文字）+ `webrtcvad` / 能量阈值静音检测。
- **大模型接入（LLM）**：标准 `openai` Python SDK（兼容 DeepSeek、Gemini OpenAI 兼容端点、硅基流动、以及未来扩展的本地 Ollama）。
- **定时调度**：`APScheduler`（管理固定作息节点 + 每日随机冒泡时间生成）。

### 3.1 数据库表结构（SQLite：`data/taiwanbot.db`）

| 表名 | 核心字段 | 说明 |
| :--- | :--- | :--- |
| `settings` | `key (PK)`, `value (JSON)`, `updated_at` | 存储 API Key、Base URL、模型名、人设 Prompt、音色、作息时间表、随机冒泡区间、唤醒词配置、形象路径等 |
| `habits` | `id (PK)`, `title`, `category`, `frequency`, `target_desc`, `is_active`, `created_at` | 用户预设的每日行为习惯与关注事项清单 |
| `daily_logs` | `date (PK, YYYY-MM-DD)`, `summary`, `mood_score (1-5)`, `energy_score (1-5)`, `highlights (JSON, 含每日小确幸)`, `md_path`, `updated_at` | 每日自动归档的复盘摘要、情绪/精力评分、小确幸列表及对应 Markdown 文件路径 |
| `habit_records` | `id (PK)`, `date`, `habit_id (FK)`, `status (done/partial/missed)`, `note`, `recorded_at` | Agent 从聊天中静默提取的每日各习惯完成状态与备注 |
| `messages` | `id (PK)`, `session_date`, `role (user/assistant/system)`, `content`, `trigger_type (manual/schedule/random/wakeword)`, `created_at` | 完整对话历史，用于短期上下文与长期记忆检索 |
| `memories` | `id (PK)`, `memory_type (preference/ongoing_event/highlight)`, `content`, `follow_up_date`, `is_resolved`, `created_at` | 长期记忆档案与高光时刻：支持跨天主动关心跟进，以及情绪低落时回溯鼓励 |
| `reports` | `id (PK)`, `period_type (weekly/monthly)`, `start_date`, `end_date`, `stats_json`, `ai_analysis`, `md_path`, `created_at` | 自动生成的周报与月报统计数据与 AI 分析文本 |

### 3.2 本地 Markdown 自动归档结构
```text
data/notes/
├── daily/
│   └── 2026-11-20.md        # 自动生成的每日复盘日记（含 YAML Frontmatter、习惯勾选状态、今日总结与暖心鼓励）
├── weekly/
│   └── 2026-W47.md          # 每周成长分析报告
└── monthly/
    └── 2026-11.md           # 每月成长分析报告
```
> 目录可直接作为 Obsidian 笔记库（Vault）的子文件夹打开，数据 100% 归你本地掌控。

### 3.3 核心 API 接口列表

| 方法与路径 | 功能说明 |
| :--- | :--- |
| `GET /api/health` | 健康检查，供 Electron 启动时确认后端就绪 |
| `WS /ws/events` | 双向实时通道：推送定时/随机冒泡触发事件、离线唤醒命中事件、桌宠表情状态切换 |
| `POST /api/chat` | 发送用户输入文本，返回回复文本、建议桌宠表情、并触发后台静默提取归档 |
| `POST /api/voice/tts` | 输入文本与音色参数，通过 `edge-tts` 生成 MP3 音频流返回 |
| `POST /api/voice/stt` | 接收前端录制的 WAV/PCM 音频片段，本地 `sherpa-onnx` 离线转文字 |
| `POST /api/voice/wakeword/toggle` | 开启/暂停后台纯本地离线唤醒词监听 |
| `GET / POST / PATCH / DELETE /api/habits` | 预设习惯与每日关注事项的增删改查 |
| `GET /api/logs?month=YYYY-MM` | 获取指定月份的每日复盘与习惯热力图数据 |
| `GET /api/logs/{date}` | 获取某日详细复盘记录与 Markdown 内容 |
| `GET / DELETE /api/memories` | 查看、管理长期记忆卡片与「小确幸罐子」历史记录 |
| `POST /api/reports/generate` | 手动或定时触发生成周报/月报分析并导出 `.md` |
| `GET /api/reports` | 获取历史周报/月报列表 |
| `GET / PUT /api/settings` | 读取与更新人设、API 配置、作息节点、随机冒泡、唤醒词与桌宠形象配置 |

---

## 4. 轻量级部署方案（Local Desktop Deployment）

本项目为**个人隐私优先的 Windows 本地桌面应用**，无需购买云服务器或 Docker 集群：

1. **开发与日常个人运行阶段（最轻量）**：
   - 前端：Node.js + Electron（开发期 `npm run dev` 一键同时拉起 Vite + Electron + 本地 Python FastAPI）。
   - 后端：独立 Python 虚拟环境（`.venv`），所有数据（SQLite 数据库、Markdown 笔记、离线语音模型）均保存在项目内或用户目录 `data/` 下，迁移电脑只需拷贝文件夹即可。
2. **成品打包阶段（一键双击使用）**：
   - 使用 `PyInstaller` 将 Python FastAPI 后端打包为单目录可执行程序，随 `electron-builder` 一起打成 Windows 安装包（`.exe`）或绿色免安装压缩包。
   - 支持在设置中勾选「Windows 开机自启 + 最小化到系统托盘」，真正成为每天自动陪伴的桌面小管家。
3. **成本预估**：
   - 服务器/数据库/存储：**¥0**（全本地）
   - 语音合成（Edge-TTS）+ 离线唤醒 & 语音识别（sherpa-onnx）：**¥0**
   - 云端大模型 API（DeepSeek / Gemini Flash 等）：个人日常使用约 **¥0 – ¥10 / 月**。
