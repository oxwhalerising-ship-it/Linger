"""
Pydantic 数据模型定义（请求参数校验与响应序列化）
------------------------------------------------
用于在 FastAPI 接口边界自动校验数据格式，防止非法日期、越界评分写入数据库。
"""

from typing import Any, Literal, Optional
from pydantic import BaseModel, Field


# ==================== 习惯配置（Habits） ====================

class HabitCreate(BaseModel):
    """创建新习惯的请求体"""
    title: str = Field(..., min_length=1, max_length=100, description="习惯名称，如：喝水 2000ml")
    category: str = Field(default="生活习惯", max_length=40, description="分类，如：作息/运动/学习/健康")
    frequency: str = Field(default="daily", description="频率，默认 daily")
    target_desc: str = Field(default="", max_length=200, description="具体目标说明，供灵儿提问参考")


class HabitUpdate(BaseModel):
    """部分更新习惯的请求体"""
    title: Optional[str] = Field(default=None, min_length=1, max_length=100)
    category: Optional[str] = Field(default=None, max_length=40)
    frequency: Optional[str] = None
    target_desc: Optional[str] = Field(default=None, max_length=200)
    is_active: Optional[bool] = None


class HabitOut(BaseModel):
    """习惯返回结构"""
    id: int
    title: str
    category: str
    frequency: str
    target_desc: str
    is_active: bool
    created_at: str


# ==================== 每日复盘与习惯记录（Daily Logs） ====================

class HabitRecordUpsert(BaseModel):
    """写入或更新某日某条习惯完成状态的请求体"""
    habit_id: int
    status: Literal["done", "partial", "missed"]
    note: str = Field(default="", max_length=300, description="灵儿从聊天中提取的备注或用户补充")


class HabitRecordOut(BaseModel):
    """带习惯标题的当日打卡记录"""
    habit_id: int
    habit_title: str
    category: str
    status: Literal["done", "partial", "missed"]
    note: str
    recorded_at: str


class DailyLogUpsert(BaseModel):
    """更新每日复盘总结、情绪/精力评分及「每日小确幸」的请求体"""
    summary: Optional[str] = Field(default=None, description="今日复盘摘要")
    mood_score: Optional[int] = Field(default=None, ge=1, le=5, description="今日情绪评分（1-5）")
    energy_score: Optional[int] = Field(default=None, ge=1, le=5, description="今日精力评分（1-5）")
    highlights: Optional[list[str]] = Field(default=None, description="今日小确幸/高光列表")


class DailyLogOut(BaseModel):
    """某日完整复盘详情（含打卡记录与 Markdown 文件内容）"""
    date: str
    summary: str
    mood_score: Optional[int]
    energy_score: Optional[int]
    highlights: list[str]
    md_path: str
    updated_at: str
    habit_records: list[HabitRecordOut]
    markdown_content: str


# ==================== 长期记忆与高光回溯（Memories） ====================

class MemoryCreate(BaseModel):
    """新增一条长期记忆或高光时刻"""
    memory_type: Literal["preference", "ongoing_event", "highlight"] = Field(
        ..., description="preference=个人喜好, ongoing_event=近期需关心事件, highlight=高光时刻"
    )
    content: str = Field(..., min_length=1, max_length=500, description="记忆内容")
    follow_up_date: Optional[str] = Field(default=None, description="建议跟进日期 YYYY-MM-DD（可选）")


class MemoryOut(BaseModel):
    source_message_id: Optional[int] = None
    """长期记忆返回结构"""
    id: int
    memory_type: Literal["preference", "ongoing_event", "highlight"]
    content: str
    follow_up_date: Optional[str]
    is_resolved: bool
    created_at: str


# ==================== 系统设置（Settings） ====================

class SettingsUpdate(BaseModel):
    """批量更新配置项（键值对形式）"""
    settings: dict[str, Any]


# ==================== 对话与台湾腔语音（Chat & Voice） ====================

class ChatRequest(BaseModel):
    thread_id: Optional[str] = Field(default=None, max_length=80)
    """发送一轮对话给台湾腔小管家的请求体"""
    message: str = Field(..., min_length=1, max_length=2000, description="用户说的话或输入的文字")
    date: Optional[str] = Field(default=None, description="指定日期 YYYY-MM-DD，默认今天")
    mode: Literal[
        "normal",
        "evening_review",
        "morning_plan",
        "noon_checkin",
        "bedtime_nudge",
        "random_bubble",
    ] = Field(default="normal", description="当前对话场景模式")
    trigger_type: Literal["manual", "schedule", "random", "wakeword"] = Field(
        default="manual", description="触发来源"
    )


class MessageCreate(BaseModel):
    """手动新增一条历史对话消息（支持文本对话 / 语音对话分类）"""
    session_date: Optional[str] = Field(default=None, description="日期 YYYY-MM-DD，默认今天")
    channel: Literal["text", "voice"] = Field(default="text", description="渠道：text=文本对话, voice=语音对话")
    role: Literal["user", "assistant"] = Field(default="user", description="发言角色：user=我, assistant=灵儿")
    content: str = Field(..., min_length=1, max_length=4000, description="消息内容")
    created_at: Optional[str] = Field(default=None, description="可选时间 ISO 字符串")


class MessageUpdate(BaseModel):
    """编辑单条历史对话消息"""
    content: Optional[str] = Field(default=None, min_length=1, max_length=4000, description="修改后的消息内容")
    role: Optional[Literal["user", "assistant"]] = Field(default=None, description="修改角色")
    channel: Optional[Literal["text", "voice"]] = Field(default=None, description="切换文本/语音分类")
    session_date: Optional[str] = Field(default=None, description="调整归属日期 YYYY-MM-DD")


class MessageBatchDeleteRequest(BaseModel):
    """批量删除历史消息（支持按 ID 列表勾选删除，或按日期+渠道清理）"""
    ids: Optional[list[int]] = Field(default=None, description="要删除的消息 ID 列表")
    date: Optional[str] = Field(default=None, description="按日期清理 YYYY-MM-DD")
    channel: Literal["all", "text", "voice"] = Field(default="all", description="按渠道范围清理")


class TTSRequest(BaseModel):
    """台湾腔语音合成请求体"""
    text: str = Field(..., min_length=1, max_length=1000, description="要朗读的台湾腔短句")
    provider: Optional[str] = Field(default=None, description="指定语音引擎（edge_tts / fish_audio），不传则读取设置页")
    voice: Optional[str] = Field(default=None, description="Edge-TTS 音色 ID，不传则读取设置页默认音色")
    rate: Optional[str] = Field(default=None, description="语速，如 +5%、-5%")
    pitch: Optional[str] = Field(default=None, description="音调，如 +0Hz、+2Hz")
    fish_api_key: Optional[str] = Field(default=None, description="试听时临时覆盖 Fish Audio API Key")
    fish_reference_id: Optional[str] = Field(default=None, description="试听时临时覆盖 Fish Audio 音色 reference_id")
    fish_model: Optional[str] = Field(default=None, description="试听时临时覆盖 Fish Audio 模型版本")


# ==================== 周报 / 月报分析（Reports） ====================

class ReportGenerateRequest(BaseModel):
    """生成周期性复盘报告的请求体"""
    period_type: Literal["weekly", "monthly"] = Field(
        default="weekly", description="weekly=近7天周报，monthly=当月月报"
    )
    end_date: Optional[str] = Field(
        default=None, description="统计截止日期 YYYY-MM-DD，不传默认今天"
    )


# ==================== 全天作息调度与主动陪伴（Schedule） ====================

class ScheduleTriggerRequest(BaseModel):
    """模拟触发指定作息节点或随机冒泡的请求体"""
    event_type: Literal[
        "morning_plan",
        "noon_checkin",
        "evening_review",
        "bedtime_nudge",
        "random_bubble",
    ] = Field(default="random_bubble")


class ScheduleSnoozeRequest(BaseModel):
    """「稍后再聊」延后提醒请求体"""
    event_type: Literal[
        "morning_plan",
        "noon_checkin",
        "evening_review",
        "bedtime_nudge",
        "random_bubble",
    ] = Field(default="random_bubble")
    delay_minutes: int = Field(default=15, ge=1, le=180, description="延后分钟数，默认 15 分钟")


class DndToggleRequest(BaseModel):
    """一键切换免打扰开关"""
    enabled: bool


# ==================== 纯本地离线语音唤醒（Wakeword KWS） ====================

class WakewordToggleRequest(BaseModel):
    """开启/关闭本地离线语音唤醒及自定义中文唤醒词"""
    enabled: bool
    keyword: Optional[str] = Field(default=None, min_length=1, max_length=20, description="自定义中文唤醒词，如：灵儿")


# ==================== 任务与番茄钟 ====================

class TaskCreate(BaseModel):
    """记下一件一次性的事。重复的事请用习惯。"""
    title: str = Field(..., min_length=1, max_length=200)
    notes: str = Field(default="", max_length=1000)
    important: bool = False
    due_date: Optional[str] = Field(default=None, description="YYYY-MM-DD，空表示先放下、不排进今天")


class TaskUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    notes: Optional[str] = Field(default=None, max_length=1000)
    important: Optional[bool] = None
    due_date: Optional[str] = None
    status: Optional[Literal["open", "done"]] = None


class TaskOut(BaseModel):
    id: int
    title: str
    notes: str
    important: bool
    due_date: Optional[str]
    status: Literal["open", "done"]
    completed_at: Optional[str]
    created_at: str


class FocusSessionCreate(BaseModel):
    client_id: str = Field(..., min_length=8, max_length=80)
    task_id: Optional[int] = None
    kind: Literal["focus", "break"]
    planned_seconds: int = Field(..., ge=1, le=28800)
    actual_seconds: int = Field(..., ge=0, le=28800)
    started_at: str = Field(..., min_length=10, max_length=40)
    session_date: str
    completed: bool = True


class FocusSessionOut(BaseModel):
    id: int
    task_id: Optional[int]
    task_title: Optional[str]
    kind: Literal["focus", "break"]
    planned_seconds: int
    actual_seconds: int
    started_at: str
    ended_at: str
    session_date: str
    completed: bool


class FocusDayOut(BaseModel):
    date: str
    focus_count: int
    focus_minutes: int
    sessions: list[FocusSessionOut]


class FocusRecordDay(BaseModel):
    date: str
    sessions: list[FocusSessionOut]


class FocusOverviewOut(BaseModel):
    today_count: int
    today_seconds: int
    total_count: int
    total_seconds: int
    days: list[FocusRecordDay]


class HabitDayMark(BaseModel):
    date: str
    status: Optional[Literal["done", "partial", "missed"]] = None


class HabitBoardItem(HabitOut):
    today_status: Optional[Literal["done", "partial", "missed"]] = None
    streak: int
    week: list[HabitDayMark]


class HabitBoardOut(BaseModel):
    date: str
    items: list[HabitBoardItem]

