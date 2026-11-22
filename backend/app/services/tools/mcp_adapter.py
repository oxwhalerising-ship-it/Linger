"""MCP（Model Context Protocol）双向适配预留层。

设计目标：
1. 向下接入（MCP Client Provider）：定义 `MCPProviderBase` 抽象与 `mount_mcp_provider`，
   后续接入任意外部 MCP Server（stdio / SSE / Streamable HTTP）时，只需实现 `list_tools` 和 `call_tool`，
   即可无缝注入灵儿同一套 `ToolRegistry`，对 LLM 透明。
2. 向上暴露（MCP Server Adapter）：`LingerMCPServerAdapter` 将 `ToolRegistry` 封装为标准
   MCP JSON-RPC 2.0 处理器（支持 `initialize`、`tools/list`、`tools/call`），后续无需重写工具逻辑即可对外提供 MCP 服务。
"""

from __future__ import annotations

import abc
import json
from datetime import datetime
from typing import Any

from app.services.tools.registry import ToolRegistry
from app.services.tools.types import ToolContext, ToolExecutionResult, ToolSpec


class MCPProviderBase(abc.ABC):
    """外部 MCP Server 客户端适配器抽象基类（预留 stdio / HTTP / SSE 实现）"""

    server_name: str

    @abc.abstractmethod
    async def list_tools(self) -> list[dict[str, Any]]:
        """返回 MCP `tools/list` 格式的工具列表：[{name, description, inputSchema}]"""

    @abc.abstractmethod
    async def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """调用外部 MCP Server 的指定工具，返回结构化结果"""


async def mount_mcp_provider(
    registry: ToolRegistry,
    provider: MCPProviderBase,
    *,
    prefix: str | None = None,
) -> list[str]:
    """将外部 MCP Server 的工具动态挂载进灵儿 ToolRegistry。"""
    tools = await provider.list_tools()
    mounted: list[str] = []
    ns = (prefix if prefix is not None else provider.server_name).strip()

    for item in tools:
        remote_name = str(item.get("name") or "").strip()
        if not remote_name:
            continue
        local_name = f"{ns}__{remote_name}" if ns else remote_name
        description = str(item.get("description") or f"外部 MCP 工具：{remote_name}")
        input_schema = item.get("inputSchema")
        if not isinstance(input_schema, dict):
            input_schema = {"type": "object", "properties": {}}

        async def _proxy_handler(
            args: dict[str, Any],
            _ctx: ToolContext,
            _remote_name: str = remote_name,
            _local_name: str = local_name,
        ) -> ToolExecutionResult:
            resp = await provider.call_tool(_remote_name, args)
            is_error = bool(resp.get("isError"))
            return ToolExecutionResult(
                ok=not is_error,
                tool_name=_local_name,
                data=resp if isinstance(resp, dict) else {"result": resp},
                badge=None if is_error else f"🔌 已调用 {_remote_name}",
                error=str(resp.get("error") or "") if is_error else None,
            )

        registry.register(
            ToolSpec(
                name=local_name,
                description=description,
                parameters=input_schema,
                handler=_proxy_handler,
                category="mcp",
                filler_hint="好喔，我帮你查一下喔～",
                source=f"mcp:{provider.server_name}",
            )
        )
        mounted.append(local_name)

    return mounted


class LingerMCPServerAdapter:
    """将灵儿内置 ToolRegistry 适配为标准 MCP JSON-RPC 2.0 协议处理器。"""

    PROTOCOL_VERSION = "2024-11-05"

    def __init__(self, registry: ToolRegistry, *, server_name: str = "linger-bot", version: str = "0.4.0") -> None:
        self._registry = registry
        self._server_name = server_name
        self._version = version

    async def handle_jsonrpc(self, request: dict[str, Any]) -> dict[str, Any]:
        req_id = request.get("id")
        method = str(request.get("method") or "")
        params = request.get("params") if isinstance(request.get("params"), dict) else {}

        if method == "initialize":
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": self.PROTOCOL_VERSION,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": self._server_name, "version": self._version},
                },
            }

        if method == "tools/list":
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"tools": self._registry.to_mcp_tools()},
            }

        if method == "tools/call":
            tool_name = str(params.get("name") or "").strip()
            arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
            ctx = ToolContext(
                date_str=datetime.now().strftime("%Y-%m-%d"),
                channel="mcp",
            )
            result = await self._registry.execute(tool_name, arguments, ctx)
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(result.to_llm_payload(), ensure_ascii=False),
                        }
                    ],
                    "isError": not result.ok,
                },
            }

        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {
                "code": -32601,
                "message": f"Method not found: {method}",
            },
        }
