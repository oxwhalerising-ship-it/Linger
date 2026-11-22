"""统一工具系统核心类型定义（面向内置 Tool Registry 与未来 MCP 适配层）。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from app.services.event_bus import EventBusManager, event_bus


@dataclass(slots=True)
class ToolContext:
    """单次工具调用上下文（透传日期、会话线程、通道与事件总线）。"""

    date_str: str
    thread_id: str | None = None
    source_message_id: int | None = None
    mode: str = "normal"
    channel: str = "text"  # "text" | "voice" | "mcp"
    bus: EventBusManager = field(default_factory=lambda: event_bus)


@dataclass(slots=True)
class ToolExecutionResult:
    """工具统一返回结构（兼顾给 LLM 的结构化结果、给 UI 的轻量标签与给归档的退让信号）。"""

    ok: bool
    tool_name: str
    data: dict[str, Any] = field(default_factory=dict)
    badge: str | None = None
    mutated_domains: list[str] = field(default_factory=list)
    archive_skip_keys: set[str] = field(default_factory=set)
    error: str | None = None

    def to_llm_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"ok": self.ok}
        if self.data:
            payload.update(self.data)
        if self.error:
            payload["error"] = self.error
        return payload

    def to_ui_event(self) -> dict[str, Any]:
        return {
            "tool": self.tool_name,
            "ok": self.ok,
            "badge": self.badge,
            "error": self.error,
        }


ToolHandler = Callable[[dict[str, Any], ToolContext], Awaitable[ToolExecutionResult] | ToolExecutionResult]


@dataclass(slots=True)
class ToolSpec:
    """标准工具定义：单一真相源，可同时导出 OpenAI Function Calling Schema 与 MCP Tool Schema。"""

    name: str
    description: str
    parameters: dict[str, Any]
    handler: ToolHandler
    category: str
    filler_hint: str = "好喔，我这就帮你处理一下～"
    mutates_domains: tuple[str, ...] = ()
    archive_skip_keys: tuple[str, ...] = ()
    read_only: bool = False
    destructive: bool = False
    source: str = "builtin"  # "builtin" | "mcp:<server_name>"

    def to_openai_tool(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

    def to_mcp_tool(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": self.parameters,
            "annotations": {
                "readOnlyHint": self.read_only,
                "destructiveHint": self.destructive,
                "category": self.category,
                "source": self.source,
            },
        }
