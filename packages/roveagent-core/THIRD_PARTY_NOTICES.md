# Third-party source attribution

This package contains TypeScript ports/adaptations of Hermes Agent source from
the locally supplied `hermes-agent-2026.8.31` snapshot, copyright (c) 2025 Nous
Research, MIT licensed. The complete original license is in `LICENSE`.

| Local source | Derived file | Changes |
| --- | --- | --- |
| `agent/iteration_budget.py` | `src/runtime/iteration-budget.ts` | TypeScript port, finite positive bounds, synchronous per-request counter rather than Python thread lock |
| `agent/repetition_guard.py` | `src/context/repetition-guard.ts` | TypeScript port of line/window detection; JavaScript UTF-16 character lengths |
| `run_agent.py::_deduplicate_tool_calls` | `src/tools/call-key.ts` | Canonical JSON port, reject non-JSON values, cross-round use in native loop |

`src/runtime/agent-loop.ts` is a new enterprise-oriented implementation informed
by the upstream conversation lifecycle. It is **not** a port of the full
Python conversation loop or all upstream capabilities. The source manifest
records local input hashes; it does not assert a verified upstream commit.

No original CLI, home-directory configuration, social gateway, terminal tools,
Python package or upstream service is required to execute this package.
RoveAgent branding does not erase source authorship or the MIT notice.
