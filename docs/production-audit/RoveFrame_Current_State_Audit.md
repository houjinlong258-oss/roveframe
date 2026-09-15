# RoveFrame Current State Audit

Scope: read-only architecture audit of `roveframe-src-latest` at working-tree state 2026-09-13.
Method: source reading, import/call-chain tracing, live test execution, process and build-artifact probing, git state inspection.
No file was modified. No code was refactored. No module was created.

Baseline verification performed for this document:

| Check | Command | Result |
|---|---|---|
| Type check | `pnpm ts-check` | PASS (exit 0) |
| TS tests | `pnpm test` | **FAIL — 606 tests / 591 pass / 15 fail** |
| Python tests | `python -B -m unittest discover -s roveagent -t . -p "*_test.py"` | **PASS — 765 tests / 765 pass / 96.7s** |
| Migration consistency | `pnpm validate:migrations` | PASS (51 tables covered) |
| Production scans | `pnpm scan:production` | PASS (2174 files) |
| Build artifacts | `.next/BUILD_ID`, `dist/` | **absent** |
| Running processes | ports 5000 / 8788 / 8799 | **all closed** |
| Version control | `git rev-parse --show-toplevel` | repo root is the **parent** directory; `?? roveframe-src-latest/` |

Code volume:

| Layer | Files | Lines |
|---|---|---|
| `src` (TS/TSX) | 319 | 50,111 |
| `tests` (TS) | 60 | 8,542 |
| `packages/roveagent-core` | 5 | 117 |
| `roveagent` (Python) | 1,182 | 819,238 |

Python is 94 percent of the codebase by volume.

---

## 1. Real Architecture Diagram

Colour legend: GREEN = real running path · YELLOW = exists but not wired · RED = dead code.

```
Frontend  Next.js 16 / React 19 / 21 pages / i18n 1118 keys x 3 locales
  agent(1260) business(1297) settings(1769) approvals(560+601)
  GREEN
        |
        v  SSE, 9 event types (producer set == consumer whitelist)
API Gateway  91 route.ts
  proxy.ts single auth point
  protect{Tenant,Business}Mutation covers 52 routes
  withAuth covers only 8 routes
  RED: getAuthContext + RF_HEADERS injection chain -- 0 readers repo-wide
        |
        v
Agent Router  src/lib/agent/gateway.ts
  classifyRequest()  regex heuristic, no LLM
  roveAgentConfigured() ?
    true  -> Python runtime (see below)
    false -> TS fallback path
  YELLOW: classification result computed at chat/route.ts:544 but NOT used to
          branch; planning LLM call is unconditional
        |
        v  HTTP + X-RoveAgent-Key -> 127.0.0.1:8788
+----------------------------------------------------------------------+
| RoveAgent Python Runtime -- 819,238 lines / 1,182 files              |
| RED in production: no Dockerfile, no systemd, no k8s                  |
|   .coze requires ["nodejs-24"] only                                   |
|   scripts/start.sh runs only: node dist/server.js                     |
|   scripts/deploy.env has 4 Supabase vars, no ROVEAGENT_*              |
|   .env holds ROVEAGENT_* but is gitignored -> absent on fresh clone   |
|                                                                       |
| REACHABLE core (GREEN once deployed)                                  |
|   api/app.py:306 create_app() -> 22 routes                            |
|     get_context() module singleton (app.py:195)                       |
|     runtime.py AIAgent                                                |
|       core/conversation_loop.py:2094  <-- the canonical agent loop     |
|     api/capability_{registry,router,providers}.py  (cached)           |
|     tools/framework.py:155 EnterpriseToolGate                         |
|                                                                       |
| PARTIALLY WIRED (YELLOW)                                              |
|   api/plugin_*.py -- sandbox, trust, gate policies, bridge all real,  |
|     but SandboxPluginLoader.load_all() has ZERO non-test callers      |
|   api/media_hub.py -- plugin_center.py has no HTTP caller in prod     |
|                                                                       |
| UNREACHABLE PARALLEL SERVER (RED)                                     |
|   gateway/run.py                    30,947 lines                      |
|   gateway/platforms/api_server.py    7,231 lines (aiohttp, not FastAPI)|
|   gateway/platforms/base.py          6,853 lines                      |
|   gateway/slash_commands.py          5,829 lines                      |
|   gateway/session.py                 3,895 lines                      |
|   gateway/stream_consumer.py         3,320 lines                      |
|   ~40,000 lines, zero module-level gateway imports inside api/*        |
|   Reimplements its own turn loop, session state, approval interception |
+----------------------------------------------------------------------+
        |
        v
Tool System  THREE execution authorities
  A  TS AgentToolRegistry        14 tools   GREEN   <- model-visible
  B  TS executeEnterpriseTool     6 tools   YELLOW  /api/enterprise, own gate
  C  TS coding-agent/*                      YELLOW  own permission-guard
  D  Python EnterpriseToolGate   130+ tools RED (unreachable)
        |
        v
Capability / Skill / Plugin
  Python capability_providers.py: CapabilityProvider single door,
    Media / Search / Skill / Plugin / Social / Mcp / CoreTools providers
    GREEN in code, RED in production (runtime not deployed)
  TS side: YELLOW to RED
    src/lib/plugins/{registry,types,validator}.ts = 66-line manifest
      validator + in-memory Map. No execution, no sandbox, no marketplace,
      no UI, no API route. Only caller: customization/nl-engine.ts:416
    src/lib/skills.ts = 11 lines of hardcoded prompt strings
    MCP: 0 matches across the entire TS tree
        |
        v
Sandbox   L2 (process level, not container)
  GREEN: plugin_sandbox_runner.py -- separate OS process, stdio JSON-RPC,
    stdout-hijack defence, per-call error containment, no in-process fallback
  GREEN: env allowlist, not os.environ; NEVER-list beats explicit grant
  RED:   plugin_tools.py:359 and :673 hardcode IsolationMode.SUBPROCESS,
    so the container_argv hardening at plugin_isolation.py:514-532
    (--network none --read-only --tmpfs --user 65534) is never executed
  RED:   enforce defaults to False (plugin_isolation.py:328)
        |
        v
External Providers
  GREEN: 10 external providers, real, with failover chain (failover.ts 416)
  RED:   platform fallback = coze-coding-dev-sdk LLMClient
         (router.ts:505) -- no timeout, no retry, no signal
  RED:   embeddings = coze-coding-dev-sdk EmbeddingClient (embedding.ts:1)
         -- no abstraction, no alternative -> RAG is platform-bound
```

---

## 2. Module Reachability Matrix

Judged on four levels, not on code existence: code exists / tests pass / real invocation / production usable.

| Module | Code exists | Tests | Production invocation | Status |
|---|---|---|---|---|
| Agent Runtime (Python) | Yes — `api/app.py:306`, 22 routes | **Yes — covers part of 765 passing** | **No** — no deploy path starts the process | Architecture complete, **not production usable** |
| Agent Runtime (TS fallback) | Yes — `gateway.ts:140` + `packages/roveagent-core` | Yes | Yes, via `/api/agent/chat` | Usable, **performance-inadequate** |
| Next.js Gateway / SSE | Yes — `agentSseResponse`, 9 event types | Yes | Yes | Usable |
| Tool Execution (TS Registry) | Yes — `registry.ts:239` | Yes | Yes, 14 tools | Usable |
| Tool Execution (Python Gate) | Yes — `framework.py:155` | Yes | No | Not production usable |
| Memory | TS `business_memories` used; Python L0-L4 unreachable | Yes | TS yes, Python no | Partial |
| **Capability Registry** | Yes — `capability_registry.py:386` | Yes | **Feeds toolset resolution at `app.py:446` — changes production behaviour once deployed** | Architecture complete, not production usable |
| **Capability Providers** | Yes — `capability_providers.py:764`, 8 providers | Yes | Same dependency | Architecture complete, not production usable |
| **Plugin System** | Yes — `plugin_*.py` ~4,000 lines | Yes — 4 test files, 2000+ asserts | **NO — `SandboxPluginLoader.load_all()` has zero non-test callers; `kernel.py` and `bootstrap.py` do not assemble plugins** | **Written, never invoked** |
| Plugin (TS) | 66 lines, manifest validator only | Yes — `plugin-system.test.ts` | No | **Not a plugin system** |
| **Skill System** | 4 separate implementations, see section 3 | Yes | HTTP endpoints use the 104-line variant | **Duplicated; the robust variant is dead** |
| MCP | Python: JSON-RPC shape reused in sandbox runner. TS: absent | — | No | Not implemented |
| Media | `media_hub.py:339` + `capability_providers.py:MediaCapabilityProvider` | Yes | No | Not production usable |
| Social | `social/adapters.py` — base `publish()` unconditionally raises `AdapterNotImplemented` | Yes | No | **Explicitly unimplemented, and honest about it** |
| Search | Python `core/web_search_registry` adapted into `SearchCapabilityProvider`. **TS: 0 matches for any search engine** | Python yes | No | Not production usable; TS side absent |
| Document | `artifacts/*` zero-dependency PDF/OOXML writers | Yes — 994-line PDF test | Yes | **Usable** (`public/fonts/` has no `.ttf`, so CJK PDF degrades) |
| Approval bus | `approvals.ts:483` | Yes | Yes | **Usable — highest-quality module** |
| Audit | Postgres `audit_events` (TS) + local `*.jsonl` (Python) | Yes | TS yes, Python no | Two separate sinks |

Modules matching the "written but nobody calls it" pattern:

| Module | Evidence |
|---|---|
| `SandboxPluginLoader.load_all()` | Only callers are `capability_closure_test.py`, `capability_governance_test.py`, `plugin_integration_test.py`. `plugin_tools.py:80` only re-exports the name. |
| `skills_market/` (2,441 lines incl. 773-line test) | HTTP handlers import `..skills.marketplace` (`app.py:848`, `:864`), not `skills_market` |
| `src/lib/agent/permissions/engine.ts` | Only caller: `tests/agent-permissions.test.ts` |
| `src/lib/enterprise/memory.ts` | Only callers: test files |
| `gateway/` parallel server (~40,000 lines) | No module-level `gateway` import inside `api/` |
| `getAuthContext` + `RF_HEADERS` | Zero readers repo-wide |
| `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` | Declared in `package.json`, imported by zero files |
| `plugin_tools.py:968` | The project documents it itself: "`SandboxPluginLoader.disable` existed and was tested, but nothing called it" |

---

## 3. Skill System Verdict — Required Answer: A Delete / B Merge / C Keep Dual-Track

There are **four** skill implementations, not two.

| # | Location | Composition | Lines | Nature | Production reached |
|---|---|---|---|---|---|
| 1 | `roveagent/skills/` | `packs.py`(68) + `marketplace.py`(104) + `packs/*.json`(4 industries) + `packs/knowledge/*.md`(12) | 174 code | Industry pack loader + skill catalogue aggregator | **YES** — `app.py:848` `from ..skills.marketplace import catalog`; `app.py:864` `from ..skills.marketplace import install`; `kernel.py:29` `from .skills.packs import IndustryPack, load_pack` |
| 2 | `roveagent/skills_library/` | 65 py + **261 md** + `index-cache/lobehub_index.json` (251 KB) | content | Vendored third-party skill content (apple, creative, devops, email, media, note-taking, productivity, research, social-media, software-development, web, autonomous-ai-agents) | Only as a content source read by #1 (`_SKILLS_LIBRARY` glob at `skills/marketplace.py:26,69`) |
| 3 | `roveagent/skills_market/` | `installer`(386) `manifest`(243) `permissions`(194) `registry`(196) `sandbox`(197) `scanner`(356) `versions`(255) + **`skill_marketplace_test`(773)** | **2,441** | Real marketplace subsystem: install, versioning, permissions, sandboxing, scanning | **NO** — zero HTTP or kernel reference |
| 4 | `src/lib/skills.ts` | `INDUSTRY_SKILLS` — 5 hardcoded prompt strings | 11 | Prompt fragment table, not a skill system | YES — injected into the system prompt at `chat/route.ts:491` |

Additional fragmentation: five separate directory resolvers exist — `constants.py:1667 get_skills_dir()`, `constants.py:338 get_optional_skills_dir()`, `constants.py:368 get_bundled_skills_dir()`, `tools/skills_tool.py SKILLS_DIR`, `core/skill_utils.py get_external_skills_dirs()/get_project_skills_dirs()`.

Semantic divergence: TS `INDUSTRY_SKILLS` covers restaurant/fastfood/cafe/retail/service; Python `skills/packs/*.json` covers healthcare/hotel/restaurant/retail. Two different industry enumerations feeding the same product.

Security consequence: the live installer is the minimal variant (#1). It is guarded only by `require_safe_id` + `sanitize_skill_name` (`skills/marketplace.py:96-99`) then writes a `SKILL.md`. The hardened variant (#3) that contains `scanner.py` (356 lines), `permissions.py` (194), `versions.py` (255), and `sandbox.py` (197) is never invoked.

### Verdict: **B — Merge** (with a partial A)

Not C. Dual-track is the current state and it is the defect.

Not A. Deleting everything would remove the only reachable capability (`catalog`/`install` power three live HTTP endpoints) and the industry pack loader wired into `kernel.py`.

Not a plain merge either. The correct action has three parts:

1. **A — Delete `skills_market/` or wire it in.** These are the only two honest options. Keeping 2,441 lines of security-hardened marketplace code that nothing calls, while the minimal 104-line installer serves production, is the worst of both. Decision rule: if skill installation is to be a commercial feature, wire #3 in and delete #1's `install()`; otherwise delete #3 entirely.
2. **A — Delete `skills_library/` content unrelated to the product.** 261 md files of apple/creative/note-taking/spotify-adjacent content in an SMB restaurant product. Keep only what `skills/packs/` actually references.
3. **B — Merge `src/lib/skills.ts` into the Python industry-pack source.** The 11-line TS table is a second, divergent industry enumeration. Either derive it from `skills/packs/*.json` or make it a projection of the same data.

Estimated work: delete-only path 1 person-day; wire-in path 5 person-days.

---

## 4. Capability System — Does It Change Production Behaviour?

Yes, conditionally, through one specific wire.

| Stage | Evidence | Verdict |
|---|---|---|
| Provider publishes capability | `capability_providers.py` — `CapabilityProvider` ABC, `ProviderTier`, `ProviderUnavailable`, audience mandatory, deny by default | Real |
| Registry stores it | `capability_registry.py` — `visible_to(agent_key)`, `published_to_all`, `restricted`; module-level caches `_BASE_TOOLSETS_CACHE/_READY` | Real, cached |
| Router resolves per request | `capability_router.py:127 planned_toolsets(agent_key)`; `capability_router.py:294-305` iterates tools and runs `_check_fn_cached(check)` | Real, cached |
| **Request path consumes it** | `api/app.py:446-447` `chat_toolsets, chat_diag = resolve_toolsets_for_request(emp.key, capability_toolsets=_planned(emp.key))`, then `:457 toolsets=chat_toolsets` passed into `_build_agent` → `AIAgent(enabled_toolsets=...)` | **Real — this is the wire** |
| Gate protects execution | `install_enterprise_gate` (`gate_hook.py:295`), middleware `fail_closed = True` (`:292`), honoured at `clisupport/middleware.py:315-318` | Real |

So the answer is: **capability resolution does change which tools the model can call, and therefore changes production behaviour.** But two qualifications matter.

First, the capability system has never run in production, because the runtime process is never started. The chain is correct in code and unexercised in deployment.

Second, the project documents the exact failure mode this design was built to fix. `capability_providers.py:8-10` states: "The Capability Registry became the system bus in Phase 8.1.5. Every producer of agent-visible tools must therefore publish through it, or the same failure returns one layer down: a Media Hub that works, that nothing consults." And `app.py:438-443` records: "Phase 2a (R1): resolve toolset by agent, with availability filtering. Composite toolsets (safe/media/git...) previously never appeared in `registry.get_available_toolsets()`, so a capability that had been fixed was still never handed to the model."

That is a self-documented history of the precise defect class this audit is looking for. The fix is real; the lesson is that it was needed.

Third qualification: `PluginCapabilityProvider` exists among the eight providers, but because `SandboxPluginLoader.load_all()` is never invoked, the plugin provider has nothing to list. The capability layer is correct and starved of input.

---

## 5. Plugin System — Does It Enter the Agent Call Chain?

The mechanism is real and well built. The **invocation is missing**.

Real components:

| Component | Location | Evidence |
|---|---|---|
| Namespacing | `plugin_tools.py:98` `PLUGIN_TOOL_PREFIX = "plugin__"`; `:121-122` `plugin__<plugin>__<tool>` | Real |
| Tool registration into the live registry | `plugin_tools.py:290 register_plugin_tools()` → `:363 registry.register(...)` | Real code path |
| Sandbox bridge | `plugin_tools.py:208 PluginToolBridge` → `:234 PluginSandboxProcess` | Real, per-call process |
| Gate policy registry, one row per tool, glob explicitly refused | `plugin_tools.py:161` comment: "A glob such as `plugin__*` would authorise..."; `:503 plugin_gate_policies()` | **Correct security design** |
| Sandbox loader | `plugin_tools.py:528 SandboxPluginLoader`, module singleton at `:957` | Real |
| Discovery into the sandbox | `plugin_tools.py:904 candidates = self.discover_candidates(manager)` | Real |
| Runtime audit | `.roveagent/audit/plugin_sandbox.jsonl` — `{"action": "plugin_sandbox_loaded", "detail": "acme tools=3 capabilities=0"}`; `.roveagent/audit/tool_gate.jsonl` — `plugin__acme__greet` decisions | **Ran, but with test tenant ids (`tenant_id: "t"`, `"u"`, `"b"`)** |

Missing link:

- `SandboxPluginLoader.load_all()` callers are **only** `capability_closure_test.py`, `capability_governance_test.py`, `plugin_integration_test.py`.
- `kernel.py` contains exactly one skills-related import (`:29 from .skills.packs import IndustryPack, load_pack`) and **no plugin assembly**.
- `bootstrap.py` contains **zero** plugin, skill, or capability references.
- The HTTP plugin endpoints (`app.py:955-1005`) delegate lifecycle operations to `plugin_center`, which per its own note delegates to a dashboard API — they manage plugin records, they do not load plugin tools into the agent registry.

### Verdict

**Plugin does NOT enter the agent call chain in production.** The sandbox, trust model, gate-policy registry, and tool bridge are real, tested, and correctly designed — and `load_all()` is never called outside tests. This is the archetype of the failure mode this audit was commissioned to find.

Consequence in combination with the `ToolPolicy("*", "", LOW, NONE)` catch-all (`framework.py:134`): if `load_all()` were wired in without also fixing the catch-all, every plugin tool that lacked an enumerated policy row would execute with no permission check and no approval. The plugin gate-policy registry design (`:161`, one row per tool, no glob) is precisely the mitigation — and it is bypassed by the global catch-all sitting behind it.

---

## 6. Media / Social / Search — Real Call Paths

The requested chain is: user request → Agent → Capability → Provider → execution.

### Media

| Hop | Present | Evidence |
|---|---|---|
| User request | Yes | Image generation is reachable from `/api/agent/chat` via `chat/route.ts:787-801` `deliverRequestedFiles({ registry })` → `src/lib/agent/deliver.ts:152` → `src/lib/ai/image-generation.ts:91` |
| Agent | Yes | Triggered by the `needsImage` regex at `chat/route.ts:787` |
| Capability | Python: `MediaCapabilityProvider` adapts `core.image_gen_registry`, `core.video_gen_registry`, `core.tts_registry`. TS: none | Python only |
| Provider | TS: real `POST {baseUrl}/images/generations` with Bearer auth (`image-generation.ts:110`); fails closed with `{ok:false, reason:'no_image_model'}` (`:98-106`) | **Real** |
| Execution | Yes on the TS side | **TS image path is GREEN** |

Two parallel media stacks exist: the TS path (`image-generation.ts`, reachable) and the Python media hub (`api/media_hub.py:339`, unreachable). Video and audio have no TS implementation at all.

### Search

| Hop | Present |
|---|---|
| User request | Only via `/api/knowledge/ask` → RAG. **There is no web search.** `grep` for `web_search|tavily|serpapi|bing|duckduckgo|searxng|exa|perplexity|brave` across `src/**/*.ts*` returns **0 matches**. |
| Agent | No web search tool on the TS side |
| Capability | Python `SearchCapabilityProvider` adapts `core.web_search_registry` |
| Provider | Python only, unreachable |
| Execution | **Chain broken at hop 1 on the TS side.** Python chain is code-complete and unreachable. |

Additionally, the one retrieval path that does exist degrades silently. `src/app/api/knowledge/ask/route.ts:36-48` falls back to "latest 5 chunks" when the RPC errors or returns nothing, then injects them and lets the model cite them as `[1]…[5]`. Retrieval failure and zero-match are indistinguishable to the user.

### Social

| Hop | Present |
|---|---|
| User request | No publish path in TS. `grep social` over `src/**/*.ts*` yields only a UI label (`marketing/page.tsx:24,44`) and a prose prompt (`marketing/generate/route.ts:11`) |
| Agent | None |
| Capability | `SocialCapabilityProvider` declares `publish_social_post` / `validate_social_post` (`capability_providers.py:541-556`) |
| Provider | `roveagent/social/adapters.py:192-211` — base `publish()` **unconditionally raises `AdapterNotImplemented`**; docstring at `:19-20` states "no fallback, no stub response, and no simulated success." LinkedIn/TikTok/YouTube adapters override only `capabilities()`. `AdapterRegistry.implemented()` at `:292-303` detects real integrations by introspecting `type(adapter).publish is not PlatformAdapter.publish` | **Honest but unimplemented** |
| Execution | **Chain broken at hop 1 and hop 4.** |

The social subsystem deserves explicit credit: it advertises capabilities while its own introspection reports them unimplemented, and it refuses to fabricate success. This is the opposite of the usual failure mode and should be preserved as a pattern.

### Summary table

| Capability | Hop 1 user request | Hop 2 Agent | Hop 3 Capability | Hop 4 Provider | Hop 5 execution | Full chain |
|---|---|---|---|---|---|---|
| Image (TS) | Yes | Yes | No | Yes | Yes | **Partial — works without capability layer** |
| Image/Video/Audio (Python) | No | — | Yes | Yes | — | **Broken** |
| Web search | **No** | No | Yes (Python) | Yes (Python) | — | **Broken at hop 1** |
| RAG retrieval | Yes | Yes | — | Platform-bound (Coze) | Yes, with silent fallback | **Works, degrades silently** |
| Social | **No** | No | Yes (declares only) | Raises `AdapterNotImplemented` | — | **Broken at hops 1 and 4** |
| Document | Yes | Yes | No | In-process writers | Yes | **Complete (TS only)** |

---

## 7. Runtime Architecture Audit — Required Answer

Question: is there a dual Gateway? A duplicate Runtime? Duplicate Tool execution?

| Question | Answer | Evidence |
|---|---|---|
| Dual Gateway? | **Yes** | `api/app.py:306` is FastAPI with 22 routes. `gateway/platforms/api_server.py:146` is an aiohttp `BasePlatformAdapter` subclass with its own HTTP surface, reachable only via `gateway/run.py:17431`. No module-level `gateway` import exists anywhere in `api/`. |
| Duplicate Runtime? | **Yes — four agent loops** | 1. `core/conversation_loop.py:2094` (`while api_call_count < agent.max_iterations ...`) — canonical Python. 2. `gateway/run.py` — its own turn loop, session state, `stream_consumer.py` (3,320 lines), approval interception. 3. `packages/roveagent-core/src/runtime/agent-loop.ts:25` — 61-line bounded TS loop, imported at `src/lib/agent/gateway.ts:12,143`. 4. `src/lib/enterprise/tool-runtime.ts:219` — separate TS tool execution authority. |
| Duplicate Tool execution? | **Yes — three TS authorities plus one Python** | `AgentToolRegistry` (14 tools, model-visible), `executeEnterpriseTool` (6 tools, `/api/enterprise`, own permission/audit/timeout), `coding-agent/*` (own `permission-guard.ts`), `EnterpriseToolGate` (130+ tools). |

### Proposed final architecture: single execution core

```
Frontend
   |  SSE, 9 event types
API Layer (Next.js, control plane only)
   |  auth, tenant scope, RBAC, approval UI, audit, billing
   |  HTTP + X-RoveAgent-Key
RoveAgent Runtime (Python, execution plane -- the single core)
   |  api/app.py:306 -> 22 routes -> get_context() singleton
   |  capability resolution -> toolset -> AIAgent -> conversation_loop
   |  EnterpriseToolGate (schema -> context -> permission -> risk -> approval -> audit)
   |  Plugin/Media/Search/Social providers published through CapabilityProvider
RoveFrame Business Tool Adapter
   |  /api/internal/agent/business-data (service key + HMAC + tenant pairing)
Supabase business tables + approved external integrations
```

Rules that make this a single core rather than a diagram:

1. `gateway/` is deleted. `tools/*` lazy imports of `gateway.{session_context,status,config,run}` are removed first (`tools/registry.py:320`, `tools/send_message_tool.py:335`, `tools/approval.py:238`).
2. The TS `AgentToolRegistry` is retained **only** as the `RoveAgentUnavailable` fallback, and its tool set is frozen at read-only plus approval-draft. It does not grow.
3. `executeEnterpriseTool` (6 tools) is migrated into `AgentToolRegistry` so there is one TS authority.
4. `coding-agent/*` keeps its own worktree/apply engine but routes decisions through the same `agent_approvals` bus.
5. TS never duplicates capability, skill, plugin, or media-hub logic. It consumes Python endpoints, as `src/lib/roveagent/client.ts` (456 lines) already does.

---

## 8. Security Audit

### 8.1 Tool Gate

| Target | Current state | Gap |
|---|---|---|
| Default Deny | **Not met.** `framework.py:134` `ToolPolicy("*", "", RiskLevel.LOW, ApprovalPolicy.NONE)` | Catch-all grants any **registered** tool with empty permission and no approval. Unregistered tools are rejected (`:240-260`), and only that case. The code flags itself at `:133`: "do not add a tool without a matching policy row — the catch-all means unapproved direct execution." |
| Explicit Allow | Partial. Explicit policy rows exist (`:129-134`), but there is no assertion that policy rows cover all registered tools | Add a test asserting coverage equality |
| Full Audit | **Met.** Every decision including denials is written (`:296-316`) to `ROVEAGENT_ROOT/audit/tool_gate.jsonl` (`gate_hook.py:101-106`) | Audit lands on local disk, not in a database; lost on container recycle; separate from TS `audit_events` |

### 8.2 Approval

The rule the mission states is: HIGH and CRITICAL must always require approval, and no role may skip it automatically.

| Policy level | Actual behaviour for an owner caller | Evidence | Meets rule |
|---|---|---|---|
| `APPROVAL_POLICY.OWNER` | **Approval required, owner cannot self-approve.** `_ROLE_RANK[owner]=3`, required `owner=3`, test is `3 >= 3+1` = false | `framework.py:137,226`; empirically confirmed by test output: `enterprise gate BLOCKED tool=send_customer_recovery_campaign agent=marketing-agent role=owner approval=True policy=owner reason=approval required: owner` | **Yes** |
| `APPROVAL_POLICY.MANAGER` | **Auto-passes for owner and admin.** `3 >= 2+1` = true | `framework.py:226`; `terminal`, `write_file`, `send_message`, `patch` are MANAGER-level | **No** |
| No policy row (catch-all) | **No permission, no approval** | `framework.py:134` | **No** |

Mitigating finding: the flagship business flow — customer recovery campaign dispatch — is correctly OWNER-gated and has a passing test locking that behaviour. The gap is confined to MANAGER-level tools and the catch-all row.

Contract divergence: TS `canApprove` uses `ROLE_RANK[role] >= ROLE_RANK[requiredRole]` with **no +1** (`approvals.ts:73`) and hard-returns false for `requiredRole === 'admin'` (`:72`). Python uses `>= required + 1`. The two halves of the same approval bus disagree about who may approve. Pick the TS semantics (stricter, no skip) and apply it in Python.

Recommended rule for HIGH/CRITICAL: required_role must be `owner`; `rank >= required + 1` must be removed entirely; self-approval must be permitted only with an explicit audit marker, never silently.

### 8.3 Plugin Security

| Requirement | State |
|---|---|
| Third-party plugin cannot enter the main process | **Met in design.** `plugin_sandbox_runner.py` is a separate OS process; `plugin_isolation.py:572-580` explicitly refuses an in-process fallback; stdout is redirected so a plugin cannot forge JSON-RPC frames (`plugin_sandbox_runner.py:294-298`) |
| Sandbox level | **L2.** Process + scrubbed-env only. Filesystem readable, network reachable, `HOME/USER/SHELL/PATH` inherited (`plugin_isolation.py:431`) so `~/.ssh` is reachable |
| Container hardening | **Dead code.** `--network none --read-only --tmpfs --user 65534` at `plugin_isolation.py:514-532` is never executed because `plugin_tools.py:359,673` hardcode `SUBPROCESS` |
| Enforcement default | `enforce=False` (`plugin_isolation.py:328`) → an unavailable mode yields `allowed=True` with a note (`:388-395`) |
| Trust | `plugin_trust.py` real; `plugin_gate_policies()` emits one policy row per tool and explicitly refuses globs (`plugin_tools.py:161`) |
| Consent | Not verified |
| Supply chain | `/api/plugins/install` and `/api/skills/install` have **no signature or provenance verification** |

### 8.4 Secret Separation

| Secret | Intended use | Actual | Risk |
|---|---|---|---|
| `COZE_SUPABASE_SERVICE_ROLE_KEY` | Database superuser | **Also used as the credential-encryption key** (`crypto.ts:8`) | Rotating it makes every stored credential permanently undecryptable |
| `COZE_SUPABASE_JWT_SECRET` | Session signing | Independent | Plaintext in the same file; this secret can forge any session |
| `ROVEAGENT_API_KEY` | Service-to-service auth | **Also used as the approval HMAC secret** (`app.py:332`, defaulted equal at `roveagent-service.sh:68`) | Any holder of the shared key can mint valid `/api/agent/execute` and `/api/agent/tool/resolve` signatures — caller and approver become the same principal |
| `ENCRYPTION_SECRET` | Credential encryption | Absent from `deploy.env`; falls back to the service-role key | Encryption silently depends on a database credential |
| `SQUARE_APP_SECRET`, Stripe keys | Payments | Independent, encrypted at rest | Acceptable |

### 8.5 Permission Model

| Aspect | State |
|---|---|
| RBAC | Real. 3 roles, 26 permissions (`rbac.ts`). `protect{Tenant,Business}Mutation` enforces authenticate → scope → permission → durable intent → execute → outcome audit, and returns 503 if the audit write fails. |
| Authentication | Strong. `timingSafeEqual` (`auth-guard.ts:144`), HS256 alg allowlist (anti alg-confusion), 60s token cache, 5min role cache, fail-closed 401. |
| Single point | Weak. `proxy.ts` is the only mandatory gate for roughly 75 routes; `withAuth` covers 8. The documented third layer (`getAuthContext`) has zero callers, so "defence in depth" is documentation rather than code. |
| Tenant isolation | Application-level only. The app uses `service_role` exclusively and the RLS policies are `to service_role using (true) with check (true)`. Isolation rests on `tenant-db.ts` whitelists plus hand-written `.eq('tenant_id')`. 26 direct `getSupabaseClient().from()` call sites bypass the whitelist. |
| Escalation paths found | Catch-all tool policy; owner auto-skip on MANAGER policies; role rank semantics divergence; HMAC secret collapse; `getClientIp` trusting the first `x-forwarded-for` value; `/api/webhooks/[provider]` accepting tenant/business from query parameters with distinguishable responses. |

---

## 9. Code Quality Audit

| Dimension | Score | Basis |
|---|---|---|
| Single responsibility | 55 | `agent/chat/route.ts` 920 lines mixes six responsibilities; three `page.tsx` files exceed 1,250 lines |
| Circular dependency | 85 | No hard cycles found; `tools/*` lazy imports of `gateway.run` are latent coupling |
| Duplication | 45 | 4 agent loops, 4 tool authorities, 3 Supabase client factories, 2 audit sinks, 4 skill implementations, 2 skill marketplaces |
| Giant files | 35 | One file exceeds 10,000 lines |
| Type safety | 95 | `ts-check` PASS; `any` count is 0 (`: any`, `as any`, `<any>`, `Record<string, any>` all zero) |
| Comment quality | 95 | Comments explain why, not what. Best aspect of the codebase. |
| **Modularity composite** | **64** | |

Files exceeding 10,000 lines: **one** — `roveagent/gateway/run.py` at 30,947 lines, which is in the delete category.

### Deletion Recommendations

Immediate deletion, low risk:

| Item | Lines | Reason |
|---|---|---|
| `roveagent/gateway/run.py` | 30,947 | Not reachable from `create_app()` |
| `roveagent/gateway/platforms/` | ~15,000 | Same |
| `roveagent/gateway/{base,session,slash_commands,stream_consumer}.py` | ~15,000 | Same |
| `src/lib/agent/permissions/engine.ts` | 142 | Test-only caller |
| `src/lib/enterprise/memory.ts` | 144 | Test-only callers |
| `getAuthContext` + `RF_HEADERS` + injection chain | ~40 | Zero readers |
| `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` | 2 deps | Zero imports |
| `skills_library/` non-product content | 261 md | apple, creative, note-taking and similar, in an SMB restaurant product |

Core assets to preserve unchanged:

`src/lib/artifacts/*` (zero-dependency PDF/OOXML, genuine engineering value) · `src/lib/agent/approvals.ts` · `src/lib/mutation-guard.ts` · `src/lib/tenant-db.ts` · `src/lib/security/outbound-url.ts` · `packages/roveagent-core` · `roveagent/api/plugin_isolation.py` + `plugin_sandbox_runner.py` · `roveagent/tools/framework.py` · `src/lib/ai/failover.ts` · `src/components/ui/*`

Requires migration rather than deletion:

| Item | Action |
|---|---|
| `executeEnterpriseTool` (6 tools) | Fold into `AgentToolRegistry` |
| `skills_market/` (2,441 lines) | Either wire into `app.py` or delete — decide, do not leave |
| `src/lib/skills.ts` | Derive from `skills/packs/*.json` |
| Python `*.jsonl` audit sinks | Unify with Postgres `audit_events` |
| `gateway/config.py`, `gateway/status.py`, `gateway/session_context.py` | Keep only if `tools/*` lazy imports remain; remove with them |
| Three Supabase client factories | Split into auth client / data client |

---

## 10. Deployment Maturity

| Item | State |
|---|---|
| Docker | **Absent** — no Dockerfile anywhere |
| docker-compose | **Absent** |
| Environment | `/.env` (gitignored, holds `ROVEAGENT_*`) + `scripts/deploy.env` (**neither tracked nor gitignored**, holds live Supabase service-role key and JWT secret, 4 vars only) |
| Migration | `autoMigrate()` runs 3 SQL files at process start; `ssl: { rejectUnauthorized: false }` |
| Health check | `/api/health` exists but is public, leaks table names, and does not probe the Python runtime. Python `/api/health` (`app.py:350`) has no `Depends(auth)` and returns the tenant count. |
| Logging | `console.*` on TS; Python rotates under `ROVEAGENT_ROOT` |
| Monitoring | **Absent** — no APM, metrics, or tracing |
| Backup | **Absent** — no script |

### Steps from clone to running

Current count: **14 manual steps, and the result does not include a working agent.**

1. `pnpm install` 2. create `.env` 3. supply 4 Supabase values 4. generate `ENCRYPTION_SECRET` 5. resolve the Supabase pooler for DDL 6. run `scripts/migrate.sql` 7. run `scripts/migrate-business-tables.sql` 8. run `scripts/migrate-pilot-ready.sql` 9. run `scripts/migrate-rls.sql` 10. run `scripts/verify-rls.sql` 11. create an initial user 12. install Python 3.13 13. `pip install -e ".[web]"` (no lockfile) 14. start uvicorn manually, separately from the Node process.

Target: **one command.** `docker compose up` producing a healthy app with both planes, migrations applied, and `/api/health` reporting DB and Runtime status.

---

## 11. Intelligence Audit

| Capability | Present | Reachable in production | Evidence |
|---|---|---|---|
| Planning | Yes | No | `core/conversation_loop.py:2094` iteration loop; TS `runAgentLoop` with `maxIterations: 4` |
| Tool selection | Yes | Partially | TS: one non-streaming LLM call returns `tool_calls`, with a regex `deterministicToolPlan` fallback (`gateway.ts:41`) |
| Memory | Yes | Partially | TS `business_memories` + L2 writes; Python L0-L4 in `.roveagent/enterprise_memory.db` (local SQLite, unreachable) |
| Reflection | No | No | No reflection pass found in either plane |
| Self-improvement | Yes | No | Python skill self-learning loop (create → audit → improve → evaluate) per `__init__.py`; `skills_market/scanner.py`; unreachable |
| Long-horizon tasks | Yes | Yes | `agent_tasks` + `agent_task_runs` with atomic claim, 15-minute lease, idempotency keys, retry backoff |

Honest assessment: on the deployable side, the product is a single-turn RAG chat plus 14 tools (4 business reads, 3 approval drafts, 7 decoupled reads/drafts). Autonomous behaviour exists in code that never runs.

Credit where due: the project identified and solved the hardest product problem in this space. `request-class.ts:15` states the policy — "conservative: prefer misclassifying a tool request as chat (degrade with an explicit notice) over misclassifying ordinary chat as tool_execution" — and `chat/route.ts:631-655` hard-fails tool requests when the runtime is unavailable, with the comment "degrading would make the user believe the task ran when nothing happened — this is exactly the root cause of the Developer Agent fake-response complaint." That is a correct and rare design stance.

---

## 12. User Experience Audit

| Question | Answer | Evidence |
|---|---|---|
| Does the user know what the AI is doing? | Yes | `status` events (thinking / analyzing / callingTool / toolDone / generating / creatingFile) plus `StatusStrip` |
| Does the user know the runtime degraded? | Yes — best-in-class here | `runtime_status` is the first event emitted (`chat/route.ts:625`); amber banner for `fallback`, red `role="alert"` for `unavailable`, reconnect button (`status-strip.tsx:102-147`) |
| Does the user know if it failed? | Partially | 12 confirmed fake-success or silent-failure sites, listed below |
| Does the user know why they are waiting? | No | The longest wait — the non-streaming planning call — produces no output at all |

Confirmed fake-success and silent-failure sites:

| # | Location | Symptom | Severity |
|---|---|---|---|
| 1 | `business/products/generate/route.ts:45-50` | Malformed LLM JSON → **HTTP 200 plus a fabricated product** with hardcoded `category:'招牌菜'` in all locales | High |
| 2 | `knowledge/ask/route.ts:36-48` | Retrieval failure or zero match silently falls back to "latest 5 chunks", injected and cited as `[1]…[5]` | High |
| 3 | `business/page.tsx:330-345` | POST without `res.ok` check, then closes the modal and reloads | High |
| 4 | `marketing/page.tsx:155-162` | **"Saved" tick on a failed POST** | High |
| 5 | `hooks/use-sse.ts:92-96` | Throws on any `error` event, exiting the read loop; the server then continues and emits artifacts plus `done`, which are discarded. `onDone` never runs, so `X-Session-Id` is never adopted → one orphaned session per failed first turn | High |
| 6 | `[locale]/page.tsx:68-78` | Dashboard fetch with `.catch(()=>{})` and no loading or error UI anywhere in the file → AI team cards show "thinking" forever | High |
| 7 | `agent/page.tsx:1172-1190` | Artifact id absent from the map renders a permanent "Generating…" | Medium |
| 8 | `scheduler.ts:250-253, 270-274` | Square and IMAP failures still advance the watermark, so the throttle suppresses retry and mail may never import | High — data loss |
| 9 | `ai/usage-ledger.ts:58` | Sticky `dbUnavailable` latch; one insert error and accounting is in-memory forever | Medium |
| 10 | `notifications/outbox.ts:181-187` | Partial owner delivery marked `sent` unless all owners fail | Medium |
| 11 | `ai/model-registry.ts:432` | Any registry error yields an empty registry; UI reports "no providers" instead of "database down" | Medium |
| 12 | `scheduler.ts:132` | Channel delivery failure logged as `error.name` only; briefings silently never arrive | Medium |

Error text quality is bimodal: good examples hide technical detail behind a disclosure and make "Saved" impossible on a non-2xx; bad examples emit untranslated `HTTP ${status}` and hardcoded English network errors inside a trilingual product.

---

## 13. Final Scores

| Dimension | Score | One-line basis |
|---|---|---|
| Architecture | 60 | Layering intent is right; four agent loops, four tool authorities, one 40k-line unreachable parallel server, one dead auth layer |
| Performance | 52 | Primary path is non-streaming; a mandatory extra LLM round trip precedes any output; 7 serialised DB round trips before the first LLM call |
| Security | 63 | Encryption, gating, approval, SSRF and constant-time comparison are enterprise-grade; credential governance, sandbox level and application-only isolation are not |
| Stability | 55 | Lease/idempotency primitives are strong; one confirmed 1-line slot leak bricks a tenant after 4 messages; no circuit breaker, no jitter, no Supabase timeout |
| Code quality | 74 | `any` count 0, explanatory comments, 765 passing Python tests; offset by red TS tests, giant files and a 819k-line fork |
| Intelligence | 48 | Honest and auditable, but autonomous capability is 0 in the deployable configuration |
| Modularity | 64 | See section 9 |
| Deployment | 25 | No Dockerfile, no compose, no monitoring, no backup, 14 manual steps, no version control on the working tree |
| User experience | 62 | Runtime transparency is excellent; 12 fake-success sites and three permanent spinners |
| Commercial maturity | 40 | 85 percent control plane, 5 percent execution plane, 15 percent engineering |
| **Weighted composite** | **58 / 100** | |

### Deployment grade: Internal

Not Production-ready, and not yet a controlled Pilot. Proximate reasons: no build artifacts, no running process, no deployment path for the execution plane, 15 red tests, CI does not gate the build, the working tree is not under version control, and there is no monitoring or backup. The project's own `PRODUCTION_GATE_REPORT.md` reaches a compatible conclusion ("suitable for a controlled pilot; a live restaurant Beta is NO-GO"), and its `PILOT_READY_STATUS.md` preconditions could not be confirmed as executed in any environment during this audit.

---

## 14. What The Single Biggest Bottleneck Is

Not a technical problem. The two planes have never been delivered together.

**819,238 lines of Python AI runtime, and no Dockerfile.** Integration has always been: a developer starts `bash scripts/roveagent-service.sh` in one terminal and `pnpm dev` in another, on their own Windows machine. The evidence is a line in `.roveagent/logs/errors.log`:

```
roveagent/enterprise/approval_bridge.py:77
RuntimeError: approval bridge push failed: <urlopen error [WinError 10061] 目标计算机积极拒绝，无法连接。>
```

The runtime tried to push an approval event to Next.js, and Next.js was not running.

Four of the five P0 findings follow from this one condition. Because the runtime is unreachable, every tool request takes the `runtime_unavailable` branch, which triggers the 1-line concurrency-slot leak, which bricks a tenant's chat after four messages. Because the working tree is not under version control, there is no rollback, so the team cannot safely change anything, so debt compounds. Because CI does not gate the build and there is no test environment, 15 red tests go unaddressed and green stops meaning anything.
