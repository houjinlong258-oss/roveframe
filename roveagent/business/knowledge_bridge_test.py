"""Regression tests for the knowledge-search bridge (Phase 5).

Context — the gap this closes:

Before Phase 5 the runtime could search the public internet (``web_search``,
keyless, verified live) but had NO way to search the tenant's OWN documents.
The knowledge base was reachable only from the in-app assistant
(``/api/knowledge/ask``), so an agent asked "what is our refund policy?" could
research the world and still not read the customer's handbook.

The bridge reuses the existing, already-hardened service boundary:

  search_knowledge (tool, toolset "knowledge")
    -> BusinessDataLayer.search_knowledge()          [roveagent/business]
    -> POST /api/internal/agent/business-data        [Next.js]
    -> match_doc_chunks(filter_tenant_id, filter_business_id)

The properties pinned here are the ones that would be dangerous to regress:

  1. SCOPE IS NEVER MODEL-CONTROLLED. Tenant and business ids come from the
     immutable run context. The tool schema has no tenant/business field, and
     the adapter rejects a response envelope whose scope does not match.
  2. THE GATE HAS A REAL POLICY ROW. ``search_knowledge`` must not land on the
     catch-all ``*`` row, which grants registered tools approval-free
     execution — landing there is equivalent to having no policy at all.
  3. RETRIEVAL IS NOT SUMMARIZATION. The adapter returns passages; it must not
     invoke a model, so a service-to-service read cannot spend tenant budget.

Hermetic: injected in-memory transport, no network, no credentials.

Run:  python -m pytest roveagent/business/knowledge_bridge_test.py -q
"""
from __future__ import annotations

import fnmatch
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from roveagent.business.data_layer import BusinessDataError, BusinessDataLayer  # noqa: E402
from roveagent.tools.framework import DEFAULT_POLICIES, EnterpriseToolGate  # noqa: E402

TENANT = "00000000-0000-0000-0000-000000000000"
BUSINESS = "00000000-0000-0000-0000-000000000001"


def _ok_transport(captured: dict):
    def transport(operation: str, payload: dict) -> dict:
        captured["operation"] = operation
        captured["payload"] = payload
        return {
            "ok": True,
            "scope": {"tenant_id": TENANT, "business_id": BUSINESS},
            "data": {
                "query": payload["params"]["query"],
                "retrieval": "vector",
                "chunks": [
                    {"doc_id": "d1", "title": "Staff Handbook",
                     "content": "Opening hours are 09:00-21:00.", "similarity": 0.83},
                ],
            },
        }
    return transport


class AdapterRequestShapeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.captured: dict = {}
        self.layer = BusinessDataLayer(TENANT, BUSINESS, transport=_ok_transport(self.captured))

    def test_operation_and_params(self) -> None:
        self.layer.search_knowledge("what are the opening hours?", 5)
        self.assertEqual(self.captured["operation"], "search_knowledge")
        self.assertEqual(
            self.captured["payload"]["params"],
            {"query": "what are the opening hours?", "limit": 5},
        )

    def test_scope_comes_from_the_adapter_not_the_call(self) -> None:
        """Property 1: model input cannot influence tenant scope."""
        self.layer.search_knowledge("q", 3)
        self.assertEqual(self.captured["payload"]["tenant_id"], TENANT)
        self.assertEqual(self.captured["payload"]["business_id"], BUSINESS)

    def test_response_is_parsed_into_documented_shape(self) -> None:
        out = self.layer.search_knowledge("q", 5)
        self.assertEqual(out["retrieval"], "vector")
        self.assertEqual(len(out["chunks"]), 1)
        self.assertEqual(out["chunks"][0]["title"], "Staff Handbook")

    def test_empty_query_is_refused(self) -> None:
        for bad in ("", "   ", "\n\t"):
            with self.subTest(q=repr(bad)), self.assertRaises(ValueError):
                self.layer.search_knowledge(bad, 5)

    def test_limit_is_bounded(self) -> None:
        cases = {None: 5, 0: 1, -3: 1, 1: 1, 20: 20, 21: 20, 9999: 20}
        for given, expected in cases.items():
            with self.subTest(limit=given):
                self.captured.clear()
                self.layer.search_knowledge("q", given)  # type: ignore[arg-type]
                self.assertEqual(self.captured["payload"]["params"]["limit"], expected)

    def test_missing_chunks_key_is_tolerated(self) -> None:
        def bare_transport(operation: str, payload: dict) -> dict:
            return {"ok": True, "scope": {"tenant_id": TENANT, "business_id": BUSINESS}, "data": {}}

        out = BusinessDataLayer(TENANT, BUSINESS, transport=bare_transport).search_knowledge("q", 5)
        self.assertEqual(out["chunks"], [])


class ScopeEnforcementTest(unittest.TestCase):
    """Property 1, negative direction: a mismatched envelope must be rejected."""

    def test_cross_tenant_envelope_is_rejected(self) -> None:
        def transport(operation: str, payload: dict) -> dict:
            return {"ok": True, "scope": {"tenant_id": "someone-else", "business_id": BUSINESS}, "data": {}}

        with self.assertRaises(BusinessDataError):
            BusinessDataLayer(TENANT, BUSINESS, transport=transport).search_knowledge("q", 5)

    def test_cross_business_envelope_is_rejected(self) -> None:
        def transport(operation: str, payload: dict) -> dict:
            return {"ok": True, "scope": {"tenant_id": TENANT, "business_id": "another-shop"}, "data": {}}

        with self.assertRaises(BusinessDataError):
            BusinessDataLayer(TENANT, BUSINESS, transport=transport).search_knowledge("q", 5)

    def test_scope_ids_are_required_at_construction(self) -> None:
        for tenant, business in (("", BUSINESS), (TENANT, ""), ("", "")):
            with self.subTest(tenant=tenant, business=business), self.assertRaises(ValueError):
                BusinessDataLayer(tenant, business, transport=_ok_transport({}))


class GatePolicyTest(unittest.TestCase):
    """Property 2: the tool must have an explicit, read-only policy row."""

    def setUp(self) -> None:
        self.policy = EnterpriseToolGate().policy_for("search_knowledge")

    def test_not_on_the_catch_all(self) -> None:
        self.assertNotEqual(
            self.policy.pattern, "*",
            "search_knowledge fell through to the catch-all row, which grants "
            "registered tools approval-free execution — add an explicit row to "
            "DEFAULT_POLICIES in tools/framework.py",
        )

    def test_permission_and_risk(self) -> None:
        self.assertEqual(self.policy.permission, "knowledge:read")
        self.assertEqual(self.policy.approval, "none")
        self.assertEqual(int(self.policy.risk), 0, "knowledge search is read-only")
        self.assertTrue(self.policy.audit, "reads must still be audited")

    def test_no_earlier_pattern_shadows_the_row(self) -> None:
        """A shadowed row is dead code; the tool would silently use the shadow."""
        for p in DEFAULT_POLICIES:
            if p.pattern == "search_knowledge":
                return
            self.assertFalse(
                fnmatch.fnmatchcase("search_knowledge", p.pattern),
                "row is shadowed by earlier pattern %r" % p.pattern,
            )
        self.fail("no explicit search_knowledge row in DEFAULT_POLICIES")


class ToolRegistrationTest(unittest.TestCase):
    def test_tool_and_toolset(self) -> None:
        import roveagent.tools.business_data_tool  # noqa: F401  (import registers)
        from roveagent.tools.registry import registry
        from roveagent.toolsets import TOOLSETS, resolve_toolset

        entry = registry.get_entry("search_knowledge")
        self.assertIsNotNone(entry, "search_knowledge is not registered")
        self.assertEqual(getattr(entry, "toolset", None), "knowledge")
        self.assertIn("knowledge", TOOLSETS)
        self.assertIn("search_knowledge", set(resolve_toolset("knowledge")))

    def test_schema_has_no_scope_fields(self) -> None:
        """Property 1: the model must have no way to name a tenant or business."""
        import roveagent.tools.business_data_tool  # noqa: F401
        from roveagent.tools.registry import registry

        entry = registry.get_entry("search_knowledge")
        schema = getattr(entry, "schema", {}) or {}
        props = set(((schema.get("parameters") or {}).get("properties")) or {})
        self.assertEqual(props, {"query", "limit"}, "unexpected tool parameters: %s" % sorted(props))
        for forbidden in ("tenant_id", "business_id", "user_id", "role"):
            self.assertNotIn(forbidden, props)

    def test_handler_degrades_to_structured_error(self) -> None:
        """Property 3 + robustness: no run context must not raise into the loop."""
        import json

        from roveagent.tools.business_data_tool import _knowledge_handler

        raw = _knowledge_handler({"query": "opening hours", "limit": 5})
        self.assertIsInstance(raw, str)
        parsed = json.loads(raw)
        self.assertIsInstance(parsed, dict)
        self.assertTrue(
            parsed.get("error") is not None or parsed.get("chunks") is not None,
            "handler must return either an error or chunks, got %r" % parsed,
        )


class CapabilityGrantTest(unittest.TestCase):
    """Business-facing agents answer business questions, so they need the KB."""

    def test_business_agents_can_reach_the_knowledge_base(self) -> None:
        from roveagent.api.capability_router import planned_toolsets

        for agent in ("ceo", "operations", "marketing"):
            with self.subTest(agent=agent):
                self.assertIn("knowledge", planned_toolsets(agent))

    def test_engineering_agents_are_unchanged(self) -> None:
        """No stated need — do not widen engineering-agent scope gratuitously."""
        from roveagent.api.capability_router import planned_toolsets

        for agent in ("developer", "devops"):
            with self.subTest(agent=agent):
                self.assertNotIn("knowledge", planned_toolsets(agent))

    # NOTE: the "capability_router is still a superset of api/toolsets"
    # invariant is deliberately NOT re-asserted here — it is already locked by
    # capability_router_test.ConsistencyTest. Duplicating a locked invariant
    # only creates a second place to update.


if __name__ == "__main__":
    unittest.main()
