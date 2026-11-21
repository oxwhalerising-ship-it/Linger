"""免打扰开启时必须关掉离线唤醒，并且在免打扰期间不能再打开。"""

from __future__ import annotations

import asyncio

import pytest

from app.core.settings_store import invalidate_settings_cache
from app.schemas import DndToggleRequest, SettingsUpdate, WakewordToggleRequest


@pytest.fixture
def isolated_db(monkeypatch, tmp_path):
    import app.database as database

    data = tmp_path / "data"
    monkeypatch.setattr(database, "DATA_DIR", data)
    monkeypatch.setattr(database, "DB_PATH", data / "taiwanbot.db")
    monkeypatch.setattr(database, "NOTES_DIR", data / "notes")
    monkeypatch.setattr(database, "DAILY_NOTES_DIR", data / "notes" / "daily")
    monkeypatch.setattr(database, "WEEKLY_NOTES_DIR", data / "notes" / "weekly")
    monkeypatch.setattr(database, "MONTHLY_NOTES_DIR", data / "notes" / "monthly")
    invalidate_settings_cache()
    database.init_db()
    invalidate_settings_cache()
    yield
    from app.services.wakeword_service import wakeword_engine

    wakeword_engine.toggle(False)
    invalidate_settings_cache()


def test_enabling_dnd_turns_wakeword_off_and_keeps_it_off(isolated_db):
    from app.routers.schedule import toggle_dnd
    from app.services.scheduler_service import load_schedule_settings
    from app.services.wakeword_service import wakeword_engine

    wakeword_engine.toggle(True, "灵儿")
    assert wakeword_engine.get_status()["enabled"] is True

    turned_on = asyncio.run(toggle_dnd(DndToggleRequest(enabled=True)))
    assert turned_on["dnd_enabled"] is True
    assert turned_on["wakeword_disabled"] is True
    assert wakeword_engine.get_status()["enabled"] is False
    assert wakeword_engine.get_status()["listening"] is False

    blocked = asyncio.run(wakeword_engine.broadcast_wakeup("灵儿", simulated=True))
    assert blocked["triggered"] is False
    assert blocked["reason"] == "dnd_enabled"

    turned_off = asyncio.run(toggle_dnd(DndToggleRequest(enabled=False)))
    assert turned_off["dnd_enabled"] is False
    assert turned_off["wakeword_disabled"] is False
    assert load_schedule_settings()["dnd_enabled"] is False
    assert wakeword_engine.get_status()["enabled"] is False


def test_wakeword_stays_off_while_dnd_is_on(isolated_db):
    from app.routers.voice import toggle_wakeword
    from app.services.scheduler_service import set_dnd_enabled
    from app.services.wakeword_service import wakeword_engine

    set_dnd_enabled(True)
    status = asyncio.run(toggle_wakeword(WakewordToggleRequest(enabled=True, keyword="灵儿")))
    assert status["blocked_by_dnd"] is True
    assert status["enabled"] is False

    set_dnd_enabled(False)
    opened = asyncio.run(toggle_wakeword(WakewordToggleRequest(enabled=True, keyword="灵儿")))
    assert opened.get("blocked_by_dnd") is not True
    assert opened["enabled"] is True


def test_startup_does_not_revive_wakeword_during_dnd(isolated_db):
    from app.services.scheduler_service import set_dnd_enabled
    from app.services.wakeword_service import wakeword_engine

    wakeword_engine.toggle(True, "灵儿")
    set_dnd_enabled(True)
    status = wakeword_engine.start_if_enabled(None)
    assert status["enabled"] is False
    assert status["listening"] is False

    set_dnd_enabled(False)
    wakeword_engine.toggle(True, "灵儿")
    kept = wakeword_engine.start_if_enabled(None)
    assert kept["enabled"] is True


def test_settings_save_that_enables_dnd_also_disables_wakeword(isolated_db):
    from app.routers.settings import update_settings
    from app.services.wakeword_service import wakeword_engine

    wakeword_engine.toggle(True, "灵儿")
    asyncio.run(update_settings(SettingsUpdate(settings={"schedule": {"dnd_enabled": True}})))
    assert wakeword_engine.get_status()["enabled"] is False

    asyncio.run(
        update_settings(
            SettingsUpdate(settings={"wakeword": {"enabled": True, "keyword": "灵儿"}}),
        )
    )
    assert wakeword_engine.get_status()["enabled"] is False
