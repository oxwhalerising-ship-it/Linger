"""统一工具注册中心（ToolRegistry）。

职责：
1. 注册内置控制面板工具与未来挂载的外部 MCP Server 工具。
2. 统一导出 OpenAI `tools` Schema 与 MCP `tools/list` Schema。
3. 统一执行调度、JSON 参数容错解析、异常兜底，并在写操作成功后自动向 `/ws/events` 广播 `data_changed`。
"""

from __future__ import annotations

import inspect
import json
from typing import Any

from app.core.logging import get_logger
from app.services.tools.types import ToolContext, ToolExecutionResult, ToolSpec

logger = get_logger("tools.registry")


class ToolRegistry:
    """灵儿统一工具注册中心"""

    def __init__(self) -> None:
        self._specs: dict[str, ToolSpec] = {}

    def register(self, spec: ToolSpec, *, replace: bool = True) -> None:
        if spec.destructive:
            raise ValueError(f"安全策略禁止注册破坏性删除工具：{spec.name}")
        if not replace and spec.name in self._specs:
            raise ValueError(f"工具名重复：{spec.name}")
        self._specs[spec.name] = spec

    def unregister(self, name: str) -> bool:
        return self._specs.pop(name, None) is not None

    def get(self, name: str) -> ToolSpec | None:
        return self._specs.get(name)

    def list_specs(self) -> list[ToolSpec]:
        return list(self._specs.values())

    def to_openai_tools(self) -> list[dict[str, Any]]:
        return [spec.to_openai_tool() for spec in self._specs.values()]

    def to_mcp_tools(self) -> list[dict[str, Any]]:
        return [spec.to_mcp_tool() for spec in self._specs.values()]

    @staticmethod
    def parse_arguments(raw_arguments: Any) -> dict[str, Any]:
        """兼容模型输出的 JSON 字符串或字典参数，遇到轻微格式偏差时安全降级"""
        if raw_arguments is None:
            return {}
        if isinstance(raw_arguments, dict):
            return raw_arguments
        text = str(raw_arguments).strip()
        if not text:
            return {}
        try:
            parsed = json.loads(text)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            # 容错提取最外层 JSON 对象
            start = text.find("{")
            end = text.rfind("}")
            if start != -1 and end > start:
                try:
                    parsed = json.loads(text[start : end + 1])
                    if isinstance(parsed, dict):
                        return parsed
                except json.JSONDecodeError:
                    pass
            return {}

    async def execute(
        self,
        name: str,
        raw_arguments: Any,
        ctx: ToolContext,
    ) -> ToolExecutionResult:
        spec = self._specs.get(name)
        if spec is None:
            return ToolExecutionResult(
                ok=False,
                tool_name=name,
                error=f"未找到名为 {name} 的工具",
            )

        args = self.parse_arguments(raw_arguments)
        try:
            res = spec.handler(args, ctx)
            if inspect.isawaitable(res):
                result = await res
            else:
                result = res
        except Exception as exc:
            logger.warning("工具执行异常 (%s): %s", name, exc)
            return ToolExecutionResult(
                ok=False,
                tool_name=name,
                error=f"执行 {name} 时发生异常：{exc}",
            )

        # 合并 spec 默认声明的变更域与归档退让键
        if result.ok:
            merged_domains = sorted(set(result.mutated_domains) | set(spec.mutates_domains))
            result.mutated_domains = merged_domains
            result.archive_skip_keys = set(result.archive_skip_keys) | set(spec.archive_skip_keys)
            if merged_domains:
                try:
                    await ctx.bus.notify_data_changed(
                        merged_domains,
                        source=f"tool:{name}",
                    )
                except Exception as exc:
                    logger.warning("广播 data_changed 失败 (%s): %s", name, exc)

        return result
