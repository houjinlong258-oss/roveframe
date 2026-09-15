# RoveFrame Performance Optimization Plan

Scope: latency analysis of the deployable request path plus concrete optimization designs. Read-only; no code was modified.

Primary finding: **SaaS slowness is not model latency.** Three architectural decisions dominate, and all three are in the Next.js layer, not the provider layer.

1. The primary answer path is not streamed. The model writes the entire answer inside a non-streaming call, and the reader receives it as one frame.
2. Every message pays a mandatory extra LLM round trip before any output exists.
3. After the answer has already been delivered, the server blocks on a second LLM call before emitting `done`.

---

## 1. Request Timeline

Path: `POST /api/agent/chat`, runtime unavailable or TS fallback, question requiring no tools.

| # | Stage | Time (estimate) | Cumulative | Evidence |
|---|---|---|---|---|
| 1 | Request received | 0 | 0 | — |
| 2 | `proxy.ts` auth (warm token cache) | ~1 ms | ~1 ms | `auth-guard.ts:229-244` |
| 3 | `requireBusinessContext(getTenantContext())` | 0 warm / 40–120 ms cold | ≤120 ms | `chat/route.ts:373` |
| 4 | Acquire chat slot | <1 ms | ≤120 ms | `chat/route.ts:374`, `rate-limit.ts:118` |
| 5 | Create or read `chat_sessions` | 40–120 ms | ≤240 ms | `chat/route.ts:394` / `:410` |
| 6 | `chat_messages` count | 40–120 ms | ≤360 ms | `chat/route.ts:433` |
| 7 | Conditional summarise read | 0–120 ms | ≤480 ms | `chat/route.ts:444` |
| 8 | Conditional summarise write | 0–120 ms | ≤600 ms | `chat/route.ts:454` |
| 9 | Last 20 turns, **untruncated** | 40–120 ms | ≤720 ms | `chat/route.ts:462-468` |
| 10 | Insert user message | 40–120 ms | ≤840 ms | `chat/route.ts:471` |
| 11 | `getBusinessContext` — 14 queries in one `Promise.all` | 40–200 ms | ≤1040 ms | `chat/route.ts:480` → `business-context.ts:54-92` |
| 12 | `getSettings` | 0 warm | ≤1040 ms | `settings.ts` cache |
| 13 | `getRecentMemories(5)` | 40–120 ms | ≤1160 ms | `chat/route.ts:483` |
| 14 | Attachment extraction (per attachment, sequential) | 0–2× RTT each | ≤1400 ms | `chat/route.ts:484`, `:190-247` |
| — | **7 serialised Supabase round trips minimum** | **280–840 ms** | — | stages 4,5/6,9,10,11,13 |
| 15 | **Planning LLM call — non-streaming, model writes the full answer** | **1500–8000 ms** | **≤9400 ms** | `gateway.ts:68` → `router.ts:631-682` (`stream: false` at `:643`) |
| 16 | Agent loop terminates with `finish('completed', decision.text)` | 0 | ≤9400 ms | `agent-loop.ts:40` |
| 17 | `yield* textStream(run.text)` — **whole answer as one chunk** | 0 | ≤9400 ms | `gateway.ts:163-165`, `:128-130` |
| 18 | Single `delta` SSE event | 0 | ≤9400 ms | `chat/route.ts:762` |
| 19 | Artifact materialisation (conditional) | 0–2000 ms | ≤11400 ms | `chat/route.ts:729-748` |
| 20 | Approval-card query (conditional) | 40–120 ms | ≤11520 ms | `chat/route.ts:814-822` |
| 21 | Persist assistant message | 40–120 ms | ≤11640 ms | `chat/route.ts:832` |
| 22 | Session metadata update | 40–120 ms | ≤11760 ms | `chat/route.ts:858` |
| 23 | **Memory-extraction LLM call, awaited** | **800–3000 ms** | **≤14760 ms** | `chat/route.ts:875` |
| 24 | `emit({ type: 'done' })` | 0 | **≤14760 ms** | `chat/route.ts:897` |

Two conclusions follow directly.

**First content visible at 2–9 seconds, not because generation is slow, but because nothing is emitted until generation finishes.** The user sees a spinner for the entire model call and then the complete answer at once. The product claims SSE streaming; token streaming only occurs on the synthesis path (`router.ts:849` and `:922` both set `stream: true`), which is reached only when the agent loop completed tool calls and produced no text.

**The `done` event is delayed by an unrelated third LLM call.** The answer is already on screen at stage 18, but the stream does not close until stage 24. Any client that treats `done` as "finished" — including the spinner and the status strip — stays in a generating state for an extra 0.8–3 seconds.

### Worst case, tools plus budget exhaustion

`maxIterations: 4` (`gateway.ts:144`), `MAX_TOOL_CALLS_PER_TURN: 4` (`gateway.ts:14`). Each iteration calls `plan()`, and `plan()` calls `invokeToolDecision`, which is one LLM request.

| LLM call | Trigger |
|---|---|
| 1–4 | One planning call per iteration |
| 5 | Streaming synthesis, when `run.text` is empty (`gateway.ts:177`) |
| 6 | Memory extraction (`chat/route.ts:875`) |

**Six LLM calls in one chat turn.** With `DEFAULT_MAX_RETRIES = 2` and a per-attempt timeout of 300 s, a single stage can consume up to 900 s.

---

## 2. Top 20 Latency Sources

| # | Source | Cost | Where | Fixable | Priority |
|---|---|---|---|---|---|
| 1 | Non-streaming planning call generates the whole answer | 1.5–8 s | `router.ts:643`; consumed at `gateway.ts:163-165` | Yes — architecture | **P0** |
| 2 | Mandatory planning call before any output, even for "hello" | 1.5–8 s | `gateway.ts:68` | Yes — gate on `classifyRequest` | **P0** |
| 3 | Memory-extraction LLM call blocks `done` | 0.8–3 s | `chat/route.ts:875` before `:897` | Yes — 0.5 day | **P0** |
| 4 | 20 history messages with **untruncated** content, sent to every LLM call | 500–15,000 tokens per call, twice | `chat/route.ts:462-468, 503`; system prompt at `:139` demands long answers | Yes | **P1** |
| 5 | 7 serialised Supabase RTTs before the first LLM request | 280–840 ms | `chat/route.ts:373,410,433,462,471,480,483` | Yes — parallelise 5,6,9 | **P1** |
| 6 | `buildModelRegistry` uncached, runs 2–4× per turn | 2–4 × RTT + compute | `model-registry.ts`; `chat/route.ts:789`; `failover.ts:158` | Yes | **P1** |
| 7 | `gateway.ts:177` does not pass `chain`, so resolution repeats inside failover | 1–3 RTT | `gateway.ts:177`; `failover.ts:295` already supports it | Yes — one line | **P1** |
| 8 | Full tool schemas for all 14 tools sent on every planning call | 1,000–4,000 tokens | `registry.ts:114-128` | Yes — schema slimming | **P1** |
| 9 | Attachments inlined up to 4 × 12,000 chars into the system prompt | up to 48,000 chars | `chat/route.ts:52-53, 197-247` | Yes | **P1** |
| 10 | `dotenv.config({ override: true })` on every Supabase client access | synchronous file read + parse per DB call | `supabase-client.ts:42-46`; `envLoaded` is never set on the early-return path | Yes — 3 lines | **P0** |
| 11 | Platform fallback model has no timeout, no retry, no signal | unbounded | `router.ts:505-511` | Yes | **P1** |
| 12 | Anthropic planning path capped at `max_tokens: 2048` while the prompt demands long answers | truncated output | `router.ts:708` vs `:918` | Yes | **P2** |
| 13 | No streaming cancellation; a closed tab keeps generating | up to 300 s × attempts, holding a slot | `chat/route.ts:292-323`; `router.ts:865,936`; `gateway.ts:177` | Yes | **P1** |
| 14 | `/api/health` performs 12 sequential `head: true` probes | 12 × RTT per probe call | `boot-check.ts:28-33`; `health/route.ts:12` | Yes | **P2** |
| 15 | Scheduler tick is O(tenants × businesses) sequential, 5 job families each | grows linearly with tenant count | `scheduler.ts:326-359` | Yes | **P2** |
| 16 | Outbox and email queue send strictly sequentially, up to 100 rows per tick | 100 × SMTP latency per tick | `notifications/outbox.ts:202-267`; `email/outgoing.ts:205-258` | Yes | **P2** |
| 17 | `enterprise/tool-runtime.ts:280` `setTimeout` never cleared | holds the event loop 30 s per tool call | `tool-runtime.ts:280`, timeout defined at `:209` | Yes | **P2** |
| 18 | Python `_build_agent` constructs a fresh `AIAgent` per request | non-trivial construction per request | `app.py:105-134`, called at `:152` and `:160` | Partially — see section 3 | **P2** |
| 19 | Capability availability checks iterate tools per request | amortised by `_check_fn_cached`; registry caches are module-level | `capability_router.py:294-305`; `capability_registry.py:187,225` | Mostly already handled | **P3** |
| 20 | No request-id propagation across the two planes | diagnostic cost only | `X-Request-Id` set only on admin routes | Yes | **P3** |

---

## 3. Agent Initialisation — What May Be Cached

The mission states: never cache user state, never cache permissions. Those constraints are respected in the design below.

| Object | Rebuilt per request? | Evidence | Decision |
|---|---|---|---|
| Service context / kernel | **No** — module singleton | `app.py:195-202` `_ctx: Optional[ServiceContext] = None` | **Already correct.** Keep. |
| Capability base toolset and declared sets | **No** — module caches | `capability_registry.py:187` `_BASE_TOOLSETS_CACHE/_READY`, `:225` `_BASE_DECLARED_CACHE/_READY`, `:309 reset_base_tool_cache()` | **Already correct.** Keep. |
| Capability availability per tool | **No** — cached check | `capability_router.py:305` `_check_fn_cached(check)` | **Already correct.** Keep. |
| `planned_toolsets(agent_key)` | Yes, but it is a pure function over a static dict | `capability_router.py:127` | **Cacheable** — keyed by `agent_key`, no user data |
| Model registry snapshot | **Yes, uncached, 2–4× per turn** | `model-registry.ts`; `chat/route.ts:789`; `failover.ts:158` | **Cacheable per request** (request-scoped memo, not cross-request) |
| Provider client / base URL / protocol profile | Yes | `router.ts:582-589` resolution per call | **Cacheable** keyed by `(tenant, provider, model)` — configuration, not user state |
| Tool schemas | Yes, every planning call | `registry.ts:114-128` | **Cacheable** keyed by `role` — derived from static definitions plus role permission filter |
| `AIAgent` instance | **Yes, per request** | `app.py:105-134` | **NOT cacheable as-is.** See constraint below. |
| Toolset resolution result | Yes | `app.py:446-447` | **Cacheable** keyed by `(agent_key, capabilities_version)` |
| Role, permissions, tenant, business | Yes, per request | `auth-guard.ts`, `tenant.ts` | **Must not be cached across requests.** Only the existing 60 s token cache and 5 min role cache are acceptable, and the role cache must be invalidated on role change. |
| Chat session, history, memories | Yes, per request | `chat/route.ts` | **Must not be cached.** |
| Chat slot | Per request | `rate-limit.ts:44` | Correct, but see the release bug in the debt register |

**Critical implementation constraint.** `AIAgent` is constructed with `ephemeral_system_prompt=system` (`app.py:129`) and `prefill_messages=list(history)` (`:130`). Both are request-scoped. A cached `AIAgent` would leak one tenant's system prompt and history into another tenant's request. Therefore:

- Do **not** pool `AIAgent` instances.
- What may be pooled is the bounded, tenant-independent part: provider client construction and the resolved toolset list.
- Concurrency must still be bounded with a semaphore around `_build_agent` + `chat`, because construction is not the cost — the token-generation window is.

Additional risk to flag: `business_context` arrives from TS with `max_length=20_000` (`app.py:258`). It is request-scoped and must never be cached or shared.

---

## 4. Tool Schema — Dynamic Tool Selection

Current behaviour: every planning call sends every tool the role may see, with the full `inputSchema` JSON.

- `registry.ts:114-128` `modelTools(role)` filters by permission, then maps name, description, and `inputSchema`.
- `router.ts:645-652` serialises each into an OpenAI `tools[]` entry with `parameters: tool.inputSchema`.
- Python mirrors this via `enabled_toolsets`, resolved per request at `app.py:446-447`.

Effect: the model is asked to choose among 14 tools on every turn, and the schemas are re-sent on every iteration, including the streaming synthesis call.

Optimisation, ordered by cost/benefit:

| Step | Action | Token saving | Effort |
|---|---|---|---|
| 1 | Cap tool descriptions at 80 characters; move long guidance to the tool's own error messages | 300–1,500 tokens per call | 0.5 day |
| 2 | Remove `additionalProperties: false` and empty `properties` blocks from schemas where the provider does not require them | 100–400 tokens | 0.25 day |
| 3 | Send tools only on the planning call. Do not send `tools[]` on the synthesis call. | Removes the full tool block from one call | 0.5 day |
| 4 | Intent-based pre-filter: when `classifyRequest` yields a specific intent, include only tools whose category matches, plus a short always-available read set | 50–80 percent of tool tokens on intent-matched turns | 1.5 days |
| 5 | Two-tier exposure: a compact "capability menu" of tool names and one-line purposes on the first call; full schemas only for the tools the model names | Largest single win; requires a second round trip, worth it only above ~30 tools | 3 days |

Do not build step 5 until the tool count exceeds roughly 30. With 14 tools, steps 1–4 are sufficient.

---

## 5. LLM Configuration — TTFT Optimisation

Current state:

| Aspect | Setting | Location | Assessment |
|---|---|---|---|
| Provider selection | User preference → business default → health-ranked others → platform | `failover.ts` candidate chain | Good, and explainable |
| Streaming | `stream: false` on the planning call; `stream: true` only on synthesis and on `streamChat` | `router.ts:643`, `:849`, `:922` | **The core defect** |
| Timeout | 60 s default, 300 s for streams, per attempt | `router.ts:117-120` | Worst case 3 × 300 s |
| Retry | 2 attempts, backoff `250 · 2^(n-1)` | `router.ts` via `fetchWithResilience` | **No jitter anywhere** |
| Failover | Yes, and it refuses to switch after the first token has been emitted | `failover.ts` header rules | Correct |
| Circuit breaker | **Absent** — zero matches for `circuit`, `breaker`, `halfOpen` | — | Missing |
| Platform fallback | `new LLMClient(new Config(), forwardHeaders)` — no timeout, no retry, caller signal not forwarded | `router.ts:505-511` | Unbounded hang risk |

TTFT plan, target first token under 2 seconds:

1. **Make the primary path streaming.** Replace the non-streaming `invokeToolDecision` on the `chat` branch with `streamChat` (`router.ts:517`), which already exists and already streams. This alone converts perceived latency from "full generation time" to "time to first token."
2. **Gate the planning call behind `classifyRequest`.** When the classification is `chat`, do not call the planner at all. Tool use, if genuinely needed, is discovered from `tool_calls` in the streamed response.
3. Add jitter to backoff: `delay = base · 2^(n-1) · (0.5 + random())`.
4. Add a circuit breaker keyed on failure streaks already recorded in `ai_usage_ledger` (`router.ts:463-477`). Open after N consecutive failures for a provider, half-open after a cooldown.
5. Forward the caller `AbortSignal` into `streamChatWithFailover` and the platform `LLMClient` path. `gateway.ts:146` forwards it to `runAgentLoop`, but `:177` does not forward it to the synthesis call.
6. Unify `max_tokens`: `router.ts:708` uses a fixed 2048 while `:918` uses `REASONING_LEVELS[...]`. The same question yields different answer lengths depending on which path runs.

---

## 6. Agent Loop — Iterations, Reflection, Prompt Growth

| Item | Current | Location |
|---|---|---|
| Iterations | 4 | `gateway.ts:144` `maxIterations: 4` |
| Tool calls per turn | 4 | `gateway.ts:14` `MAX_TOOL_CALLS_PER_TURN = 4` |
| Reflection | none | No reflection pass in either plane |
| Replanning | Yes, one extra planning call per iteration when strategy is `native` | `agent-loop.ts:57`; `gateway.ts:149` `replan: plan.strategy === 'native'` |
| Repetition guard | Yes | `agent-loop.ts:39,45,56`; `packages/roveagent-core/src/context/repetition-guard.ts` |
| Duplicate call suppression | Yes, canonical tool-call keys | `packages/roveagent-core/src/tools/call-key.ts` |
| Prompt growth | Observation messages accumulate and are re-sent on every iteration | `gateway.ts:107-119`, bounded by `MAX_TOOL_RESULT_CHARS = 12_000` |

The loop itself is well built: bounded, deterministic, with repetition and duplicate suppression, and with an explicit `stop` signal that halts remaining calls when approval is pending (`agent-loop.ts:54`). The problem is not the loop. The problem is that the loop runs at all for a question that needs no tools.

### Fast Path

```
classifyRequest(message)            // pure regex, already exists, already computed at chat/route.ts:544
  |
  +-- 'chat'  ------------------------------------------> streamChat()   [1 LLM call, streamed]
  |                                                       tool use discovered from streamed tool_calls
  |
  +-- 'tool_execution' --------------------------------> invokeToolDecision()  [planning]
                                                         -> runAgentLoop()
                                                         -> streamChatWithFailover()  [synthesis]
```

This requires **no new module**. `request-class.ts` exists, returns `requestClass`, and `chat/route.ts:544` already computes `classification` — it is a value that is produced and then not used for branching.

Projected effect for a simple question: LLM calls drop from 2 to 1, and first visible output moves from "after full generation" to "first token."

---

## 7. Three Operating Modes

| Aspect | Simple | Standard | Autonomous |
|---|---|---|---|
| Trigger | `classifyRequest` returns `chat`, message under ~200 chars, no attachments | Default | Explicit user opt-in, or a durable task |
| Path | `streamChat` directly | Planner, bounded loop, streaming synthesis | `agent_tasks` durable run, Python runtime required |
| LLM calls | 1 | 2–3 | up to 6 |
| Iterations | 0 | 4 | task-defined |
| Tools exposed | None | Intent-filtered subset | Full permission-scoped set |
| Approval | n/a | Required for write tools | Required for write tools |
| Memory write | Deferred, non-blocking | Deferred, non-blocking | Synchronous with the run record |
| Runtime required | No | No | **Yes** — hard fail if unavailable |
| Target TTFT | < 1.2 s | < 2 s | n/a (task semantics) |

Mapping to existing code, so that nothing new is built:

- Simple = `streamChat` (`router.ts:517`)
- Standard = `runAgentTurn` (`gateway.ts:140`) with the planner call gated on classification
- Autonomous = `agent_tasks` + `agent_task_runs` (`tasks/worker.ts`) → Python `/api/agent/chat/stream`

Mode selection is a routing decision inside `chat/route.ts`, using `classification` plus message length plus attachment count. It is a branch, not a subsystem.

---

## 8. Concurrency

Current state and the reuse-based target are recorded in the technical debt register. The two facts that constrain any design:

1. The chat concurrency gate is a process-local counter with no TTL, and the release path is broken for two branches. Fixing the release is a prerequisite for any pooling work, because pooling multiplies the leak.
2. `agent_task_runs` already provides atomic claim, lease, and idempotency. A shared queue does not need to be invented; a `claim_chat_slot` RPC following the existing `claim_daily_briefing_slot` pattern (`scheduler.ts:143-159`, SQL at `migrate.sql:636-650`) is sufficient.

---

## 9. Measurement Requirements

None of the estimates above can be replaced by measurement today, because there is no instrumentation. Before optimising further, add:

| Metric | Instrumentation point | Why |
|---|---|---|
| `ttft_ms` | first `delta` emitted in `chat/route.ts` | The headline number |
| `pre_llm_db_ms` | between request entry and the first LLM request | Separates DB cost from model cost |
| `planning_llm_ms` | around `invokeToolDecision` | Confirms or refutes finding #1 |
| `synthesis_llm_ms` | around `streamChatWithFailover` | Path comparison |
| `llm_calls_per_turn` | counter incremented at each provider request | Targets the 2-to-6 range |
| `prompt_chars` / `prompt_tokens` | request assembly in `chat/route.ts` | Validates the context-bloat finding |
| `post_answer_ms` | between last `delta` and `done` | Isolates the memory-call delay |
| `tool_count_exposed` | `modelTools(role).length` | Tool-token accounting |
| `runtime_mode` | already persisted to `chat_sessions.runtime_mode` | Segment all of the above by path |

`ai_usage_ledger` already stores `latencyMs` and `correlationId` per call (`router.ts:463-477`), so per-provider latency exists. What is missing is the phase breakdown within a turn.

---

## 10. Prioritised Actions

| Order | Action | Target | Effort |
|---|---|---|---|
| 1 | Move `slot.release()` to an outer `try/finally` | Removes a tenant-bricking outage; prerequisite for everything else | 1 line |
| 2 | Fix the `envLoaded` guard in `supabase-client.ts` | Removes a synchronous file read from every DB call; turns 15 tests green | 3 lines |
| 3 | Move the memory-extraction call out of the blocking path | −0.8 to −3 s on every turn | 0.5 day |
| 4 | Add phase instrumentation | Makes every later change measurable | 1 day |
| 5 | Fast Path: gate the planner on `classifyRequest` | −1 LLM call; first output no longer waits for full generation | 2–3 days |
| 6 | Stream the Simple path via `streamChat` | TTFT from 2–9 s to under 1.2 s | included in 5 |
| 7 | Truncate history by character budget; reduce attachment limits | −60 percent prompt size | 0.5 day |
| 8 | Memoise `buildModelRegistry` per request; pass `chain` at `gateway.ts:177` | Resolution from 4× to 1× | 1 day |
| 9 | Parallelise stages 5, 6, 9 in `chat/route.ts` | −0.25 to −0.7 s | 2 days |
| 10 | Unify `max_tokens`; add jitter; add circuit breaker; forward signals | Reliability and consistency | 3 days |

Targets after items 1–9:

| Metric | Current | Target |
|---|---|---|
| Simple-question TTFT | 2–9 s | ≤ 1.2 s |
| Simple-question LLM calls | 2 | 1 |
| Tool-turn LLM calls | 3–6 | ≤ 3 |
| Serialised DB round trips before the LLM | ≥ 7 | ≤ 3 |
| Prompt characters per turn | up to 55,000 | ≤ 15,000 |
| Time from last answer token to `done` | 0.8–3 s | < 50 ms |
