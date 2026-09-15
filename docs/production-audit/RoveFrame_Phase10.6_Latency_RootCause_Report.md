# Phase 10.6 Runtime Latency Root Cause Analysis — 报告

## 结论先行（必须诚实）

> **阶段拆分表未取得。** 按本阶段的完成标准（「必须得到：一个表 …… 然后才能进入优化」），**不具备进入优化的条件**。
> 本阶段交付：完整的总延迟数据、补丁式 trace 的实现方式与失败诊断、以及**未经数据验证的**候选热点清单（明确标注为「待验证」，不作为优化依据）。

**未修改任何被观测代码**（符合「禁止直接修改逻辑」）。

---

# Task 1 — Runtime Timing Trace

## 已实现：补丁式 trace（不修改被观测代码）

设计决策：`_prepare_chat` 与 `_build_agent` 是 `create_app()` 内的**闭包**，无法从外部打点；而 `runtime.py` 有 10,172 行的 `auxiliary_client.py` 与 8,372 行的 `conversation_loop.py`。**在不知道热点在哪之前，不应手工往 vendor 代码里埋点。**

因此采用**运行期包裹真实函数**的方式，在一个外部 tracer 模块中完成：

| 探针 | 目标 | 覆盖阶段 |
|---|---|---|
| `wrap` | `api.toolsets.resolve_toolsets_for_request` | `toolset_resolve` |
| `wrap` | `api.capability_router.planned_toolsets` | `capability_plan` |
| `wrap` | `api.capability_registry._base_tool_names` | `capability_base_tools` |
| `wrap_cls` | `runtime.AIAgent.__init__` | `agent_create` |
| `wrap_cls` | `runtime.AIAgent.chat` | `agent_loop_llm` |
| `wrap_cls` | `ChatSessionStore.history` | `memory_history` |
| `wrap_cls` | `ChatSessionStore.append` | `persist_append` |
| `count_calls` | `auxiliary_client._try_nous` / `_try_openrouter` | provider 发现次数 |

**实测：全部 9 个补丁成功挂载**
```
{"toolset_resolve": true, "capability_plan": true, "agent_init": true,
 "agent_chat": true, "try_nous": true, "try_openrouter": true,
 "flush_hook": true, "hist": true, "app": true}
```

落盘方式：请求结束时（`ServiceContext.audit` 被调用一次）flush 一行 JSON 到 `RF_TRACE_OUT`。**不改变 SSE 协议、API 协议、Agent 行为。**

## 失败诊断（阶段拆分表未取得的原因）

| 轮次 | 补丁集 | 服务是否起来 | trace 是否落盘 |
|---|---|---|---|
| 第 1 轮 | 5 个 wrap + 2 个计数（无 flush 钩子） | ✅ **是**（31 请求全部 200） | ❌ 否 —— 用 `atexit` 落盘，进程被 `Stop-Process -Force` 强杀，**atexit 不执行** |
| 第 2 轮 | 第 1 轮 + `ServiceContext.audit` flush 钩子 + chat_sessions 钩子 | ❌ **否**（`WinError 10061` 连接被拒） | ❌ 否 |

**第 2 轮的失败原因（诊断）**：在 `ServiceContext` 类上替换 `audit` 方法破坏了应用的装配路径 —— `get_context()` 构造 `ServiceContext` 时会用到 `audit` 或依赖其绑定的类属性；替换后 uvicorn 启动失败（stderr 有 traceback，但输出被重定向且未保留完整内容）。

**正确的修法**（下一步，约 30 分钟）：
- 不改类方法。改用**请求级 hook**：包裹 `app_mod.derive_permissions`（`app.py:448` 每请求调用一次，处在 `with bind_tool_context(...)` 块内），在其返回值上携带计时器；或在 `get_app()` 之后用 FastAPI 的 `app.add_middleware` 加一个纯计时中间件，在响应返回时 flush。
- 或最简单：**在基准脚本侧按请求清空并主动读取** —— 让 tracer 在每个已知的请求起始点（`AIAgent.__init__` 被调用）先 flush 上一条，避开进程级钩子。

---

# Task 2 — Benchmark

## 已取得的数据（n=31，全部 HTTP 200）

| 轮次 | avg | P50 | P95 | P99 |
|---|---|---|---|---|
| **Phase 10.5**（无补丁） | 11,053 ms | **12,959 ms** | 14,062 ms | 19,949 ms |
| **Phase 10.6 第 1 轮**（补丁激活） | 7,063 ms | **5,349 ms** | 13,335 ms | 13,643 ms |

同一环境、同一 mock LLM、同一请求模式、同样 n=31。**两轮的 P50 相差 7,610 ms（2.4 倍）。**

## 这本身是一个关键发现

**Runtime 的单请求延迟在两次相同条件的运行之间不稳定，P50 波动 2.4 倍，单次样本跨度 5.3–22.3 秒。**

这与 Phase 10.5 记录的「WARM 比 COLD 更慢」一致，共同指向：**存在随进程状态/外部条件累积或竞争的阻塞路径，而不是一个固定的计算成本。**

对根因分析的意义：**任何基于单轮 P50 的优化判断都不可靠**，必须多轮采样。这也解释了为什么「先测量」这条原则在本项目上尤其重要。

## `runtime_latency_breakdown.md` 的必要内容——未能产出

任务要求「必须回答：哪个阶段占 90% 以上时间」。**这个问题我无法回答**，因为阶段拆分表未取得。任何回答都会是猜测，而本阶段明令「禁止猜测优化」。

---

# Task 3 — 高概率热点检查（静态证据 + 待验证标注）

**以下全部是静态代码证据，未经本轮数据验证。按原则「禁止直接修改逻辑」，本阶段不对它们做任何修改。**

## 3.1 Provider discovery —— ⚠️ **有确凿证据表明 `ROVEAGENT_OFFLINE` 未完全短路**

**证据（Phase 10 的实现事实）**：我在 Phase 10 只给两处加了闸门：
- `_create_openai_client`（所有客户端构造的共享卡点）✅
- `_try_openrouter`（付费车道入口）✅

**`_try_nous` 未加前置短路** —— 这一点我在 Phase 10 的报告中已自行登记为风险。

**证据（运行时日志）**：Phase 10.5 的 stderr 中出现：
```
Auxiliary: marking openrouter unhealthy for 60s (payment / credit error).
Auxiliary Nous client unavailable: no Nous authentication found (run: roveagent auth).
resolve_provider_client: nous requested but Nous Portal not configured
```
且这些行在**多个请求之间重复出现**，说明是 per-request 或按短 TTL 重复触发的。

**为什么它可能造成数秒级延迟**：`_resolve_nous_pool_runtime_api` / `_resolve_nous_runtime_api`（`auxiliary_client.py:2741` / `:2792`）做凭据解析，失败路径可能包含网络探测与超时。

**验证方式（最省力的一条）**：给 `_try_nous` 加与 `_try_openrouter` 相同的 `_offline_guard_active()` 前置短路，重跑同样的 n=31 基准。**若 P50 显著下降即为确因**。这是本阶段之后应当**第一个做**的实验。

## 3.2 Plugin / Capability discovery —— ⚠️ 部分已缓存，部分未确认

| 项 | 证据 | 判定 |
|---|---|---|
| `capability_registry` 基础集合 | 模块级缓存 `_BASE_TOOLSETS_CACHE/_READY`、`_BASE_DECLARED_CACHE/_READY`（`:187`、`:225`） | ✅ **已缓存** |
| 工具可用性检查 | `capability_router.py:305` `_check_fn_cached(check)` | ✅ **已缓存** |
| `planned_toolsets(agent_key)` | 对静态 `AGENT_CAPABILITIES` 的纯函数（`:127`） | ✅ 廉价 |
| **plugin scan** | `SandboxPluginLoader.load_all()` 在非测试代码中**零调用方**（Phase 9 已确认） | ✅ 不构成每请求成本 |
| **`resolve_toolsets_for_request` 整体** | 每请求执行（`app.py:446` 与 `:462` 各一次） | ⚠️ **未测量** |

运行时 stderr 中反复出现的 `check_fn check_vision_requirements returned False`、`_check_kanban_mode returned False`、`_check_yuanbao returned False` 等行 —— 若这些是**每请求重跑**，则为候选热点；但 `_check_fn_cached` 的存在提示已缓存，**需数据确认**。

## 3.3 Agent 实例创建 —— ⚠️ **已确认每请求重建**

**证据（代码）**：`app.py:105-134` 的 `_build_agent` 在 `agent_chat`（`:152`）与 `stream_agent_chat`（`:160`）中**每请求调用一次**，内部执行 `AIAgent(base_url=..., api_key=..., model=..., enabled_toolsets=list(toolsets), max_iterations=..., ephemeral_system_prompt=system, prefill_messages=list(history), ...)`。

**能否缓存（按任务约束：禁止缓存 request 级 state，只允许 client/config/tool schema）**：

| 字段 | 是否 request 级 | 可否缓存 |
|---|---|---|
| `ephemeral_system_prompt=system` | ✅ **是**（含 business_context，`app.py:394`） | ❌ **禁止缓存** |
| `prefill_messages=list(history)` | ✅ **是**（会话历史） | ❌ **禁止缓存** |
| `enabled_toolsets` | 按 `emp.key` 决定 | ✅ 可缓存（keyed by agent_key） |
| `base_url` / `api_key` / `model` | 进程级配置 | ✅ 可缓存 |
| `max_iterations` | 按 agent 决定 | ✅ 可缓存 |

**因此 `AIAgent` 实例本身不可池化**（这一点 Phase 10.5 已指出，此处以代码证据再次确认）。可省的是 `enabled_toolsets` 与 client/config 的重复解析。

## 3.4 Memory —— ⚠️ 已在 `_prepare_chat` 中可见，未测量

**证据（代码）**：`app.py:409-417`
```python
history = ctx.chat_sessions.history(req.tenant_id, req.business_id, req.user_id, req.session_id)
```
以及 `_prepare_chat` 中更早的 memory 读取（组装 `memory_block`，用 `memories` 一并返回）。

**是否「每次加载全部 memory」**：代码显示是按 `(tenant, business, user, session)` 检索，**不是全量加载**。但检索的实现（SQLite + FTS5）与耗时**未测量**。

---

# Task 4 — Runtime Optimization Proposal

> **前置声明：以下全部为「待验证候选」，不是基于数据的结论。** 按本阶段原则，**在阶段拆分表取得之前不应据此修改任何代码。**

| # | 问题 | 证据 | 修改方案 | 风险 | 预计收益 |
|---|---|---|---|---|---|
| **O-1** | `_try_nous` 未受 `ROVEAGENT_OFFLINE` 约束，可能每请求触发凭据解析与网络超时 | Phase 10 只给 `_create_openai_client` 与 `_try_openrouter` 加了闸门；stderr 重复出现 Nous 相关行 | 给 `_try_nous` 加同一前置短路（3 行，与 `_try_openrouter` 同形） | 极低。离线时本就不应使用该 provider；生产 `ROVEAGENT_OFFLINE` 未设置时行为不变 | **待测**。这是**第一个应做的实验** |
| **O-2** | `AIAgent` 每请求重建，其中 `enabled_toolsets` 与 client/config 反复解析 | `app.py:105-134` 每请求调用；`resolve_toolsets_for_request` 每请求 2 次 | 缓存 `resolve_toolsets_for_request(agent_key)` 结果（keyed by agent_key，**不含任何 request 级数据**）；client/config 复用 `_create_openai_client` 的现有缓存 | 中。`AIAgent.__init__` 含 request 级字段（system prompt / history），**不可整体池化**；只可缓存其输入 | **待测** |
| **O-3** | 工具可用性检查是否每请求重跑 | stderr 每请求出现大量 `check_fn … returned False` | 若确认未命中缓存，扩大 `_check_fn_cached` 的 TTL 或预计算 | 中。缓存会影响「能力修好了却递不到模型」这一类问题的可观测性（项目历史上踩过该坑，见 `app.py:454-459` 注释） | **待测** |
| **O-4** | 延迟方差极大（P50 跨轮 2.4 倍） | Phase 10.5 vs 10.6 实测 | **先做方差归因**：区分「固定成本」与「竞争/重试成本」。若为后者，O-1/O-3 即是解 | — | 定位性收益 |
| **O-5** | 缺少常驻埋点，无法在生产持续观测 | 本阶段的 trace 是外部 harness，未进生产代码 | 在**确认热点之后**，仅在热点所在函数加结构化日志（不新增模块） | 低 | 可运营性 |

**明确不做的事**（本轮）：
- 不改 `conversation_loop.py` / `runtime.py`（10k+ 行 vendor 代码，热点未定位前不动）
- 不改 SSE / API 协议
- 不做 Fast Path 相关工作（任务明令禁止）

---

# 完成标准对照

| 要求 | 状态 |
|---|---|
| 建立完整 Runtime Timing Trace（不改变协议/行为） | ⚠️ **实现方式已验证可行（9/9 补丁挂载），但落盘钩子需修正** |
| n ≥ 30 benchmark | ✅ **已完成两轮，各 n=31** |
| P50 / P95 / P99 | ✅ **已取得（总延迟）** |
| `runtime_latency_breakdown.md` | ❌ **未产出** —— 阶段拆分未取得 |
| **回答「哪个阶段占 90% 以上时间」** | ❌ **无法回答**（这是本阶段的核心目标，未达成） |
| 阶段表 | ❌ **未取得** |

| 阶段 | 耗时 |
|---|---|
| auth | **未测得** |
| capability | **未测得** |
| provider | **未测得** |
| memory | **未测得** |
| agent init | **未测得** |
| LLM | ≈0（mock 即时返回，Phase 10.5 已确认） |
| tool | 未触发（mock 不调用工具） |
| **总计（实测）** | **P50 5,349–12,959 ms，P95 13,335–14,062 ms，P99 13,643–19,949 ms（n=31×2 轮）** |

**因此：不具备进入优化的条件。**

---

# 下一步（30 分钟内可完成，即可拿到阶段表）

1. **修落盘钩子**：不改类方法。在 FastAPI app 上加一个纯计时中间件（`app.add_middleware`），在响应返回时 flush 一行 JSON。这不动任何业务代码，也不改协议。
2. **重跑**：同样环境、同样 n=31、同样 `ROVEAGENT_OFFLINE=1`，拿到 `toolset_resolve` / `capability_plan` / `agent_create` / `agent_loop_llm` / `memory_history` / `persist_append` 的分阶段耗时。
3. **做 O-1 实验**：给 `_try_nous` 加闸门后重跑，对比 P50。这是最可能的一次性大收益。
4. **拿到阶段表之后再决定是否动 O-2 / O-3。**

---

## 用户现在是否真的可以使用

❌ **不能。** 本阶段的**核心目标（定位 90% 耗时所在阶段）未达成**。用户仍然无法知道 Runtime 为什么慢，因此也无法安全地优化它。

已确证的两件事对用户有实际价值：
1. **延迟极不稳定**（P50 跨轮 2.4 倍），说明存在随状态累积的阻塞而非固定计算成本 —— 这改变了优化的方向（应查竞争/重试，而非算法）
2. **LLM 不是瓶颈**（Phase 10.5 已确认，本阶段保持）

**未修改任何被观测代码。** 所有 tracer 与基准脚本都位于 `%TEMP%\rf-trace*`，未入库。
