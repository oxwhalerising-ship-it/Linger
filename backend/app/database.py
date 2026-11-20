"""
SQLite 本地数据库管理模块
-------------------------
为什么直接用 Python 内置的 sqlite3？
1. 零外部数据库服务，单文件（data/taiwanbot.db）即可完整保存所有个人记录。
2. 数据 100% 存储在本地硬盘，备份或换电脑只需复制 data/ 文件夹。
3. 开启 WAL 模式与外键约束，兼顾读写安全与并发响应速度。
"""

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Generator

# 项目根目录与本地数据目录（d:\02_TaiwanBot\data）
PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = PROJECT_ROOT / "data"
DB_PATH = DATA_DIR / "taiwanbot.db"
NOTES_DIR = DATA_DIR / "notes"
DAILY_NOTES_DIR = NOTES_DIR / "daily"
WEEKLY_NOTES_DIR = NOTES_DIR / "weekly"
MONTHLY_NOTES_DIR = NOTES_DIR / "monthly"

# 默认系统配置（首次启动自动写入 settings 表，用户后续可在设置页修改）
DEFAULT_SETTINGS: dict[str, Any] = {
    "bot_name": "灵儿",
    "persona": {
        "style": "台湾腔、俏皮可爱、有耐心、善良、积极乐观、善于鼓励与提供情绪价值",
        "catchphrases": [
            "欸～",
            "吼",
            "真的假的啦",
            "超棒的耶",
            "辛苦你了喔～",
            "你很厉害捏",
            "拍拍你",
            "休息一下下",
        ],
    },
    "llm": {
        "provider": "openai_compatible",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
        "model": "gemini-2.5-flash",
        "api_key": "",
    },
    "tts": {
        "provider": "edge_tts",
        "voice": "zh-TW-HsiaoChenNeural",
        "rate": "+0%",
        "pitch": "+0Hz",
        "enable_filler_sounds": True,
    },
    "schedule": {
        "morning_plan": {"enabled": True, "time": "08:30", "label": "早安规划"},
        "noon_checkin": {"enabled": True, "time": "12:30", "label": "午间提醒"},
        "evening_review": {"enabled": True, "time": "21:30", "label": "晚间复盘"},
        "bedtime_nudge": {"enabled": True, "time": "23:00", "label": "睡前催睡"},
        "random_bubble": {
            "enabled": True,
            "start_time": "10:00",
            "end_time": "21:00",
            "daily_count": 2,
        },
        "dnd_enabled": False,
    },
    "wakeword": {
        "enabled": False,
        "keyword": "灵儿",
    },
    "avatar": {
        "mode": "sprite_2d",
        "custom_path": "",
    },
}


def ensure_data_dirs() -> None:
    """确保 data/ 与 Markdown 笔记子目录均已创建"""
    for folder in (DATA_DIR, DAILY_NOTES_DIR, WEEKLY_NOTES_DIR, MONTHLY_NOTES_DIR):
        folder.mkdir(parents=True, exist_ok=True)


def get_connection() -> sqlite3.Connection:
    """创建一个开启外键、忙等待超时与字典行访问的 SQLite 连接"""
    conn = sqlite3.connect(DB_PATH, timeout=5.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    return conn


@contextmanager
def db_cursor() -> Generator[sqlite3.Cursor, None, None]:
    """上下文管理器：自动提交事务并在异常时回滚，避免忘记关闭连接"""
    conn = get_connection()
    try:
        cursor = conn.cursor()
        yield cursor
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    """初始化全部 7 张核心业务表，并写入默认配置"""
    ensure_data_dirs()
    now_iso = datetime.now().isoformat(timespec="seconds")

    with db_cursor() as cur:
        # 仅在初始化时开启 WAL 模式，避免每次打开连接都获取写锁
        cur.execute("PRAGMA journal_mode = WAL;")
        # 1. 系统与人设配置表
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )

        # 2. 预设行为习惯与每日关注事项表
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS habits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT '生活习惯',
                frequency TEXT NOT NULL DEFAULT 'daily',
                target_desc TEXT NOT NULL DEFAULT '',
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );
            """
        )

        # 3. 每日复盘主表（含情绪/精力分、每日小确幸 JSON、Markdown 路径）
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS daily_logs (
                date TEXT PRIMARY KEY,
                summary TEXT NOT NULL DEFAULT '',
                mood_score INTEGER,
                energy_score INTEGER,
                highlights TEXT NOT NULL DEFAULT '[]',
                md_path TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL
            );
            """
        )

        # 4. 每日习惯完成记录表（按 date + habit_id 唯一，支持白天静默记 + 晚间复盘核对更新）
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS habit_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                habit_id INTEGER NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('done', 'partial', 'missed')),
                note TEXT NOT NULL DEFAULT '',
                recorded_at TEXT NOT NULL,
                UNIQUE(date, habit_id),
                FOREIGN KEY (habit_id) REFERENCES habits(id) ON DELETE CASCADE
            );
            """
        )

        # 5. 对话历史表（统一存储文本对话 channel='text' 与语音对话 channel='voice'，支持按渠道独立检索与增删改查）
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_date TEXT NOT NULL,
                channel TEXT NOT NULL DEFAULT 'text' CHECK (channel IN ('text', 'voice')),
                role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
                content TEXT NOT NULL,
                trigger_type TEXT NOT NULL DEFAULT 'manual',
                created_at TEXT NOT NULL,
                updated_at TEXT,
                duration_ms INTEGER
            );
            """
        )

        # 兼容旧库平滑迁移：补充回复耗时、对话渠道（文本/语音）与编辑时间字段
        cur.execute("PRAGMA table_info(messages);")
        msg_cols = {row["name"] for row in cur.fetchall()}
        if "duration_ms" not in msg_cols:
            cur.execute("ALTER TABLE messages ADD COLUMN duration_ms INTEGER;")
        if "channel" not in msg_cols:
            cur.execute("ALTER TABLE messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'text';")
            # 自动把历史实时通话消息归入 voice 渠道，其余归入 text 渠道
            cur.execute(
                """
                UPDATE messages
                SET channel = CASE WHEN trigger_type = 'voice_call' THEN 'voice' ELSE 'text' END;
                """
            )
        if "updated_at" not in msg_cols:
            cur.execute("ALTER TABLE messages ADD COLUMN updated_at TEXT;")

        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_messages_channel_date
            ON messages (channel, session_date, id);
            """
        )

        # 6. 长期记忆与高光时刻表（支持跨天主动关心 & 低落时高光回溯）
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                memory_type TEXT NOT NULL CHECK (memory_type IN ('preference', 'ongoing_event', 'highlight')),
                content TEXT NOT NULL,
                follow_up_date TEXT,
                is_resolved INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            """
        )

        # 7. 周报与月报分析表
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                period_type TEXT NOT NULL CHECK (period_type IN ('weekly', 'monthly')),
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                stats_json TEXT NOT NULL DEFAULT '{}',
                ai_analysis TEXT NOT NULL DEFAULT '',
                md_path TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );
            """
        )

        # 补齐常用查询索引，避免全表扫描
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_habit_records_date
            ON habit_records (date, habit_id);
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_memories_resolved_type
            ON memories (is_resolved, memory_type, id);
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_reports_period_id
            ON reports (period_type, id);
            """
        )

        # 写入缺失的默认设置项（已存在的用户设置不会被覆盖）
        for key, value in DEFAULT_SETTINGS.items():
            cur.execute(
                """
                INSERT OR IGNORE INTO settings (key, value, updated_at)
                VALUES (?, ?, ?);
                """,
                (key, json.dumps(value, ensure_ascii=False), now_iso),
            )
