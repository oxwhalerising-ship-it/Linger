"""工具能力自省与 MCP 协议接口（/api/tools）。

提供：
- GET  /api/tools：查看灵儿当前已注册的全部内置工具及 MCP Schema 视图
- POST /api/tools/mcp：预留标准 MCP JSON-RPC 2.0 入口（initialize / tools/list / tools/call）
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app.services.tools import mcp_server_adapter, tool_registry

router = APIRouter(prefix="/api/tools", tags=["Tools"])


@router.get("")
def list_registered_tools():
    specs = tool_registry.list_specs()
    return {
        "count": len(specs),
        "tools": [
            {
                "name": s.name,
                "category": s.category,
                "description": s.description,
                "read_only": s.read_only,
                "source": s.source,
                "inputSchema": s.parameters,
            }
            for s in specs
        ],
    }


@router.post("/mcp")
async def mcp_jsonrpc_endpoint(payload: dict[str, Any]):
    """预留 MCP JSON-RPC 2.0 入口，支持外部 MCP Client 发现与调用灵儿工具。"""
    return await mcp_server_adapter.handle_jsonrpc(payload)
