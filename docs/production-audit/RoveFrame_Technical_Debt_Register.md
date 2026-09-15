# RoveFrame Technical Debt Register

Scope: itemised register of technical debt identified by read-only audit of `roveframe-src-latest` at working-tree state 2026-09-13.
Each item records location, evidence, why it exists, impact, severity, cost, and disposition.
No item has been remediated. No file was modified.

Disposition values: **DELETE** (remove, low risk) · **KEEP** (core asset, preserve) · **MIGRATE** (consolidate into an existing system) · **FIX** (correct in place).

---

## Summary

| Severity | Count | Effort to clear |
|---|---|---|
| P0 — blocks release | 5 | 5.5 person-days, excluding deployment work |
| P1 — required before release | 19 | ~35 person-days |
| P2 — hardening | 13 | ~20 person-days |
| P3 — hygiene | 8 | ~3 person-days |
| **Total** | **45** | **~64 person-days**, excluding Phase C deletion work |

Debt by category:

| Category | Items | Notes |
|---|---|---|
| Duplicate systems | 6 | 4 agent loops, 4 tool authorities, 3 Supabase factories, 2 audit sinks, 4 skill implementations, 2 skill marketplaces |
| Dead code | 6 | 40,000 lines of unreachable Python plus five smaller items |
| Correctness | 8 | Includes the one confirmed product-breaking defect |
| Security bypass | 6 | Gate catch-all, approval rank, HMAC collapse, mock LLM, permission single-point, application-only isolation |
| Reliability | 9 | No circuit breaker, no jitter, unbounded call paths, process-local state |
| Test debt | 3 | 15 red TS tests; CI does not gate; scheduler test asserts nothing |
| Documentation drift | 4 | Three claims contradicted by measurement |
| Process debt | 3 | No version control, ZIP-based snapshots, no test environment |

---

## Disposition 1 — DELETE Immediately (low risk)

| ID | Item | Location | Size | Evidence of deadness | Effort |
|---|---|---|---|---|---|
| DEL-1 | Parallel Python HTTP server | `roveagent/gateway/run.py` | 30,947 lines | Zero module-level `gateway` imports anywhere in `roveagent/api/`; entry point is `python -m gateway.run` (`run.py:10`); not referenced by `create_app()` | included in DEL-2 |
| DEL-2 | Parallel channel adapters | `roveagent/gateway/platforms/` | ~15,000 lines | `api_server.py:146` is an aiohttp `BasePlatformAdapter`, not FastAPI; reachable only via `run.py:17431` | 2–3 days, after the lazy imports are removed (see MIG-1) |
| DEL-3 | Unreachable gateway modules | `gateway/{base,session,slash_commands,stream_consumer}.py` and siblings | ~15,000 lines | Same | included in DEL-2 |
| DEL-4 | Dead auth fast-path layer | `getAuthContext`, `RF_HEADERS`, `injectRfHeaders` | ~40 lines | `getAuthContext` has **zero callers** in `src/`; `x-rf-*` headers are injected and never read | 0.5 day, after confirming `proxy.ts` uses only `stripRfHeaders` |
| DEL-5 | Path-policy permission engine | `src/lib/agent/permissions/engine.ts` | 142 lines | Only caller is `tests/agent-permissions.test.ts` | 0.5 hour |
| DEL-6 | Unused enterprise memory module | `src/lib/enterprise/memory.ts` | 144 lines | Only callers are `tests/enterprise-kernel.test.ts` and `tests/business-isolation.test.ts` | 0.5 hour |
| DEL-7 | Unused dependencies | `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` | 2 packages | Imported by zero files across `src/`, `scripts/`, `roveagent/` | 15 minutes |
| DEL-8 | Fourth skill implementation | `src/lib/skills.ts` | 11 lines | Hardcoded `INDUSTRY_SKILLS` whose industry set (restaurant, fastfood, cafe, retail, service) diverges from `skills/packs/*.json` (healthcare, hotel, restaurant, retail) | see MIG-4 |
| DEL-9 | Non-product vendored skill content | `roveagent/skills_library/` categories apple, creative, note-taking, autonomous-ai-agents, social-media | 261 md files | Read only by `skills/marketplace.py:26, 69` as a `*/*/SKILL.md` glob; content unrelated to an SMB restaurant product | see MIG-4 |

**Caution on DEL-1 through DEL-3**: `tools/registry.py:320`, `tools/send_message_tool.py:335`, and `tools/approval.py:238` lazily import `roveagent.gateway.{session_context,status,config,run}` inside function bodies. Deleting `gateway/` before removing those imports will break tool paths at runtime, not at import time — the failure will surface only when one of those tools is called. See MIG-1.

---

## Disposition 2 — KEEP (core assets, do not refactor)

| ID | Asset | Location | Why it is an asset |
|---|---|---|---|
| KEEP-1 | Approval bus | `src/lib/agent/approvals.ts` (483 lines) | Frozen canonical argument hashes, compare-and-swap claim, 15-minute executing lease with recovery, idempotency keys, role and expiry checks, full audit. Empirically the highest-quality module in the repository. The flagship recovery flow is correctly OWNER-gated and a passing test locks that behaviour. |
| KEEP-2 | Mutation guard | `src/lib/mutation-guard.ts` (151 lines) | Enforces authenticate → scope → permission → durable intent → execute → outcome audit, and returns 503 when the audit write fails. Fail-closed by construction. |
| KEEP-3 | Tenant-scoped data layer | `src/lib/tenant-db.ts` (241 lines) | Whitelist tables that must not be queried without scope, and throws rather than defaulting. |
| KEEP-4 | SSRF guard | `src/lib/security/outbound-url.ts` (295 lines) | Protocol allowlist, IP literal analysis including IPv4-mapped IPv6, DNS resolution re-check against rebinding, per-hop redirect re-validation, and refusal to follow redirects after a mutating method. |
| KEEP-5 | Bounded agent loop | `packages/roveagent-core/src/` (117 lines) | Iteration budget, canonical tool-call keys, repetition detection, and an explicit stop signal that halts remaining calls when approval is pending. No credentials, no database, no global state. |
| KEEP-6 | Zero-dependency document engine | `src/lib/artifacts/` — `pdf-writer.ts` (1,617), `extract.ts` (1,898), `doc-writers.ts` (870), `pptx-writer.ts` (223) | Real PDF and OOXML writers using only `node:fs`, `node:path`, `node:zlib`. `package.json` contains no duplicating library. Fails closed rather than emitting a broken file (`deliverable.ts:236-245`). |
| KEEP-7 | Plugin sandbox runner | `roveagent/api/plugin_sandbox_runner.py` (262 lines) | Separate OS process, JSON-RPC over stdio, stdout hijacked by the protocol so a plugin cannot forge frames, per-call error containment, no in-process fallback. |
| KEEP-8 | Plugin isolation model | `roveagent/api/plugin_isolation.py` (921 lines) | Explicitly distinguishes failure isolation from privilege isolation and refuses to run a container-requiring manifest when no container backend is available. The module docstring states plainly that process isolation must not be mistaken for a container. |
| KEEP-9 | Enterprise tool gate | `roveagent/tools/framework.py` (155 onward) | Schema, context, permission, risk, approval, and audit are all genuinely implemented, with denials audited. Wired fail-closed into middleware. |
| KEEP-10 | Provider failover | `src/lib/ai/failover.ts` (416 lines) | Explainable candidate order, refusal to switch after the first token has been emitted, and a structured `AllProvidersFailedError` carrying per-provider cause. |
| KEEP-11 | Social adapter honesty | `roveagent/social/adapters.py:192-303` | Base `publish()` unconditionally raises `AdapterNotImplemented`; the registry detects real integrations by introspecting whether the method was overridden. Worst-case behaviour is a clean error, not a simulated post. |

The 765 passing Python tests are the strongest quality signal found. They are real `unittest` classes with concrete assertions, they run offline, and at least one asserts an **invented** environment variable cannot leak (`plugin_isolation_test.py:620-626`) — the correct way to test an allowlist.

---

## Disposition 3 — MIGRATE (consolidate)

| ID | Item | From | To | Reason | Effort |
|---|---|---|---|---|---|
| MIG-1 | Lazy gateway coupling | `tools/registry.py:320`, `tools/send_message_tool.py:335`, `tools/approval.py:238` | Direct imports of the specific helpers, or removal | Function-body imports let `gateway.run` be pulled into the API process, and `tools/terminal_tool.py:3078` documents its import-time side effect leaking | 3–5 days |
| MIG-2 | Second TS tool authority | `src/lib/enterprise/tool-runtime.ts` (6 tools, own timeout, own audit, own permission check) | `AgentToolRegistry` | Two authorities means two audit trails and two permission semantics for the same concept | 2 days |
| MIG-3 | Supabase client factories | `getSupabaseClient`, `getFreshServiceClient`, `getCleanServiceClient` | One auth client plus one data client | Three factories are a workaround for session pollution of a shared singleton; the root cause is one client serving two roles | 2 days |
| MIG-4 | Skill systems | `src/lib/skills.ts`, `roveagent/skills/`, `roveagent/skills_library/`, `roveagent/skills_market/` | One industry-pack source plus one marketplace | Four implementations, five directory resolvers, and two divergent industry enumerations | 1–5 days |
| MIG-5 | Python audit sink | `ROVEAGENT_ROOT/audit/*.jsonl` | Postgres `audit_events` or a documented one-way sync | Local JSONL is lost on container recycle and cannot be queried alongside control-plane audit | 3 days |
| MIG-6 | Chat route responsibilities | `src/app/api/agent/chat/route.ts` (920 lines: session, runtime decision, artifact delivery, approval cards, memory) | Five modules | This file hosted the slot-leak defect; the mixing is why the defect was easy to introduce and hard to see | 3 days |
| MIG-7 | Coding agent approval path | `src/lib/coding-agent/permission-guard.ts` | `agent_approvals` bus | A third permission model for the same product | 1 day |

---

## P0 — Blocks Release

| ID | Problem | Location | Why it exists | Impact | Cost | Disposition |
|---|---|---|---|---|---|---|
| P0-1 | No deployment path for the Python runtime | `.coze:4` requires only `nodejs-24`; `scripts/start.sh` runs only `node dist/server.js`; no Dockerfile, compose, systemd or k8s; `scripts/deploy.env` has no `ROVEAGENT_*` | Integration has only ever been manual, two terminals on a developer machine. `.roveagent/logs/errors.log` records `approval bridge push failed: <urlopen error [WinError 10061]>` — the runtime called back to a Next.js server that was not running | 819,238 lines unreachable. All tool-class requests hard-fail. Product degrades to single-turn RAG plus 14 read-only tools | 3–5 days | FIX |
| P0-2 | Chat concurrency slot leak | `chat/route.ts:654, 719` exit before the `try` at `:750`; `slot.release()` exists only at `:904` and `:911`; `rate-limit.ts:44` has no TTL | Release was written for the happy path | Four tool-class messages cause permanent `429` for that tenant and business until restart. Triggered on the normal path while P0-1 is unfixed | **1 line** | FIX |
| P0-3 | `envLoaded` guard never set on the early-return path | `supabase-client.ts:42-46` | The deploy-env override was added to fix a wrong-database incident without re-checking the guard | `dotenv.config({ override: true })` runs on every DB call. 15 tests fail including 2 fail-closed security contracts. Process environment can never override the file | 3 lines | FIX |
| P0-4 | Working tree not under version control | `git rev-parse --show-toplevel` resolves to the parent; `?? roveframe-src-latest/`; last commit 2026-09-08; files to 2026-09-13; seven ZIP snapshots, newest 3 days stale | Repository root and source directory diverged | No rollback, no bisect, no provenance for the newest and most security-relevant code | 0.5 day | FIX |
| P0-5 | Live credentials in an unignored, untracked file | `scripts/deploy.env` — live service-role key (219 chars) and JWT secret (88 chars). `git ls-files` empty; `git check-ignore` no match. `AGENTS.md` states the opposite | Documented behaviour diverged from the file's actual state | A fresh clone has no credentials and falls back to platform-injected values pointing at the wrong database. Committing the tree as-is puts a superuser credential into git history | 0.5 day | FIX |

---

## P1 — Required Before Release

| ID | Problem | Location | Impact | Cost | Disposition |
|---|---|---|---|---|---|
| P1-1 | Primary answer path is not streamed | `router.ts:643` `stream: false`; `gateway.ts:163-165` yields once | Whole answer generated before the first character is shown. TTFT 2–9 s | 2–3 days | FIX |
| P1-2 | Mandatory planning LLM call before any output | `gateway.ts:68`, unconditional; `classifyRequest` result computed at `chat/route.ts:544` and unused for branching | Doubles LLM calls and latency on every message, including "hello" | 2–3 days | FIX |
| P1-3 | Memory extraction blocks `done` | `chat/route.ts:875` precedes `:897` | 0.8–3 s of spinner after the answer is already visible | 0.5 day | FIX |
| P1-4 | Untruncated 20-message history plus 48,000-char attachment allowance | `chat/route.ts:49, 52-53, 462-468, 503`; system prompt at `:139` demands long answers | Prompt growth compounds; sent to every LLM call | 0.5 day | FIX |
| P1-5 | Tool gate catch-all permits unapproved execution | `framework.py:134` `ToolPolicy("*", "", LOW, NONE)`; self-flagged at `:133` | Any registered tool without an enumerated policy row runs with no permission check and no approval | 1 day | FIX |
| P1-6 | Owner auto-skips MANAGER-level approval | `framework.py:226` `>= required + 1`; ranks at `:137` | `terminal`, `write_file`, `send_message`, `patch` unapproved for owner. Flagship recovery flow is correctly gated and unaffected | 0.5 day | FIX |
| P1-7 | Approval HMAC secret collapses onto the API key | `app.py:332`; `roveagent-service.sh:68` | Caller and approver become the same principal | 1 hour | FIX |
| P1-8 | Mock LLM indistinguishable from a real provider | `ROVEAGENT_TEST_MODE` has 0 occurrences under `roveagent/`; read only at `roveagent-service.sh:63, 110`; mock injected at `:115-117`; `runtime_status` still reports `roveagent` at `app.py:557`; repo `.env` has `TEST_MODE = true` | Fabricated answers rendered as healthy. Directly contradicts the product's core claim | 2 hours | FIX |
| P1-9 | Plugin sandbox is L2, and container mode is dead code | `plugin_tools.py:359, 673` hardcode `SUBPROCESS`; `plugin_isolation.py:328` `enforce=False`; `:514-532` container hardening never executed | Malicious plugin can read the host filesystem and make outbound calls; `HOME` inherited at `:431` so `~/.ssh` is reachable | 15 days | FIX |
| P1-10 | Plugin tools never load in production | `SandboxPluginLoader.load_all()` callers are only three `*_test.py` files; `kernel.py:29` has one skills import and no plugin assembly; `bootstrap.py` has zero plugin references; `plugin_tools.py:968` documents a sibling case: "`disable` existed and was tested, but nothing called it" | The plugin system does not enter the agent call chain | 5 days | FIX |
| P1-11 | Documented third auth layer is dead; `withAuth` covers 8 of 91 routes | `auth-guard.ts:280` zero callers; `withAuth` used in coding-agent ×4, customization, deployment, enterprise, healing | "Defence in depth" is documentation. Roughly 75 routes depend on `proxy.ts` alone | 2 days | FIX |
| P1-12 | Tenant isolation is application-level only | App uses `service_role` exclusively; `migrate-rls.sql` policies are `to service_role using (true) with check (true)`; 26 direct `getSupabaseClient().from()` call sites bypass `tenant-db.ts` | Any new route calling `.from()` directly can cross tenants. Disclosed honestly in `ARCHITECTURE.md:73-81` | 5–10 days | FIX |
| P1-13 | Client disconnect neither cancels generation nor releases the slot | `chat/route.ts:292-323` has no `cancel()`; `router.ts:865, 936` never `reader.cancel()`; `gateway.ts:177` does not forward the caller signal | A closed tab burns tokens up to 300 s and holds one of four slots | 1–2 days | FIX |
| P1-14 | No circuit breaker; no backoff jitter; Supabase REST has no timeout | Repo-wide zero matches for `circuit`, `breaker`, `halfOpen`. Backoff is `250 · 2^(n-1)` with no jitter. Platform model path has no timeout at all (`router.ts:505-511`) | A dead provider is retried on every request; provider recovery causes a thundering herd; an unbounded hang path exists | 3 days | FIX |
| P1-15 | Platform model and embeddings bound to Coze SDK | `router.ts:1, 505`; `embedding.ts:1, 6`; `api-helpers.ts:1, 5`; `supabase-client.ts:59-77` shells out to `python3 -c "...coze_workload_identity..."` on the DB bootstrap path | Self-hosting is impossible for the platform tier and for RAG. Embeddings have no provider abstraction at all | 3–5 days, 5–10 days | FIX |
| P1-16 | `tokenCache` grows unbounded on the local-JWT path | `auth-guard.ts:220`; prune at `:258-262` runs only in the remote-resolve branch; the local path writes at `:240` with no prune | Memory growth once `COZE_SUPABASE_JWT_SECRET` is configured | 0.5 day | FIX |
| P1-17 | Fabricated product returned with HTTP 200 | `business/products/generate/route.ts:45-50`; hardcoded `category: '招牌菜'` | Malformed model output is indistinguishable from success | 0.5 hour | FIX |
| P1-18 | RAG retrieval failure silently substitutes unrelated chunks | `knowledge/ask/route.ts:36-48` | Chunks are cited as sources `[1]…[5]` when nothing matched | 0.5 day | FIX |
| P1-19 | Scheduler advances watermarks on failure | `scheduler.ts:250-253` (Square), `:270-274` (IMAP) | Throttle suppresses retry; mail may never import; only `console.warn(error.name)` is emitted | 0.5 day | FIX |

---

## P2 — Hardening

| ID | Item | Location | Note |
|---|---|---|---|
| P2-1 | TLS verification disabled for the database connection | `migration.ts:84` `ssl: { rejectUnauthorized: false }` | MITM risk on DB traffic |
| P2-2 | `/api/health` public and leaks schema state; Python `/api/health` unauthenticated and returns tenant count | `health/route.ts:10-24`; `app.py:350-354` | Tenant enumeration |
| P2-3 | Client IP taken from the first `x-forwarded-for` value | `rate-limit.ts:139-148` | Spoofable; rate-limit bypass |
| P2-4 | `setTimeout` in `Promise.race` never cleared | `enterprise/tool-runtime.ts:280`, timeout at `:209` | Holds the event loop 30 s per tool call |
| P2-5 | Thirteen pieces of process-local state | rate-limit windows, backoff, slots; `tokenCache`; `roleCache`; settings cache; `wipeTokens`; platform-admin memory store; usage-ledger latch; scheduler flags | Rate limits scale with instance count; wipe confirmations fail across instances; admin sessions lost on restart |
| P2-6 | Usage ledger `dbUnavailable` is a sticky latch | `ai/usage-ledger.ts:58` | One insert error and AI accounting degrades permanently |
| P2-7 | Scheduler starts only under the custom server | `server.ts:63`; no `instrumentation.ts`, no cron workflow | Any `next start` deployment runs zero background work, silently |
| P2-8 | CI does not gate the build | `.github/workflows/ci.yml` (32 lines) vs `ARCHITECTURE.md:113` claiming eight gates | Green does not mean buildable |
| P2-9 | Webhook tenant enumeration oracle | `webhooks/[provider]/route.ts:13-17` accepts tenant and business from query parameters; unknown returns 409, known returns 401 or 500 | Signature still prevents action |
| P2-10 | Four unprotected read-modify-write paths in the scheduler | `maybePushAlerts`, `maybeSyncInboundEmail`, `maybeSyncSquare`, `pollTelegram` offset | Duplicate pushes, syncs, and boss replies under multiple instances |
| P2-11 | Seven serialised Supabase round trips before the first LLM request; `buildModelRegistry` uncached and run 2–4 times per turn | `chat/route.ts:373, 410, 433, 462, 471, 480, 483`; `gateway.ts:177` does not pass `chain` though `failover.ts:295` supports it | 0.3–0.9 s before any model work |
| P2-12 | Python dependencies are not reproducible | `pyproject.toml:15-48`; FastAPI and uvicorn are optional extras; no venv, lock, or requirements file | Environment cannot be rebuilt |
| P2-13 | Lazy `gateway.*` imports from `tools/*` | `tools/registry.py:320`, `tools/send_message_tool.py:335`, `tools/approval.py:238` | Can pull `gateway.run` and its import-time side effects into the API process |

---

## P3 — Hygiene

| ID | Item | Location |
|---|---|---|
| P3-1 | Permission token `'manage'` used by write tools is not defined in `ROLE_PERMISSIONS` | `tools/write-tools.ts:12`; `rbac.ts:5-32` — implicit owner-only |
| P3-2 | Memory extraction swallows all errors | `chat/route.ts:892-894` |
| P3-3 | Provider identity and HTTP status shown to the business owner | `status-strip.tsx:215-224`, contradicting `stream-events.ts:57-62` |
| P3-4 | Hardcoded English error strings in a trilingual product | `settings/page.tsx:321, 323, 438, 440, 477, 479` |
| P3-5 | `done` event carries `provider`, `model`, `reasoning`; the page ignores them | `chat/route.ts:897-901`; `agent/page.tsx:457-511` has no `case` for `done` |
| P3-6 | No `aria-live` on the streaming response bubble | `agent/page.tsx` |
| P3-7 | `getClientIp` returns the literal string `'unknown'` for all clients behind an unusual proxy | `rate-limit.ts:147` — all such clients share one bucket |
| P3-8 | `scheduler-mutex.test.ts` verifies source-text regexes and one self-fulfilling assertion | `tests/scheduler-mutex.test.ts:13-50` — never asserts the inner body was skipped |

---

## Documentation Drift

Documentation is treated as debt when it makes a claim contradicted by measurement, because it causes planning decisions to be made on false premises.

| ID | Claim | Location | Measured reality |
|---|---|---|---|
| DOC-1 | CI runs lint, unit and API and security tests, Python compilation and tests, RoveAgent end-to-end coverage, build verification, and production scans | `docs/current/ARCHITECTURE.md:113` | `ci.yml` runs four steps: install, ts-check, test, lint:build. Five of the claimed gates do not exist |
| DOC-2 | `245/245 tests PASS` | `docs/current/PRODUCTION_GATE_REPORT.md:31` | 591 of 606. Fifteen failures |
| DOC-3 | Deployment credentials live in `scripts/deploy.env`, committed to git | `AGENTS.md` ("部署注意") | `git ls-files scripts/deploy.env` is empty; `git check-ignore` does not match. The file is neither tracked nor ignored |
| DOC-4 | `278 pass`, TypeScript tests | `docs/current/PILOT_READY_STATUS.md:49` | 591 of 606 at audit time |

Note the pattern rather than the individual errors: the project's self-assessment documents systematically report completion above the code's actual state. This is why the audit was commissioned, and it means these documents must be regenerated from measurement, not amended.

---

## Process Debt

| ID | Item | Evidence | Impact |
|---|---|---|---|
| PROC-1 | Source is not under version control | `git rev-parse --show-toplevel` resolves to the parent; `?? roveframe-src-latest/` | No rollback; a single disk failure loses five days of work including the entire RoveAgent takeover |
| PROC-2 | ZIP snapshots used as versioning | Seven archives, named by date; `roveframe-src-latest.zip` dated 2026-09-10 while the tree contains files dated 2026-09-13 | Cannot answer "which ZIP is in production" |
| PROC-3 | No test environment | No `vercel.json`, no compose, no staging configuration | Nothing can be validated before users see it |

---

## Debt That Should Not Be Repaid

Recorded explicitly so it is not mistaken for a backlog item.

| Item | Why it should be left alone |
|---|---|
| The vendored Python fork as a whole | It is a maintained asset with 765 passing tests, not abandoned code. The debt is the wiring — no CI, no deploy path — not the code. Deleting it would remove the only execution plane |
| `src/lib/artifacts/*` file sizes | 1,898 and 1,617 lines implement binary format writers with no library dependency. The size is inherent to the problem |
| `packages/roveagent-core` being 117 lines | Small is correct here. It has no credentials, no database, and no global state by design |
| `src/components/ui/*` | shadcn template output. No value in restructuring |
| `skills_library/index-cache/lobehub_index.json` (251 KB) | Only meaningful if the corresponding content is kept. Decide with MIG-4 rather than separately |

---

## Recommended Clearance Order

| Order | Items | Effort | Rationale |
|---|---|---|---|
| 1 | P0-2, P0-3, P1-17, P1-18, P1-19 | 2 days | Correctness, low risk, high certainty. P0-2 is the only confirmed product-breaking defect |
| 2 | P0-4, P0-5 | 1 day | Without rollback, no later change is safe |
| 3 | P1-5, P1-6, P1-7, P1-8 | 2 days | Close the four bypasses that deploying the runtime would otherwise activate |
| 4 | P0-1, P2-12 | 5–6 days | Give the execution plane a deployment path |
| 5 | P2-8, plus CI wiring for the already-passing Python suite | 1 day | Make green mean something |
| 6 | DEL-7, DEL-4, DEL-5, DEL-6 | 0.5 day | Dead code removal, no dependencies |
| 7 | P1-1, P1-2, P1-3, P1-4, P2-11 | 6 days | Performance |
| 8 | MIG-1 then DEL-1 through DEL-3 | 6–8 days | Convergence, sequenced so nothing breaks |
| 9 | Remaining P1, then P2 | ~20 days | Hardening |
| 10 | MIG-2 through MIG-7 | ~13 days | Consolidation |
| 11 | DOC-1 through DOC-4, PROC-1 through PROC-3 | 2 days | Regenerate documents from measurement; adopt commit-per-snapshot |
