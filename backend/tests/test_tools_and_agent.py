"""灵儿统一 Tool Calling、MCP 适配层、双向番茄钟控制与流式编排回归测试。"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.services.event_bus import EventBusManager
from app.services.tools import (
    LingerMCPServerAdapter,
    MCPProviderBase,
    ToolContext,
    ToolExecutionResult,
    ToolRegistry,
    ToolSpec,
    mount_mcp_provider,
    register_builtin_tools,
)


@pytest.fixture
def isolated_env(tmp_path, monkeypatch):
    import app.database as database
    import app.services.agent_brain as brain
    import app.services.llm.client as llm_client
    import app.services.markdown_exporter as exporter
    import app.services.tools.builtin_tools as builtin_tools
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
    monkeypatch.setattr(brain, "DATA_DIR", data)
    monkeypatch.setattr(
        brain,
        "_schedule_markdown_export",
        lambda date_str: str(daily / f"{date_str}.md"),
    )
    monkeypatch.setattr(
        builtin_tools,
        "_safe_export_md",
        lambda date_str: exporter.export_daily_markdown(date_str)[0],
    )
    llm_client._TOOL_SUPPORT_CACHE.clear()
    llm_client._FAST_THINK_MODE_CACHE.clear()
    invalidate_settings_cache()
    database.init_db()
    invalidate_settings_cache()
    return {"data": data, "daily": daily, "db": data / "taiwanbot.db"}


class _FakeWebSocket:
    """模拟前端 `/ws/events` 连接，可记录收到的事件并自动回复 `ui_command_ack`。"""

    def __init__(self, bus: EventBusManager, responder=None) -> None:
        self.bus = bus
        self.responder = responder
        self.sent: list[dict[str, Any]] = []

    async def accept(self) -> None:
        return None

    async def send_json(self, event: dict[str, Any]) -> None:
        self.sent.append(event)
        if event.get("type") == "ui_command" and self.responder is not None:
            ack = self.responder(event)
            if ack is not None:
                self.bus.resolve_ui_ack(event["command_id"], ack)


def test_registry_security_and_mcp_adapter(isolated_env):
    registry = ToolRegistry()
    register_builtin_tools(registry)

    names = [spec.name for spec in registry.list_specs()]
    assert "record_daily_log" in names
    assert "control_focus_timer" in names
    assert "open_dashboard_page" in names
    # 安全边界：第一期绝不注册任何删除类工具
    assert not any("delete" in name or "remove" in name for name in names)
    assert all(not spec.destructive for spec in registry.list_specs())

    with pytest.raises(ValueError):
        registry.register(
            ToolSpec(
                name="delete_everything",
                description="forbidden",
                parameters={"type": "object", "properties": {}},
                handler=lambda a, c: ToolExecutionResult(ok=True, tool_name="delete_everything"),
                category="danger",
                destructive=True,
            )
        )

    # OpenAI Schema 导出
    openai_tools = registry.to_openai_tools()
    assert len(openai_tools) == len(names)
    assert openai_tools[0]["type"] == "function"
    assert "parameters" in openai_tools[0]["function"]

    # MCP Server 协议适配（initialize / tools/list / tools/call）
    adapter = LingerMCPServerAdapter(registry)

    async def _run_mcp():
        init_res = await adapter.handle_jsonrpc({"jsonrpc": "2.0", "id": 1, "method": "initialize"})
        assert init_res["result"]["serverInfo"]["name"] == "linger-bot"

        list_res = await adapter.handle_jsonrpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        mcp_tools = list_res["result"]["tools"]
        assert len(mcp_tools) == len(names)
        assert all("inputSchema" in t for t in mcp_tools)

        call_res = await adapter.handle_jsonrpc(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "create_task",
                    "arguments": {"title": "MCP 测试任务", "important": True},
                },
            }
        )
        assert call_res["result"]["isError"] is False
        payload = json.loads(call_res["result"]["content"][0]["text"])
        assert payload["ok"] is True
        assert payload["task"]["title"] == "MCP 测试任务"

        # 外部 MCP Provider 挂载测试
        class _DummyWeatherMCP(MCPProviderBase):
            server_name = "weather"

            async def list_tools(self):
                return [
                    {
                        "name": "get_forecast",
                        "description": "查询天气",
                        "inputSchema": {"type": "object", "properties": {"city": {"type": "string"}}},
                    }
                ]

            async def call_tool(self, name: str, arguments: dict[str, Any]):
                return {"city": arguments.get("city"), "temp": 24}

        mounted = await mount_mcp_provider(registry, _DummyWeatherMCP())
        assert mounted == ["weather__get_forecast"]
        res = await registry.execute(
            "weather__get_forecast",
            {"city": "Taipei"},
            ToolContext(date_str="2026-11-22", bus=EventBusManager()),
        )
        assert res.ok is True
        assert res.data["temp"] == 24

    asyncio.run(_run_mcp())


def test_builtin_domain_tools_end_to_end(isolated_env):
    registry = ToolRegistry()
    register_builtin_tools(registry)
    bus = EventBusManager()
    ws = _FakeWebSocket(bus)
    ctx = ToolContext(date_str="2026-11-22", bus=bus)

    async def _run():
        await bus.connect(ws, role="dashboard")

        # 1. 记录今日日记（摘要 + 心情 + 精力 + 小确幸）
        r_log = await registry.execute(
            "record_daily_log",
            {
                "summary_append": "上午做完了灵儿工具调用架构设计，下午喝了冰拿铁。",
                "mood_score": 5,
                "energy_score": 4,
                "highlights": ["架构设计一次通过"],
            },
            ctx,
        )
        assert r_log.ok is True
        assert "已记录到今日日记" in (r_log.badge or "")
        assert {"summary", "mood_score", "energy_score", "highlights"} <= r_log.archive_skip_keys
        assert (isolated_env["daily"] / "2026-11-22.md").exists()

        # 2. 新建习惯 + 模糊名称打卡 + 查习惯板
        r_hab = await registry.execute(
            "create_habit",
            {"title": "多喝水", "category": "生活习惯", "target_desc": "2000ml"},
            ctx,
        )
        assert r_hab.ok is True
        r_check = await registry.execute(
            "checkin_habit",
            {"habit_title": "喝水", "status": "done", "note": "喝满两大杯"},
            ctx,
        )
        assert r_check.ok is True
        assert "多喝水" in (r_check.badge or "")
        r_list_hab = await registry.execute("list_habits", {}, ctx)
        assert r_list_hab.data["habits"][0]["today_status"] == "done"
        assert r_list_hab.data["habits"][0]["streak"] == 1

        # 3. 待办新增、查询、完成与顺延
        r_task = await registry.execute(
            "create_task",
            {"title": "整理周报", "important": True},
            ctx,
        )
        assert r_task.ok is True
        task_id = r_task.data["task"]["id"]
        r_dup = await registry.execute("create_task", {"title": "整理周报"}, ctx)
        assert r_dup.data["already_exists"] is True

        r_postpone = await registry.execute(
            "update_task",
            {"task_title": "周报", "postpone": True},
            ctx,
        )
        assert r_postpone.ok is True
        assert r_postpone.data["task"]["due_date"] == "2026-11-23"

        r_done = await registry.execute(
            "update_task",
            {"task_id": task_id, "status": "done"},
            ctx,
        )
        assert r_done.ok is True
        assert r_done.data["task"]["status"] == "done"

        # 4. 长期记忆保存与关键词查询
        r_mem = await registry.execute(
            "save_memory",
            {"content": "喜欢喝少冰拿铁", "memory_type": "preference"},
            ctx,
        )
        assert r_mem.ok is True
        r_mem_list = await registry.execute("list_memories", {"query": "拿铁"}, ctx)
        assert len(r_mem_list.data["memories"]) == 1

        # 确认 data_changed 广播送达前端面板
        changed_events = [e for e in ws.sent if e.get("type") == "data_changed"]
        assert len(changed_events) >= 4

    asyncio.run(_run())


def test_focus_timer_ack_conflict_and_task_autobind(isolated_env):
    registry = ToolRegistry()
    register_builtin_tools(registry)

    async def _run():
        # 1. 无面板连接时优雅报错
        empty_bus = EventBusManager()
        ctx_offline = ToolContext(date_str="2026-11-22", bus=empty_bus)
        res_offline = await registry.execute(
            "control_focus_timer", {"action": "start", "minutes": 30}, ctx_offline
        )
        assert res_offline.ok is False
        assert "尚未连接" in (res_offline.error or "")

        # 2. 创建今日待办，测试自动绑定 + 自定义 35 分钟 + ACK 成功
        bus = EventBusManager()
        ctx = ToolContext(date_str="2026-11-22", bus=bus)
        t_res = await registry.execute("create_task", {"title": "写项目设计文档"}, ctx)
        task_id = t_res.data["task"]["id"]

        captured_cmd: list[dict[str, Any]] = []

        def _ok_responder(evt: dict[str, Any]):
            captured_cmd.append(evt)
            p = evt["payload"]
            return {
                "ok": True,
                "result": {
                    "conflict": False,
                    "state": {
                        "mode": p.get("mode", "pomodoro"),
                        "phase": "focus",
                        "running": True,
                        "remaining": (p.get("minutes") or 25) * 60,
                        "focusMinutes": p.get("minutes") or 25,
                        "taskId": p.get("task_id"),
                        "taskTitle": p.get("task_title", ""),
                    },
                },
            }

        ws = _FakeWebSocket(bus, responder=_ok_responder)
        await bus.connect(ws, role="dashboard")

        res_start = await registry.execute(
            "control_focus_timer",
            {"action": "start", "minutes": 35, "task_title": "设计文档"},
            ctx,
        )
        assert res_start.ok is True
        assert res_start.data["bound_task_id"] == task_id
        assert res_start.data["bound_task_title"] == "写项目设计文档"
        assert "35 分钟番茄钟" in (res_start.badge or "")
        assert "写项目设计文档" in (res_start.badge or "")
        assert captured_cmd[0]["payload"]["open_panel"] is False

        # 3. 冲突保护：已有计时在跑且 force=false 时拒绝覆盖并返回当前剩余时间
        ws.responder = lambda evt: {
            "ok": False,
            "result": {
                "conflict": True,
                "state": {
                    "mode": "pomodoro",
                    "phase": "focus",
                    "running": True,
                    "remaining": 720,
                    "taskTitle": "写项目设计文档",
                },
            },
            "error": "已有计时在运行",
        }
        res_conflict = await registry.execute(
            "control_focus_timer",
            {"action": "start", "minutes": 25},
            ctx,
        )
        assert res_conflict.ok is False
        assert res_conflict.data["conflict"] is True
        assert res_conflict.data["remaining_minutes"] == 12
        assert res_conflict.badge is None

    asyncio.run(_run())


def test_stream_agent_turn_tool_loop_and_model_fallback(isolated_env, monkeypatch):
    import app.services.agent_brain as brain
    import app.services.llm.client as llm_client

    # 注入测试用 LLM 配置
    monkeypatch.setattr(
        brain,
        "_load_settings_dict",
        lambda: {
            "bot_name": "灵儿",
            "llm": {
                "api_key": "sk-test-key",
                "base_url": "https://mock.llm.local/v1",
                "model": "mock-tool-model",
            },
        },
    )

    # 模拟 2 轮流式响应：第 1 轮分片输出两个并行 tool_calls，第 2 轮流式输出台湾腔确认语
    round_counter = {"n": 0}

    async def _fake_stream_completion(client, base_kwargs, base_url, model_name):
        round_counter["n"] += 1
        call_no = round_counter["n"]

        async def _gen():
            if call_no == 1:
                assert "tools" in base_kwargs
                # 模拟 OpenAI 分片 tool_calls
                yield SimpleNamespace(
                    choices=[
                        SimpleNamespace(
                            delta=SimpleNamespace(
                                content=None,
                                tool_calls=[
                                    SimpleNamespace(
                                        index=0,
                                        id="call_1",
                                        function=SimpleNamespace(
                                            name="record_daily_log",
                                            arguments='{"summary_append": "今天跑完步',
                                        ),
                                    )
                                ],
                            )
                        )
                    ]
                )
                yield SimpleNamespace(
                    choices=[
                        SimpleNamespace(
                            delta=SimpleNamespace(
                                content=None,
                                tool_calls=[
                                    SimpleNamespace(
                                        index=0,
                                        id=None,
                                        function=SimpleNamespace(
                                            name=None,
                                            arguments='还写完代码了", "mood_score": 5}',
                                        ),
                                    ),
                                    SimpleNamespace(
                                        index=1,
                                        id="call_2",
                                        function=SimpleNamespace(
                                            name="create_task",
                                            arguments='{"title": "明早买牛奶"}',
                                        ),
                                    ),
                                ],
                            )
                        )
                    ]
                )
            else:
                for token in ["好耶～", "我都帮你记进日记，", "也加进待办清单啰！"]:
                    yield SimpleNamespace(
                        choices=[
                            SimpleNamespace(
                                delta=SimpleNamespace(content=token, tool_calls=None)
                            )
                        ]
                    )

        return _gen()

    monkeypatch.setattr(brain, "_create_async_completion_fast", _fake_stream_completion)

    async def _run_tool_loop():
        events = []
        async for evt in brain.stream_agent_turn(
            "今天跑完步还写完代码了，心情超好，明天记得买牛奶",
            date_str="2026-11-22",
        ):
            events.append(evt)

        tool_starts = [e for e in events if e["type"] == "tool_start"]
        tool_results = [e for e in events if e["type"] == "tool_result"]
        text = "".join(e["delta"] for e in events if e["type"] == "text_delta")
        meta = [e for e in events if e["type"] == "turn_meta"][-1]

        assert len(tool_starts) == 1
        assert "日记" in tool_starts[0]["filler_hint"]
        assert len(tool_results) == 2
        assert all(r["ok"] for r in tool_results)
        assert "好耶～" in text
        assert "summary" in meta["archive_skip_keys"]
        assert "mood_score" in meta["archive_skip_keys"]

    asyncio.run(_run_tool_loop())

    # 测试：模型不支持 tools 报 HTTP 400 时自动降级并缓存
    class _UnsupportedToolsError(Exception):
        def __init__(self) -> None:
            super().__init__("400 Bad Request: tools parameter is not supported by this model")
            self.status_code = 400

    calls_seen: list[bool] = []

    async def _fake_unsupported(client, base_kwargs, base_url, model_name):
        has_tools = "tools" in base_kwargs
        calls_seen.append(has_tools)
        if has_tools:
            raise _UnsupportedToolsError()

        async def _gen():
            yield SimpleNamespace(
                choices=[SimpleNamespace(delta=SimpleNamespace(content="欸～我听到了喔！", tool_calls=None))]
            )

        return _gen()

    monkeypatch.setattr(brain, "_create_async_completion_fast", _fake_unsupported)

    async def _run_fallback():
        first_events = [e async for e in brain.stream_agent_turn("你好呀", date_str="2026-11-22")]
        first_text = "".join(e["delta"] for e in first_events if e["type"] == "text_delta")
        assert first_text == "欸～我听到了喔！"
        assert llm_client.model_supports_tools("https://mock.llm.local/v1", "mock-tool-model") is False

        # 第二次调用应直接跳过 tools（不再白白尝试带 tools 报错）
        second_events = [e async for e in brain.stream_agent_turn("再聊一句", date_str="2026-11-22")]
        second_text = "".join(e["delta"] for e in second_events if e["type"] == "text_delta")
        assert second_text == "欸～我听到了喔！"
        assert calls_seen == [True, False, False]

    asyncio.run(_run_fallback())


def test_archive_smart_backoff_skips_tool_handled_dimensions(isolated_env, monkeypatch):
    import app.services.agent_brain as brain

    llm_called = {"count": 0}

    async def _should_not_call(*args, **kwargs):
        llm_called["count"] += 1
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(
                        content=json.dumps(
                            {
                                "daily_summary_append": "不该重复写入的摘要",
                                "new_highlights": ["一条新小确幸"],
                                "habit_updates": [],
                                "mood_score": 2,
                                "energy_score": None,
                                "new_memories": [],
                            },
                            ensure_ascii=False,
                        )
                    )
                )
            ]
        )

    monkeypatch.setattr(
        brain,
        "_load_settings_dict",
        lambda: {
            "bot_name": "灵儿",
            "llm": {"api_key": "sk-test", "base_url": "https://mock.local/v1", "model": "mock"},
        },
    )
    monkeypatch.setattr(brain, "_create_async_completion_fast", _should_not_call)

    async def _run():
        # 场景 1：全部核心维度已由工具处理 -> 直接跳过二次 LLM 归档调用
        res_full = await brain.archive_voice_call_turn_async(
            date_str="2026-11-22",
            user_message="今天很开心",
            assistant_reply="好耶～",
            skip_keys={"summary", "highlights", "habit_updates", "new_memories"},
        )
        assert res_full["skipped_by_tools"] is True
        assert llm_called["count"] == 0

        # 场景 2：仅 summary 和 mood_score 由工具写过 -> 允许补提取 highlights，但硬过滤掉 summary 和 mood_score
        res_partial = await brain.archive_voice_call_turn_async(
            date_str="2026-11-22",
            user_message="今天喝到好喝奶茶",
            assistant_reply="太棒了～",
            skip_keys={"summary", "mood_score"},
        )
        assert res_partial["skipped_by_tools"] is False
        assert llm_called["count"] == 1
        assert res_partial["applied"]["summary_updated"] is False
        assert res_partial["applied"]["mood_score"] is None
        assert res_partial["applied"]["new_highlights"] == ["一条新小确幸"]

    asyncio.run(_run())


def test_tools_http_and_mcp_endpoints(isolated_env):
    from fastapi import FastAPI
    from app.routers import tools as tools_router

    app = FastAPI()
    app.include_router(tools_router.router)
    client = TestClient(app)

    res = client.get("/api/tools")
    assert res.status_code == 200
    body = res.json()
    assert body["count"] >= 12
    assert any(t["name"] == "control_focus_timer" for t in body["tools"])

    mcp_res = client.post(
        "/api/tools/mcp",
        json={"jsonrpc": "2.0", "id": 42, "method": "tools/list"},
    )
    assert mcp_res.status_code == 200
    assert len(mcp_res.json()["result"]["tools"]) == body["count"]


def test_focus_companion_message_llm_and_fallback(isolated_env, monkeypatch):
    from fastapi import FastAPI
    from app.routers import focus as focus_router

    app = FastAPI()
    app.include_router(focus_router.router)
    client = TestClient(app)

    # 1. 无 API Key 时降级内置任务感知随机台湾腔文案库，连续两次不重复同一关怀维度
    monkeypatch.setattr(
        focus_router,
        "get_all_settings",
        lambda: {"bot_name": "灵儿", "llm": {"api_key": ""}},
    )
    r1 = client.post(
        "/api/focus/companion-message",
        json={
            "event": "focus_completed",
            "task_title": "写前端动画",
            "focus_minutes": 25,
            "round": 1,
            "break_type": "short",
        },
    )
    assert r1.status_code == 200
    d1 = r1.json()
    assert d1["used_fallback"] is True
    assert "写前端动画" in d1["reply"]
    assert len(d1["sentences"]) >= 1
    assert d1["suggestion_tag"]

    r2 = client.post(
        "/api/focus/companion-message",
        json={
            "event": "focus_completed",
            "task_title": "写前端动画",
            "focus_minutes": 25,
            "round": 2,
            "break_type": "short",
        },
    )
    assert r2.status_code == 200
    assert r2.json()["suggestion_tag"] != d1["suggestion_tag"]

    # 2. 休息结束事件 + 有 API Key 时调用 LLM 生成自然随机回应
    monkeypatch.setattr(
        focus_router,
        "get_all_settings",
        lambda: {
            "bot_name": "灵儿",
            "llm": {"api_key": "sk-test", "base_url": "https://mock.local/v1", "model": "mock"},
        },
    )

    async def _fake_llm(*args, **kwargs):
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(
                        content="欸～休息好啰，刚刚写前端动画超顺的耶，要不要再来一轮冲一下呀？"
                    )
                )
            ]
        )

    monkeypatch.setattr(focus_router, "create_async_completion_fast", _fake_llm)
    r3 = client.post(
        "/api/focus/companion-message",
        json={
            "event": "break_completed",
            "task_title": "写前端动画",
            "focus_minutes": 30,
            "round": 1,
            "break_type": "short",
        },
    )
    assert r3.status_code == 200
    d3 = r3.json()
    assert d3["used_fallback"] is False
    assert "写前端动画" in d3["reply"]
    assert len(d3["sentences"]) >= 1

