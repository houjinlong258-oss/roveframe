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


# ---------------------------------------------------------------------------
# Knowledge base search (the tenant's OWN documents)
#
# Distinct from `search` / `web`: web_search reaches the public internet,
# this reaches the rows this tenant uploaded. Without it an agent in the
# runtime can research the outside world but cannot answer from the customer's
# own handbook, price list, or policies — the knowledge base was reachable
# only from the in-app assistant.
#
# Read-only and scope-bound: tenant/business ids come from the immutable run
# context, never from tool arguments. Gate policy is an explicit row
# (`search_knowledge`, knowledge:read, LOW, NONE) so it does NOT land on the
# catch-all; see DEFAULT_POLICIES in tools/framework.py.
# ---------------------------------------------------------------------------

def _knowledge_handler(args: dict[str, Any], **_kwargs: Any) -> str:
    try:
        adapter = _adapter()
        result = adapter.search_knowledge(
            query=str(args.get("query", "")).strip(),
            limit=int(args.get("limit", 5)),
        )
        if not result.get("chunks"):
            return json.dumps(
                {
                    "query": result.get("query", ""),
                    "retrieval": result.get("retrieval", "unknown"),
                    "chunks": [],
                    "note": (
                        "No matching content in this business's knowledge base. "
                        "Say so plainly rather than answering from general "
                        "knowledge, and suggest uploading a source document."
                    ),
                },
                ensure_ascii=False,
                default=str,
            )
        return json.dumps(result, ensure_ascii=False, default=str)
    except (RuntimeError, TypeError, ValueError) as error:
        return tool_error(f"RoveFrame knowledge search unavailable: {error}")


registry.register(
    name="search_knowledge",
    toolset="knowledge",
    schema={
        "name": "search_knowledge",
        "description": (
            "Search this business's own knowledge base (uploaded documents, "
            "policies, price lists, playbooks) and return the most relevant "
            "passages with their source document titles. Use this before "
            "answering any question about this specific business. This searches "
            "internal documents only; use web_search for public internet "
            "content. Retrieval only — no summarization, no model spend."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000,
                    "description": "What to look up, phrased as a natural-language question or topic.",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 20,
                    "default": 5,
                    "description": "Maximum number of passages to return.",
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    handler=_knowledge_handler,
    emoji="📚",
)


# ---------------------------------------------------------------------------
# Customer Recovery Campaign (真实高价值审批动作)
#
# analyze_churn_customers：只读分段（read_* 策略放行）。
# send_customer_recovery_campaign：真实外发动作，门控策略 OWNER ——
# CMO 起草后冻结调用并推送审批，老板批准后经 /api/agent/tool/resolve
# 单次放行，由 RoveFrame 内部 API 真实 SMTP 出件。
# ---------------------------------------------------------------------------

def _churn_handler(args: dict[str, Any], **_kwargs: Any) -> str:
    try:
        adapter = _adapter()
        result = adapter.analyze_churn_customers(
            days_inactive=int(args.get("days_inactive", 60)),
            min_total_spent=float(args.get("min_total_spent", 0)),
            limit=int(args.get("limit", 100)),
        )
        return json.dumps(result, ensure_ascii=False, default=str)
    except (RuntimeError, TypeError, ValueError) as error:
        return tool_error(f"RoveFrame churn analysis unavailable: {error}")


def _send_campaign_handler(args: dict[str, Any], **_kwargs: Any) -> str:
    try:
        adapter = _adapter()
        result = adapter.send_recovery_campaign(
            campaign_title=str(args.get("campaign_title", "")).strip(),
            subject=str(args.get("subject", "")).strip(),
            body=str(args.get("body", "")).strip(),
            customer_ids=[str(cid) for cid in (args.get("customer_ids") or [])],
            language=str(args.get("language", "en")),
        )
        return json.dumps(result, ensure_ascii=False, default=str)
    except (RuntimeError, TypeError, ValueError) as error:
        return tool_error(f"RoveFrame campaign send unavailable: {error}")


registry.register(
    name="analyze_churn_customers",
    toolset="business",
    schema={
        "name": "analyze_churn_customers",
        "description": (
            "Analyze high-value customers who have not spent money in the "
            "trailing window (churn-risk win-back segment). Returns customer "
            "ids, contact points, spend history and days since last visit."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "days_inactive": {
                    "type": "integer", "minimum": 7, "maximum": 365, "default": 60,
                    "description": "Days without any spend that define the churn window.",
                },
                "min_total_spent": {
                    "type": "number", "minimum": 0, "default": 0,
                    "description": "Minimum lifetime spend that defines a high-value customer.",
                },
                "limit": {
                    "type": "integer", "minimum": 1, "maximum": 200, "default": 100,
                },
            },
            "additionalProperties": False,
        },
    },
    handler=_churn_handler,
    emoji="🔍",
)

registry.register(
    name="send_customer_recovery_campaign",
    toolset="business",
    schema={
        "name": "send_customer_recovery_campaign",
        "description": (
            "Send a real win-back email campaign to a frozen list of customer "
            "ids. REQUIRES OWNER APPROVAL: the call is frozen and pushed to "
            "the owner approval UI; emails are only sent after approval."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "campaign_title": {
                    "type": "string", "minLength": 1, "maxLength": 120,
                    "description": "Short campaign name shown to the owner in the approval request.",
                },
                "subject": {
                    "type": "string", "minLength": 1, "maxLength": 300,
                    "description": "Email subject line for every recipient.",
                },
                "body": {
                    "type": "string", "minLength": 1, "maxLength": 8000,
                    "description": "Plain-text email body. May include {name} placeholder.",
                },
                "customer_ids": {
                    "type": "array", "items": {"type": "string"},
                    "minItems": 1, "maxItems": 500,
                    "description": "Frozen list of recipient customer ids from analyze_churn_customers.",
                },
                "language": {
                    "type": "string", "enum": ["en", "zh", "es"], "default": "en",
                },
            },
            "required": ["campaign_title", "subject", "body", "customer_ids"],
            "additionalProperties": False,
        },
    },
    handler=_send_campaign_handler,
    emoji="📧",
)
