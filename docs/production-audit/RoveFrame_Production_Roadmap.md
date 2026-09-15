# RoveFrame Production Roadmap

Scope: phased remediation plan derived from the Current State Audit and the Performance Optimization Plan. Read-only; nothing in this document has been implemented.

Total estimated effort: **127–132 person-days** across four phases.
Phase A alone: **11–13 person-days**, and it is the only phase that should start now.

---

## Sequencing Rule

Three constraints determine the order, and violating them causes more harm than doing nothing.

1. **Fix the four bypasses before deploying the runtime.** Deploying the Python runtime alone activates four latent security gaps at once: the tool-gate catch-all, owner auto-skip on MANAGER policies, the HMAC secret collapse, and the mock-LLM indistinguishability. The product would move from "capability absent" to "capability present, bypassable, and capable of emitting fabricated answers" — a worse state for a product whose core claim is that it never fakes work.
2. **Fix the slot leak before any pooling or scaling work.** Pooling multiplies the leak.
3. **Put the tree under version control before touching anything.** Without rollback, no change is safe.

---

# Phase A — Production Security Hardening

Duration: 1–2 weeks. Effort: 11–13 person-days. No new features.

Exit criteria, all of which are executable and falsifiable:

1. `pnpm test` reports 606 of 606 passing.
2. `curl -H "X-RoveAgent-Key: ..." http://127.0.0.1:8788/api/health` returns 200.
3. `curl http://127.0.0.1:5000/api/health` reports both database and runtime status.
4. One `tool_execution` request executes for real and produces entries in both `tool_gate.jsonl` and `audit_events`.
5. Five consecutive tool-class requests, then a sixth ordinary chat request, succeeds — proving the slot leak is closed.
6. With `COZE_PROJECT_ENV=PROD` and a mock LLM base URL configured, the process refuses to start.
7. `git log` contains every change from this phase.

---

## Workstream A1 — Correctness Blockers

### A1.1 Close the chat concurrency slot leak

- **Problem**: `slot.release()` exists only at `agent/chat/route.ts:904`, inside the `finally` of the `try` opened at `:750`, and at `:911`, an outer catch that only covers the pre-stream setup phase. Two exits inside the SSE producer occur before line 750: the `return` at `:654` (runtime unavailable) and the `throw` at `:719`. Neither releases. `rate-limit.ts:44 slotStore` has no TTL and no prune, so a leaked slot is permanent.
- **Evidence**: `chat/route.ts:374, 378, 654, 719, 750, 902-905, 911`; `rate-limit.ts:44, 118-136`.
- **Impact**: Four tool-class messages from one tenant plus business cause `429 too_many_concurrent_chats` on every subsequent chat until the process restarts. In the current production configuration every tool-class message takes the `runtime_unavailable` branch, so the leak is triggered on the normal path. This is the only confirmed defect that makes the product unusable.
- **Solution**: Move `slot.release()` into a `try/finally` that encloses the entire producer body, including lines 622–905. Do not add a TTL as a substitute — a TTL hides the bug rather than fixing it.
- **Risk**: Very low. Single-line change; the release function is already idempotent (`rate-limit.ts:124-134` uses a `released` flag).
- **Effort**: 1 line, under 1 hour including a regression test.

### A1.2 Fix the `envLoaded` guard in the Supabase client

- **Problem**: `supabase-client.ts:42-46` calls `loadDeployEnvFile()` when `envLoaded` is false, then returns early when URL and anon key are present — without ever setting `envLoaded = true`. Therefore `dotenv.config({ override: true })` runs on **every** `getSupabaseClient()` call.
- **Evidence**: `supabase-client.ts:42-46`; `[dotenv@17.2.3] injecting env (4) from scripts\deploy.env` interleaved between test assertions; isolating the test file to a working directory without `scripts/deploy.env` yields 6 of 6 passing, while the repo root yields 2 failures.
- **Impact**: Three effects. Fifteen tests fail, including two production fail-closed security contracts. The process environment can never override the file, so environment-based configuration and secret rotation are broken. A synchronous file read and parse sits on the database hot path.
- **Solution**: Set `envLoaded = true` before the early return, or read the file at most once per process, guarded by a module-level flag independent of `envLoaded`.
- **Risk**: Low. The deploy-env override exists to correct a real incident where the platform injected credentials pointing at the wrong database (`AGENTS.md`, "连接真相"). The fix must preserve that override-on-first-read behaviour while eliminating the per-call repetition.
- **Effort**: 3 lines, 0.5 day including test verification.

### A1.3 Remove the fabricated-product response

- **Problem**: `src/app/api/business/products/generate/route.ts:45-50` catches a JSON parse failure and returns HTTP 200 with a fabricated product, including a hardcoded `category: '招牌菜'` in every locale.
- **Evidence**: `route.ts:45-50`.
- **Impact**: A malformed model reply is indistinguishable from success. The user receives a saved-looking product that the model never produced.
- **Solution**: Return a structured non-200 with the parse failure, or fall back to the deterministic template that the same file already uses elsewhere and label the response as `source: 'fallback'`.
- **Risk**: Very low.
- **Effort**: 0.5 hour.

### A1.4 Remove the silent retrieval fallback in RAG

- **Problem**: `src/app/api/knowledge/ask/route.ts:36-48` degrades to "latest 5 chunks" when the RPC errors or returns no match, then injects those chunks and lets the model cite them as `[1]…[5]`.
- **Evidence**: `route.ts:36-48`.
- **Impact**: The user cannot distinguish a matched answer from one built on unrelated documents. This is the banned silent-fallback pattern, and it is the one place where the product presents retrieval as authoritative when it is not.
- **Solution**: Return an explicit `retrieval: 'unavailable' | 'no_match' | 'matched'` signal; when unavailable or unmatched, tell the user plainly and do not inject arbitrary chunks as sources.
- **Risk**: Low. Changes user-visible behaviour on the failure path only.
- **Effort**: 0.5 day.

### A1.5 Stop advancing scheduler watermarks on failure

- **Problem**: `scheduler.ts:250-253` writes `last_sync_at` for Square even when the sync threw, and `:270-274` does the same for IMAP. The 15-minute and 5-minute throttles then suppress the retry.
- **Evidence**: `scheduler.ts:243-254, 257-275`.
- **Impact**: Data loss. Mail may never be imported, and POS orders may never be reconciled, with no error surfaced beyond a `console.warn` that logs only `error.name`.
- **Solution**: Advance the watermark only on success. On failure, leave it and let the next tick retry, with a bounded attempt counter to avoid a hot loop.
- **Risk**: Low. Requires a retry ceiling so a permanently failing account does not retry every 60 seconds forever.
- **Effort**: 0.5 day.

### A1.6 Fix the SSE consumer's error handling

- **Problem**: `src/hooks/use-sse.ts:92-96` throws on any payload containing a string `error`, exiting the read loop. The server emits `error` and then continues, emitting artifacts at `chat/route.ts:750-806` and `done` at `:897`. Those are discarded. `onDone` never runs, so `X-Session-Id` from `chat/route.ts:907` is never adopted.
- **Evidence**: `use-sse.ts:92-96`; `chat/route.ts:708-716, 750-806, 897, 907`.
- **Impact**: Two effects. Successfully produced artifacts are thrown away after a recoverable error. Every failed first turn orphans a chat session, because the next message creates another one.
- **Solution**: Record the error, surface it, and continue reading until the stream closes. Adopt `X-Session-Id` from the response headers rather than only from `done`.
- **Risk**: Low.
- **Effort**: 0.5 day.

---

## Workstream A2 — Security Bypass Closure

Must complete before A3.

### A2.1 Make the tool gate deny by default

- **Problem**: `tools/framework.py:134` registers `ToolPolicy("*", "", RiskLevel.LOW, ApprovalPolicy.NONE)`. It matches any **registered** tool, granting empty permission and no approval. Unregistered tools are rejected at `:240-260`, and only that case.
- **Evidence**: `framework.py:133-134` — the code's own comment reads "do not add a tool outside these rows without adding a policy row — the catch-all means unapproved direct execution."
- **Impact**: Any tool added to the registry without a matching policy row executes with no permission check and no approval. The exposure set is "registered tools lacking an enumerated policy," and nothing guarantees that set is empty.
- **Solution**: Replace the catch-all with a denying default requiring an owner-level approval, and add a test asserting that the count of registered tools equals the count of covered policy rows.
- **Risk**: Medium. A denying default will block tools that currently work by accident. Enumerate the current registry first and add policy rows deliberately; do not flip the default and discover the gaps in production.
- **Effort**: 1 day.

### A2.2 Remove role-rank auto-skip on MANAGER policies

- **Problem**: `tools/framework.py:226` returns `_ROLE_RANK.get(ctx.role, 0) >= _ROLE_RANK[required_role] + 1`. With `_ROLE_RANK = {viewer: 0, staff: 1, manager: 2, owner: 3, admin: 4}` at `:137`, an owner (3) satisfies `3 >= 2+1` for a MANAGER policy and executes with no approval.
- **Evidence**: `framework.py:137, 226`. Empirically confirmed in the passing test output, which shows that OWNER-level policy **does** still block an owner: `enterprise gate BLOCKED tool=send_customer_recovery_campaign agent=marketing-agent role=owner approval=True policy=owner reason=approval required: owner`.
- **Impact**: `terminal`, `write_file`, `send_message`, and `patch` are MANAGER-level and therefore unapproved for the owner. The flagship customer-recovery flow is correctly OWNER-gated and unaffected — the gap is confined to MANAGER-level tools and the catch-all row.
- **Solution**: Remove the `+ 1`. Require that HIGH and CRITICAL risk always produce an approval. Permit self-approval only with an explicit audit marker, never silently.
- **Risk**: Medium. Owners will begin seeing approval prompts for operations they previously performed directly. That is the intended behaviour, but it changes the daily workflow and should be communicated.
- **Effort**: 0.5 day.

### A2.3 Unify approval semantics across the two planes

- **Problem**: TS `canApprove` uses `ROLE_RANK[role] >= ROLE_RANK[requiredRole]` with no offset, and hard-returns false for `requiredRole === 'admin'` (`approvals.ts:72-74`). Python uses `>= required + 1` (`framework.py:226`). The two halves of the same approval bus disagree about who may approve.
- **Evidence**: `approvals.ts:72-74`; `framework.py:226`.
- **Impact**: An approval decision validated on one plane may be rejected on the other, producing approvals that cannot be completed or actions that bypass review depending on which path is taken.
- **Solution**: Adopt the TS semantics — no offset, stricter, no automatic skip — and apply them in Python. Add a contract test that drives both implementations with the same role and required-role matrix and asserts equal verdicts.
- **Risk**: Low.
- **Effort**: 0.5 day. Depends on A2.2.

### A2.4 Separate the approval HMAC secret from the API key

- **Problem**: `api/app.py:332` uses `os.environ.get("ROVEAGENT_APPROVAL_SECRET") or os.environ.get("ROVEAGENT_API_KEY", "")`, and `scripts/roveagent-service.sh:68` defaults the former to the latter. Anyone holding `X-RoveAgent-Key` can mint valid signatures for `/api/agent/execute` and `/api/agent/tool/resolve` — the approval endpoints.
- **Evidence**: `app.py:332`; `roveagent-service.sh:57-61, 68`.
- **Impact**: Separation of duty between "authenticated caller" and "approver" is nominal. Combined with A2.1 and A2.2, a shared-key holder could achieve unapproved execution with a valid signature.
- **Solution**: Delete the fallback. Refuse to start when `ROVEAGENT_APPROVAL_SECRET` is absent. Remove the defaulted equality from the launcher and from `.env.example`.
- **Risk**: Low. Requires setting the variable in every environment. The current `.env` already has distinct values, so local development is unaffected.
- **Effort**: 1 hour.

### A2.5 Make the mock LLM impossible to mistake for a real provider

- **Problem**: `ROVEAGENT_TEST_MODE` is read only by `scripts/roveagent-service.sh:63, 110`. It has **zero occurrences** inside `roveagent/`. When the launcher sees `TEST_MODE=true` and no real key, it starts `scripts/mock_llm_provider.py`, a stdlib OpenAI-compatible server returning canned deterministic text, and injects `ROVEAGENT_LLM_BASE_URL=http://127.0.0.1:8799/v1` with `ROVEAGENT_LLM_API_KEY="mock-test-key"` at `:115-117`. The runtime then reports `runtime_status` with mode `"roveagent"` at `app.py:557`, which the frontend renders as healthy. The repository's `.env` currently contains `ROVEAGENT_TEST_MODE = true`.
- **Evidence**: zero `ROVEAGENT_TEST_MODE` hits under `roveagent/`; `roveagent-service.sh:110-119`; `app.py:557`.
- **Impact**: Answers are fabricated and indistinguishable from real ones at the UI layer. This is the exact failure mode the project's own design principles forbid, and the shipped configuration is already in the triggering state.
- **Solution**: Three layers. The mock path must set a distinguishable model identity and have `runtime_status.detail` state `mock`. The `RuntimeMode` union should gain a fourth value, `mock`, rendered in red with no implication of real answers. `server.ts` should refuse to start when `COZE_PROJECT_ENV=PROD` and the LLM base URL resolves to the mock port, reusing the existing `RF_E2E_DEMO` fail-closed pattern at `server.ts:13-15`.
- **Risk**: Low.
- **Effort**: 2 hours.

---

## Workstream A3 — Deployment Enablement

Must follow A2.

### A3.1 Put the working tree under version control

- **Problem**: `git rev-parse --show-toplevel` resolves to the **parent** directory, and `git status` reports `?? roveframe-src-latest/`. The last commit is `7a7f90d` dated 2026-09-08; files in the audited tree carry timestamps up to 2026-09-13. Version management is seven ZIP snapshots, the newest dated 2026-09-10 — three days stale.
- **Evidence**: git toplevel resolution; `?? roveframe-src-latest/`; commit `7a7f90d` date; file timestamps; ZIP inventory.
- **Impact**: No rollback, no bisect, no provenance, no review trail for the newest and most security-relevant code, which includes the entire RoveAgent takeover.
- **Solution**: Add the tree, commit, and adopt a commit-per-snapshot discipline. Retire the ZIP workflow.
- **Risk**: Low. One caution: `scripts/deploy.env` must be gitignored first (A3.2), or live credentials enter history.
- **Effort**: 0.5 day.

### A3.2 Remove live credentials from the working tree

- **Problem**: `scripts/deploy.env` contains a live Supabase service-role key and JWT secret. `git ls-files scripts/deploy.env` returns empty, so it is not tracked; `git check-ignore` returns nothing, so it is not ignored either. `AGENTS.md` states the file is committed to git, which is not true of the current tree.
- **Evidence**: `git ls-files` empty; `git check-ignore` no match; masked contents show four variables; `AGENTS.md` states the opposite.
- **Impact**: Two directions. A fresh clone has no database credentials and silently falls back to platform-injected `COZE_SUPABASE_*` pointing at the wrong database — the exact incident the file was created to fix. Conversely, if anyone commits the tree as-is, a database superuser credential and a session-signing secret enter git history permanently.
- **Solution**: Add `scripts/deploy.env` to `.gitignore`. Generate `scripts/deploy.env.example` with placeholders. Move real values to platform secret injection or a secrets manager.
- **Risk**: Low.
- **Effort**: 0.5 day.

### A3.3 Give the Python runtime a deployment path

- **Problem**: No Dockerfile, no docker-compose, no systemd unit, no Kubernetes manifest. `.coze` requires only `["nodejs-24"]` and wires deploy to `scripts/start.sh`, which runs only `PORT=... node dist/server.js`. None of the five build or start scripts reference `roveagent`, `python`, `uvicorn`, `8788`, or `ROVEAGENT`. `scripts/roveagent-service.sh` is documented as a development-environment script and is referenced by no build or CI file. `scripts/deploy.env` carries no `ROVEAGENT_*` variables.
- **Evidence**: `.coze:4, 11-17`; `scripts/{build,start,dev,prepare}.sh`; `scripts/deploy.env`; `scripts/roveagent-service.sh:1-4`.
- **Impact**: `roveAgentConfigured()` is false in any real deployment. Every tool-class request takes `runtime_unavailable` and hard-fails. The entire execution plane — 819,238 lines, the agent loop, 130-plus tools, the skill system, memory, the plugin sandbox, capability resolution, media, social — is unreachable. Product behaviour degrades to single-turn RAG chat plus 14 read-only and approval-draft tools.
- **Solution**: Add a Dockerfile with a Node 24 and Python 3.13 multi-stage build, or run two containers with an orchestrator. Start uvicorn under supervision with a restart policy and a liveness probe. Write `ROVEAGENT_API_URL`, `ROVEAGENT_API_KEY`, and `ROVEAGENT_APPROVAL_SECRET` into the deployment secret set. Extend `/api/health` to report the runtime probe result, and add a runtime probe to the boot check.
- **Risk**: Medium. This is the change that activates the four bypasses if A2 is incomplete. It also introduces the first real process-topology change, and the runtime needs `ROVEAGENT_ROOT` pinned to a persistent volume — `roveagent-service.sh:82-88` already warns that `ROVEAGENT_HOME` and `ROVEAGENT_ROOT` must be aligned or state splits across two roots.
- **Effort**: 3–5 days.

### A3.4 Make Python dependencies reproducible

- **Problem**: `pyproject.toml:15-41` declares 25 exact-pinned runtime dependencies, but FastAPI, uvicorn, and starlette are optional extras under `[web]` at `:48` rather than core, despite being imported on the startup path. No venv, no `.venv`, no `requirements*.txt`, no `uv.lock`, no `poetry.lock`. Dependencies exist only in the system interpreter.
- **Evidence**: `pyproject.toml:10, 15-48`; absent lock files; `roveagent-service.sh:35-51` performs a dependency precheck that detects the problem but does not solve it.
- **Impact**: The runtime cannot be rebuilt in a clean environment. Any missing dependency causes a startup failure detected only by the launcher's precheck.
- **Solution**: Generate a lock file, promote the `web` extra to a required dependency group, and consume the lock in the image build.
- **Risk**: Low.
- **Effort**: 1 day.

### A3.5 Make CI gate the build

- **Problem**: `.github/workflows/ci.yml` runs only `pnpm install`, `pnpm ts-check`, `pnpm test`, and `pnpm lint:build`. `ARCHITECTURE.md:113` claims CI also runs lint, unit, API and security tests, Python compilation and tests, RoveAgent end-to-end coverage, build verification, and production scans. Five of those gates do not exist. `package.json` defines `test:python` but it is absent from the `validate` script and referenced by no workflow.
- **Evidence**: `ci.yml`; `ARCHITECTURE.md:113`; `package.json` scripts; Python suite passes 765 of 765 when run manually.
- **Impact**: CI green does not mean the product builds or runs. Fifteen failing tests go unaddressed.
- **Solution**: Add `pnpm lint:style`, `pnpm validate:migrations`, `pnpm scan:production`, `pnpm build`, a `setup-python` job running `pnpm test:python`, and a Docker build. Declare a red line: no merge on red.
- **Risk**: Low. Expect the first run to fail; that is the point.
- **Effort**: 1 day.

### A3.6 Provision a CJK font

- **Problem**: `public/fonts/` contains only `README.md`. `pdf-writer.ts:761` scans `process.cwd()/public/fonts` and falls back to system fonts; a slim Linux container has none. `deliverable.ts:236-245` then refuses to emit a PDF containing Unicode text rather than producing a broken one.
- **Evidence**: `public/fonts/` contents; `pdf-writer.ts:761, 788-831`; `deliverable.ts:236-245`; `scripts/setup-pdf-font.mjs` exists but is not invoked by `build.sh`.
- **Impact**: Every Chinese PDF request degrades to docx or html. The fail-closed behaviour is correct; the missing asset is the defect.
- **Solution**: Vendor the font into `public/fonts/` and invoke the setup script from `build.sh`, or bake the font into the image.
- **Risk**: Low. Check font licensing before vendoring.
- **Effort**: 0.5 day.

### A3.7 Harden the health endpoints

- **Problem**: `/api/health` (TS) is public, leaks the missing-table list and scheduler degradation state, and does not probe the runtime. Python `/api/health` at `app.py:350` has no `Depends(auth)` and returns `"tenants": len(ctx.kernel.tenants.list())` at `:354`.
- **Evidence**: `health/route.ts:10-24`; `auth-guard.ts:57`; `app.py:350-354`.
- **Impact**: Unauthenticated parties can enumerate schema state and platform tenant count.
- **Solution**: Split each endpoint. A public liveness endpoint returns `{ status }` only. An authenticated detail endpoint carries table checks, scheduler state, runtime probe results, and tenant counts.
- **Risk**: Low. Any external uptime monitor must be updated to the new path.
- **Effort**: 0.5 day.

---

## Workstream A4 — Frontend Truthfulness

### A4.1 Remove fake-success states

- **Problem**: Five confirmed sites. `business/page.tsx:330-345` posts without checking `res.ok`, then closes the dialog, resets the form, and reloads. `marketing/page.tsx:155-162` shows a "Saved" tick on a failed POST. `agent/page.tsx:579-583` drops attachment upload failures with `if (!response.ok) continue`. `business/page.tsx:186-188` never checks `res.ok` on a staff photo upload. `layout/topbar.tsx:50-53` optimistically marks alerts read with no rollback.
- **Evidence**: the five locations above.
- **Impact**: Users believe data was saved when it was not. This directly contradicts the product's stated design stance.
- **Solution**: Check `res.ok` before any success state. On failure, keep the dialog open and surface the error. Add rollback for the optimistic alert update.
- **Risk**: Low.
- **Effort**: 1 day.

### A4.2 Remove the permanent-spinner paths

- **Problem**: Three sites. `[locale]/page.tsx:68-78` fetches with `.catch(()=>{})` and has no loading, error, or retry UI anywhere in the file, so AI team cards show "thinking" forever. `agent/page.tsx:1172-1190` renders a permanent "Generating…" for any artifact id absent from the map, and a failed history fetch via `safeFetchJson` leaves every historical card spinning. `hooks/use-sse.ts:62-67` sets no timeout, so a stalled stream leaves a pending read forever.
- **Evidence**: the three locations above.
- **Impact**: The user cannot tell a slow load from a dead one, and has no recovery action.
- **Solution**: Add explicit loading, error, and retry states. Add a timeout to the SSE reader. Distinguish "not loaded" from "generating."
- **Risk**: Low.
- **Effort**: 1 day.

---

# Phase B — Performance Optimization

Duration: 3–4 weeks. Effort: 15 person-days. Starts only after Phase A exits.

Source: `RoveFrame_Performance_Optimization_Plan.md`, section 10.

| ID | Task | Target metric | Effort |
|---|---|---|---|
| B1 | Add phase instrumentation: `ttft_ms`, `pre_llm_db_ms`, `planning_llm_ms`, `synthesis_llm_ms`, `llm_calls_per_turn`, `prompt_chars`, `post_answer_ms` | Enables measurement for all later items | 1 day |
| B2 | Move the memory-extraction call out of the blocking path (`chat/route.ts:875` precedes `:897`) | Time from last answer token to `done`: 0.8–3 s → under 50 ms | 0.5 day |
| B3 | Fast Path: gate the planner call on `classifyRequest`, which is already computed at `chat/route.ts:544` | Simple-question LLM calls: 2 → 1 | 2 days |
| B4 | Stream the Simple path through `streamChat` (`router.ts:517`) instead of the non-streaming planner | Simple-question TTFT: 2–9 s → under 1.2 s | included in B3 |
| B5 | Truncate history by character budget; reduce attachments from 4 × 12,000 to 2 × 6,000 | Prompt characters: up to 55,000 → under 15,000 | 0.5 day |
| B6 | Memoise `buildModelRegistry` per request; pass `chain` at `gateway.ts:177` so `failover.ts:295` is used | Model resolution: 4× → 1× per turn | 1 day |
| B7 | Parallelise the session read, message count, and history query in `chat/route.ts`; merge the user-message insert | Serialised DB round trips before the LLM: 7 → 3 | 2 days |
| B8 | Slim tool schemas: cap descriptions at 80 characters, drop redundant `additionalProperties`, omit `tools[]` on the synthesis call | Tool tokens: −50 to −80 percent | 1 day |
| B9 | Unify `max_tokens`; add backoff jitter; add a circuit breaker keyed on `ai_usage_ledger` failure streaks; forward `AbortSignal` into `streamChatWithFailover` and the platform model path | Removes the 900 s worst case; enables fast provider shedding | 3 days |
| B10 | Bound platform-model calls with a timeout (`router.ts:505-511` currently has none) | Removes an unbounded hang path | 0.5 day |
| B11 | Concurrency: replace the process-local chat slot with a `claim_chat_slot` RPC following the `claim_daily_briefing_slot` pattern; add per-risk tool semaphores sharing `registry.ts:48-66`'s correct timer handling | Correct limits under horizontal scaling | 3 days |

Phase B exit criteria: simple-question TTFT under 1.2 s, LLM calls per simple turn of 1, at most 3 serialised DB round trips before the first LLM call, and no unbounded call path.

---

# Phase C — Architecture Convergence

Duration: 6–8 weeks. Effort: 17–20 person-days. May partially overlap Phase B.

Order matters: C1 must precede C2, or deletion will strip modules that still have lazy importers.

| ID | Task | Outcome | Effort |
|---|---|---|---|
| C1 | Remove lazy `gateway.*` imports from `tools/registry.py:320`, `tools/send_message_tool.py:335`, `tools/approval.py:238`, and siblings | Breaks the one-directional coupling that lets `gateway.run` leak into the API process | 3–5 days |
| C2 | Delete `gateway/run.py` (30,947 lines), `gateway/platforms/` (~15,000 lines), and unreachable `gateway/` modules (~15,000 lines) | −40,000 lines; the only file over 10,000 lines disappears | 2–3 days |
| C3 | Migrate `executeEnterpriseTool`'s 6 tools into `AgentToolRegistry` | Tool execution authorities: 4 → 1 | 2 days |
| C4 | Split `getSupabaseClient` into an auth client and a data client; retire the three-factory pattern | Removes the root cause that produced `getFreshServiceClient` and `getCleanServiceClient` | 2 days |
| C5 | Apply the TS approval semantics in Python per A2.3; add a cross-plane contract test | One approval semantics | included in A2.3 |
| C6 | Delete dead code: `getAuthContext` plus the `RF_HEADERS` chain, `agent/permissions/engine.ts`, `enterprise/memory.ts`, `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` | Removes six dead items and two heavy dependencies | 1 day |
| C7 | Unify audit sinks: Python `*.jsonl` into Postgres `audit_events`, or a documented one-way sync | One queryable audit trail | 3 days |
| C8 | Split `app/api/agent/chat/route.ts` into five modules: session, runtime decision, artifact delivery, approval cards, memory | Removes the 920-line file that hosted the slot-leak defect | 3 days |
| C9 | Decide the `skills_market/` question and act: wire it into `app.py`, or delete it | Removes a 2,441-line unreachable marketplace | 1–5 days |
| C10 | Enforce `tenant-db.ts` whitelists with a lint rule banning direct `getSupabaseClient().from()` inside `src/app/api` | Tenant isolation moves from convention to enforcement | 2 days |

Phase C exit criteria: Python line count down by roughly 40,000; one tool execution authority; one approval semantics; one audit sink; no dead auth layer; lint prevents unscoped table access.

---

# Phase D — Commercialisation

Duration: 12+ weeks. Effort: 41 person-days. Starts only after C is substantially complete.

| ID | Task | Outcome | Effort |
|---|---|---|---|
| D1 | Observability: structured logs, request-id propagation across both planes, key metrics, alerting | Faults are detected before users report them | 8 days |
| D2 | Backup and restore scripts plus a rehearsal | Recoverability | 3 days |
| D3 | Sandbox upgrade L2 → L4: remove the hardcoded `SUBPROCESS` at `plugin_tools.py:359, 673`, default `enforce` to True, assert Docker availability at startup, then add `--memory`, `--pids-limit`, `--cpus` and a seccomp profile. The `--network none --read-only --tmpfs --user 65534` arguments at `plugin_isolation.py:514-532` are already written and never executed. | Third-party plugins confined to a container | 8 days |
| D4 | Plugin supply chain: signature and provenance verification for `/api/plugins/install` and `/api/skills/install` | No unsigned code runs | 5 days |
| D5 | Wire `SandboxPluginLoader.load_all()` into the startup path and enable the Plugin Center UI against the existing endpoints | Plugins actually enter the agent call chain | 5 days |
| D6 | Digital-employee entities: persona plus toolset plus permissions plus schedule plus KPI, closing the loop from output through approval to execution and measured result | The product's differentiating claim becomes real | 15 days |
| D7 | Connect the three unreachable payment routes to the UI | Billing works end to end | 5 days |
| D8 | Multi-tenant load test including RLS zero-crossover verification | Confidence at scale | 5 days |

---

## Explicitly Out of Scope

Per the mission constraint against adding capability, the following are excluded, with reasons.

| Excluded | Reason |
|---|---|
| Deleting `skills_library/` immediately | Merged into Phase C9; the live `catalog()` reads from it, so removal must be sequenced after the merge decision |
| New Agent types or personas | `personas.ts` already defines four |
| New tool frameworks | Four authorities already exist; the task is convergence to one |
| MCP client implementation | Build only after D3 gives it a sandbox worth speaking to |
| Social publishing implementation | The adapter base class correctly raises `AdapterNotImplemented`; implementing it before the sandbox is production-ready would ship an uncontained outbound publisher |
| Web search | No TS implementation exists; adding one before Phase B would add a latency source to an already-slow path |
| Rewriting the Python runtime | The 765 passing tests and the quality of `plugin_isolation.py`, `approvals.py` and `outbound-url.ts` argue for convergence, not replacement |

## Why Not the AI Operating System Positioning

The mission statement targets "enterprise SaaS AI operating system." The evidence does not support that framing at this stage, and the difference changes roughly 10 person-days of scope.

An operating system requires a deployable kernel plus a third-party extension surface. RoveFrame has kernel **shape** — capability registry, tool gate, plugin isolation, tenant model — but the kernel is not deployable and the TypeScript extension surface is empty: no plugin execution, no MCP client, no capability resolver on the TS side.

What RoveFrame uniquely has is the approval bus: frozen argument hashes, compare-and-swap claims, lease recovery, idempotency keys, and durable audit. ChatGPT, Claude, Manus, and Devin do not all have this. The defensible positioning is therefore an auditable digital-employee platform, which is also the only honest reading of the product's own design principle that it never claims work it did not do.

That framing permits deleting 40,000 lines of unreachable parallel server. The AI-OS framing would require maintaining them.
