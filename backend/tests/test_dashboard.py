"""Dashboard data compatibility and cross-page contracts, using an isolated database."""
from datetime import date

from app import database
from app.routers import chat, logs, memories, reports
from app.schemas import DailyLogUpsert, MemoryCreate
from app.services import agent_brain


def test_duplicate_highlights_survive_restart(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(database, "ensure_data_dirs", lambda: None)
    monkeypatch.setattr(logs, "export_daily_markdown", lambda day: ("", ""))
    database.init_db()
    day = "2026-11-21"
    logs.upsert_daily_log(day, DailyLogUpsert(highlights=["晚风", "晚风"]))
    first, second = logs.list_highlights(day[:7])
    logs.favorite_highlight(second["id"], True)
    logs.append_highlight(day, "看书")
    database.init_db()
    items = logs.list_highlights(day[:7])
    assert [(r["id"], r["favorite"]) for r in items[:2]] == [(first["id"], 0), (second["id"], 1)]
    assert items[2]["content"] == "看书"
    assert reports.insights("weekly", date.fromisoformat(day))["highlights"] == [
        {"date": day, "text": text} for text in ["晚风", "晚风", "看书"]
    ]


def test_text_voice_share_only_their_thread(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(database, "ensure_data_dirs", lambda: None)
    monkeypatch.setattr(agent_brain, "_schedule_markdown_export", lambda day: "")
    database.init_db()
    day = "2026-11-21"
    agent_brain.save_text_chat_messages(day, "旧消息", "好")
    source = agent_brain.save_text_chat_messages(day, "散步", "好", thread_id="one")
    agent_brain.save_voice_call_messages(day, "晚风", "记住了", thread_id="one")
    agent_brain.save_text_chat_messages(day, "工作", "好", thread_id="two")
    assert [r["title"] for r in chat.list_threads()] == ["工作", "散步"]
    assert [r["channel"] for r in chat.thread_messages("one")["messages"]] == ["text","text","voice","voice"]
    assert [r["content"] for r in agent_brain._load_daily_context(day,"two")["recent_messages"]] == ["工作","好"]
    agent_brain._apply_extracted_updates(day, {"new_memories":[{"memory_type":"preference","content":"晚风"}]}, source)
    item = memories.list_memories(None)[0]
    assert item.source_message_id == source
    again = agent_brain._apply_extracted_updates(day, {"new_memories":[{"memory_type":"preference","content":"重复请求"}]}, source)
    assert again["applied"]["new_memories"][0]["content"] == "晚风"
    assert len(memories.list_memories(None)) == 1
    assert chat.thread_messages("one")["messages"][1]["receipt"]
    updated = memories.edit_memory(item.id, MemoryCreate(memory_type="preference",content="河边晚风"))
    assert updated.source_message_id == source
    chat.delete_message(source)
    assert memories.list_memories(None)[0].source_message_id is None

