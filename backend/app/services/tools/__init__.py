"""灵儿统一工具注册中心与 MCP 适配入口。"""

from __future__ import annotations

from app.services.tools.builtin_tools import register_builtin_tools
from app.services.tools.mcp_adapter import LingerMCPServerAdapter, MCPProviderBase, mount_mcp_provider
from app.services.tools.registry import ToolRegistry
from app.services.tools.types import ToolContext, ToolExecutionResult, ToolSpec

tool_registry = ToolRegistry()
register_builtin_tools(tool_registry)
mcp_server_adapter = LingerMCPServerAdapter(tool_registry)

__all__ = [
    "LingerMCPServerAdapter",
    "MCPProviderBase",
    "ToolContext",
    "ToolExecutionResult",
    "ToolRegistry",
    "ToolSpec",
    "mcp_server_adapter",
    "mount_mcp_provider",
    "register_builtin_tools",
    "tool_registry",
]
