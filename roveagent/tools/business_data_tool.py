"""Read-only RoveFrame business tools.

Handlers never accept tenant or business identifiers from model arguments.
The EnterpriseToolGate validates the immutable run context before dispatch;
the adapter then repeats that scope on every internal API request and validates
the returned scope envelope.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from roveagent.business.data_layer import BusinessDataLayer
from roveagent.enterprise.run_context import current_tool_context
from roveagent.tools.registry import registry, tool_error


def _adapter() -> BusinessDataLayer:
    context = current_tool_context()
    if context is None:
        raise RuntimeError("trusted business tool context is unavailable")
    return BusinessDataLayer(context.tenant_id, context.business_id)


def _handler(method: str) -> Callable[..., str]:
    def run(args: dict[str, Any], **_kwargs: Any) -> str:
        try:
            adapter = _adapter()
            if method == "read_sales":
                result = adapter.read_sales(str(args.get("period", "week")))
            elif method in {"read_orders", "read_customers", "read_products", "read_inventory",
                            "read_reviews", "read_payments"}:
                result = getattr(adapter, method)(limit=int(args.get("limit", 50)))
            else:
                result = adapter.read_business_profile()
            return json.dumps(result, ensure_ascii=False, default=str)
        except (RuntimeError, TypeError, ValueError) as error:
            return tool_error(f"RoveFrame business data unavailable: {error}")
    return run


def _schema(name: str, description: str, *, period: bool = False) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    if period:
        properties["period"] = {
            "type": "string", "enum": ["today", "week"],
            "description": "Current local business day or trailing seven-day window.",
        }
    elif name != "read_business_profile":
        properties["limit"] = {
            "type": "integer", "minimum": 1, "maximum": 100, "default": 50,
        }
    return {
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": properties,
            "additionalProperties": False,
        },
    }


_TOOLS = [
    ("read_sales", "Read current revenue and order metrics for this business.", True),
    ("read_orders", "Read bounded recent orders for this business.", False),
    ("read_customers", "Read bounded current customers and retention facts for this business.", False),
    ("read_products", "Read bounded current products, prices, costs, and sales counts for this business.", False),
    ("read_inventory", "Read bounded current inventory and safety-stock facts for this business.", False),
    ("read_reviews", "Read bounded recent customer reviews for this business.", False),
    ("read_payments", "Read bounded recent payment lifecycle records for this business.", False),
    ("read_business_profile", "Read the canonical profile for this business.", False),
]

for _name, _description, _period in _TOOLS:
    registry.register(
        name=_name,
        toolset="business",
        schema=_schema(_name, _description, period=_period),
        handler=_handler(_name),
        emoji="📊",
    )
