"""日记核心的回归测试：JSON 解析、习惯提取、Markdown、旧消息渠道迁移、听写顺序和本机令牌。"""

from __future__ import annotations

import asyncio
import json
import sqlite3

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient


@pytest.fixture
def temp_data(monkeypatch, tmp_path):
    import app.database as database
    import app.services.agent_brain as brain
    import app.services.markdown_exporter as exporter
    from app.core.settings_store import invalidate_settings_cache

    data = tmp_path / "data"
    daily = data / "notes" / "daily"
    notes = data / "notes"
    monkeypatch.setattr(database, "DATA_DIR", data)
    monkeypatch.setattr(database, "DB_PATH", data / "taiwanbot.db")
    monkeypatch.setattr(database, "NOTES_DIR", notes)
    monkeypatch.setattr(database, "DAILY_NOTES_DIR", daily)
    monkeypatch.setattr(database, "WEEKLY_NOTES_DIR", notes / "weekly")
    monkeypatch.setattr(database, "MONTHLY_NOTES_DIR", notes / "monthly")
    monkeypatch.setattr(exporter, "DAILY_NOTES_DIR", daily)
    monkeypatch.setattr(
        brain,
        "_schedule_markdown_export",
        lambda date_str: str(daily / f"{date_str}.md"),
    )
    invalidate_settings_cache()
    database.init_db()
    invalidate_settings_cache()
    return {"data": data, "daily": daily, "db": data / "taiwanbot.db"}


def test_parse_llm_json_accepts_fence_and_plain_text():
    from app.services.agent_brain import _parse_llm_json

    fenced = _parse_llm_json('说明一下\n```json\n{"reply": "欸～辛苦了喔", "emotion": "happy"}\n```')
    assert fenced["reply"] == "欸～辛苦了喔"
    assert fenced["emotion"] == "happy"

    raw = _parse_llm_json('{"reply": "喝水了耶", "extracted": {"mood_score": 4}}')
    assert raw["extracted"]["mood_score"] == 4

    fallback = _parse_llm_json("今天有点累")
    assert fallback["reply"] == "今天有点累"
    assert fallback["emotion"] == "thinking"
    assert fallback["extracted"] == {}

    empty = _parse_llm_json("   ")
    assert "放空" in empty["reply"]


def test_habit_extraction_skips_guesses_and_writes_markdown(temp_data, monkeypatch):
    import app.database as database
    import app.services.agent_brain as brain
    import app.services.markdown_exporter as exporter

    def export_now(date_str: str) -> str:
        path, _text = exporter.export_daily_markdown(date_str)
        return path

    monkeypatch.setattr(brain, "_schedule_markdown_export", export_now)

    with database.db_cursor() as cur:
        cur.execute(
            """
            INSERT INTO habits (title, category, frequency, target_desc, is_active, created_at)
            VALUES ('喝水', '生活习惯', 'daily', '', 1, '2026-11-21T00:00:00');
            """
        )
        habit_id = cur.lastrowid

    applied = brain._apply_extracted_updates(
        "2026-11-21",
        {
            "habit_updates": [
                {"habit_id": 99999, "status": "done", "note": "不存在"},
                {"habit_id": True, "status": "done", "note": "布尔值不是 id"},
                {"habit_id": habit_id, "status": "maybe", "note": "非法状态"},
                {"habit_id": habit_id, "status": "done", "note": "下午喝了"},
            ],
            "mood_score": 9,
            "energy_score": 4,
            "daily_summary_append": "下午把水喝完了",
            "new_highlights": ["喝到冰奶茶", "喝到冰奶茶"],
            "new_memories": [
                {"memory_type": "gossip", "content": "不该入库"},
                {"memory_type": "preference", "content": "喜欢冰的"},
            ],
        },
    )["applied"]

    assert applied["habit_updates"] == [
        {"habit_id": habit_id, "title": "喝水", "status": "done", "note": "下午喝了"}
    ]
    assert applied["mood_score"] is None
    assert applied["energy_score"] == 4
    assert applied["new_highlights"] == ["喝到冰奶茶"]
    assert applied["new_memories"] == [{"memory_type": "preference", "content": "喜欢冰的"}]

    brain._apply_extracted_updates(
        "2026-11-21",
        {"new_highlights": ["喝到冰奶茶"], "daily_summary_append": "下午把水喝完了"},
    )
    with database.db_cursor() as cur:
        cur.execute("SELECT highlights, summary, mood_score FROM daily_logs WHERE date = '2026-11-21';")
        row = cur.fetchone()
    assert json.loads(row["highlights"]) == ["喝到冰奶茶"]
    assert row["summary"].count("下午把水喝完了") == 1
    assert row["mood_score"] is None

    markdown = (temp_data["daily"] / "2026-11-21.md").read_text(encoding="utf-8")
    assert "tags:" in markdown
    assert "  - linger" in markdown
    assert "喝水" in markdown
    assert "喝到冰奶茶" in markdown
    assert "下午把水喝完了" in markdown


def test_old_messages_gain_channel_on_migrate(temp_data):
    import app.database as database

    database.DB_PATH.unlink()
    conn = sqlite3.connect(database.DB_PATH)
    conn.execute(
        """
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_date TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            trigger_type TEXT NOT NULL DEFAULT 'manual',
            created_at TEXT NOT NULL
        );
        """
    )
    conn.executemany(
        "INSERT INTO messages (session_date, role, content, trigger_type, created_at) VALUES (?, ?, ?, ?, ?);",
        [
            ("2026-11-20", "user", "打电话", "voice_call", "2026-11-20T10:00:00"),
            ("2026-11-20", "assistant", "文字", "manual", "2026-11-20T10:00:01"),
        ],
    )
    conn.commit()
    conn.close()

    database.init_db()
    with database.db_cursor() as cur:
        cur.execute("SELECT trigger_type, channel FROM messages ORDER BY id ASC;")
        rows = [dict(row) for row in cur.fetchall()]
        cur.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_channel_date';"
        )
        index = cur.fetchone()
    assert rows == [
        {"trigger_type": "voice_call", "channel": "voice"},
        {"trigger_type": "manual", "channel": "text"},
    ]
    assert index is not None


def test_text_chat_emits_sentence_before_done(temp_data):
    from app.services.agent_brain import iter_text_chat_events

    async def collect():
        events = []
        async for event, data in iter_text_chat_events("今天喝水了", mode="normal"):
            events.append((event, data))
        return events

    events = asyncio.run(collect())
    names = [name for name, _data in events]
    assert names[0] == "sentence"
    assert "reply" in names
    assert names.index("reply") < names.index("done")
    assert "喝水" in events[0][1]["text"] or "API" in events[-1][1]["reply"]


def test_stt_prefers_sensevoice_and_ignores_cloud():
    from app.services.stt_service import choose_stt_engine

    assert choose_stt_engine(sherpa_ready=True) == "sherpa-onnx"
    assert choose_stt_engine(sherpa_ready=False) == "none"


def test_stt_model_scan_prefers_sensevoice_small(tmp_path, monkeypatch):
    from app.services import stt_service

    asr = tmp_path / "asr"
    other = asr / "some-paraformer"
    sense = asr / "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
    other.mkdir(parents=True)
    sense.mkdir(parents=True)
    (other / "tokens.txt").write_text("a", encoding="utf-8")
    (other / "model.int8.onnx").write_bytes(b"x")
    (sense / "tokens.txt").write_text("a", encoding="utf-8")
    (sense / "model.onnx").write_bytes(b"y")
    (sense / "model.int8.onnx").write_bytes(b"z")
    monkeypatch.setattr(stt_service, "ASR_MODEL_DIR", asr)

    found = stt_service._find_asr_model_files()

    assert found is not None
    assert found["dir"] == sense
    assert found["model"].name == "model.int8.onnx"


def test_redact_strips_api_keys_from_logs():
    from app.core.logging import redact_secrets

    leaked = redact_secrets('provider failed api_key="sk-abcdefghijklmnopqrstuvwxyz" AIzaSyABCDEFGHIJ0123456789')
    assert "sk-" not in leaked
    assert "AIza" not in leaked
    assert "***" in leaked


def test_local_token_blocks_http_and_allows_websocket(monkeypatch, tmp_path):
    import app.database as database
    from app.core.local_auth import (
        LocalTokenMiddleware,
        accept_authorized_websocket,
        ensure_local_token,
        reset_token_cache,
    )

    monkeypatch.setattr(database, "DATA_DIR", tmp_path)
    reset_token_cache()
    token = ensure_local_token()

    app = FastAPI()
    app.add_middleware(LocalTokenMiddleware)

    @app.get("/api/health")
    def health():
        return {"ok": True}

    @app.websocket("/ws/events")
    async def events(websocket: WebSocket):
        if not await accept_authorized_websocket(websocket):
            return
        await websocket.send_json({"type": "connected"})

    client = TestClient(app)
    assert client.get("/api/health").status_code == 401
    assert client.options("/api/health").status_code != 401
    ok = client.get("/api/health", headers={"X-Linger-Token": token})
    assert ok.status_code == 200

    with pytest.raises(Exception):
        with client.websocket_connect("/ws/events"):
            pass

    with client.websocket_connect(
        "/ws/events",
        subprotocols=[f"linger-auth.{token}"],
    ) as websocket:
        assert websocket.receive_json()["type"] == "connected"
