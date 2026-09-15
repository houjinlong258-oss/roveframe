# Step 0 — 只读架构扫描报告（未修改任何业务代码）

**日期**：2026-09-12
**性质**：Step 0 交付物。仅只读扫描。**本次未修改任何业务代码。**
**前序**：`docs/architecture-diagnosis-roveagent-takeover.md`（断链根因与 11 阶段可行性）
**本次新增取证**：TS SSE 实现位置、前端事件契约、Python 流式回调的真实存在性

---

## 1. 架构总图（现状，实测）

```
┌────────────────────────────────────────────────────────────────────────┐
│ 浏览器 (React 19)                                                       │
│   src/app/[locale]/agent/page.tsx:354                                  │
│     await start({ url: '/api/agent/chat', … })                          │
│   src/hooks/use-sse.ts:33  useSSE()                                     │
│     POST → 读 resp.body.getReader() → 按 '\n' 拆 → 只认 'data: ' 前缀     │
│     KNOWN_EVENT_TYPES (:17): status|provider|delta|artifact|notice|     │
│                              error|done                                 │
│     ⚠ 'approval' 不在 KNOWN_EVENT_TYPES 中，但 page.tsx:402 处理了它      │
│        → 该分支当前不可达（潜在缺陷，见 §6）                              │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ POST /api/agent/chat  (SSE 响应)
┌───────────────────────────────▼────────────────────────────────────────┐
│ Next.js 16 Route Handler                                                │
│   src/app/api/agent/chat/route.ts  (711 行)                             │
│                                                                         │
│   ① 前置串行 I/O (:380-425)  8 个 await                                  │
│   ② if (roveAgentConfigured())  ← client.ts:28                          │
│        try  → roveAgentChat()      ← 非流式 JSON                        │
│        catch(RoveAgentUnavailable) → console.warn ONLY  ← ★静默降级点    │
│   ③ agentSseResponse(async emit => …)                                   │
│        if (!usedRoveAgent) → runAgentTurn()  ← TS 兜底 Loop             │
│        stream = (async function*(){ yield reply })()  ← ★伪流            │
│        ArtifactStreamFilter → deliverRequestedFiles() → 落库/审批       │
└──────────────┬──────────────────────────────────┬───────────────────────┘
      usedRoveAgent=true                  usedRoveAgent=false
               │                                  │
┌──────────────▼──────────────────┐   ┌───────────▼────────────────────────┐
│ src/lib/roveagent/client.ts     │   │ packages/roveagent-core/src/       │
│   :101 roveAgentChat()          │   │   runtime/agent-loop.ts:26-27      │
│   :197 roveAgentResolveTool()   │   │   maxIterations = 4                │
│   :151 roveAgentCreateTask()    │   │   maxToolCalls  = 4                │
│   :28  roveAgentConfigured()    │   │   工具 12 个，无文件/终端工具        │
│   :36  call() 30s 超时          │   │   ← 与 Python 完全独立的第二套实现   │
└──────────────┬──────────────────┘   └────────────────────────────────────┘
               │ HTTP  X-RoveAgent-Key
               │ HMAC  X-RoveAgent-Timestamp / -Signature（仅签名端点）
┌──────────────▼──────────────────────────────────────────────────────────┐
│ Python RoveAgent Service                                                │
│   scripts/roveagent-service.sh                                          │
│     └─ python -m uvicorn roveagent.api.app:get_app --factory            │
│          :8788   ← 必须 --factory（app.py:657 模块级 app = None）         │
│                                                                         │
│   roveagent/api/app.py                                                  │
│     :228 create_app()      :660 get_app()                               │
│     :233 auth()            X-RoveAgent-Key 常量时间比较                   │
│     :246 signed_auth()     HMAC-SHA256 over timestamp.body，±300s         │
│     :271 GET  /api/health                                               │
│     :277 POST /api/agent/chat   (非流式 dict)  ← ★无流式端点              │
│     :332 ctx.agent_chat(toolsets=("safe","memory","business")) ★硬编码   │
│                                                                         │
│   api/app.py:100 ServiceContext.agent_chat()                            │
│     :103  返回 str            ← ★丢弃全部流式回调                         │
│     :119  AIAgent(base_url, api_key, model, enabled_toolsets,            │
│                    max_iterations, quiet_mode,                           │
│                    ephemeral_system_prompt, prefill_messages)            │
│     :129  return agent.chat(user)                                       │
│                                                                         │
│   roveagent/runtime.py:422 class AIAgent                                │
│     :445 __init__ 暴露 21 个回调，含：                                    │
│        :475 tool_progress_callback   :477 tool_complete_callback        │
│        :488 stream_delta_callback ★  :489 interim_assistant_callback ★   │
│        :490 tool_gen_callback        :491 status_callback               │
│        :494 event_callback(str,dict) :492 notice_callback               │
│     → ★ 引擎已具备逐 token / 逐事件上报能力，只是调用方没传              │
│                                                                         │
│   每次工具调用经 tool_execution 中间件链：                                 │
│     roveagent/enterprise/gate_hook.py:186 install_enterprise_gate()     │
│       :77  enterprise_gate_middleware(**kwargs)                         │
│       :168 .fail_closed = True                                          │
│     → roveagent/tools/framework.py:210 EnterpriseToolGate.authorize()   │
│         Schema → Context → Permission → Risk → Approval → Audit         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.1 已有可复用的流式件

**TS 侧（直接可用）**：

```
src/lib/api-helpers.ts:30           sseResponse(AsyncGenerator<string>) → data: {text}
src/lib/agent/stream-events.ts:116  AgentSseEvent（8 种事件，权威契约）
src/hooks/use-sse.ts:33             useSSE()
```

**Python 侧（存在，但不要 import —— 见下）**：

```
roveagent/gateway/stream_events.py
  :44  MessageChunk        :56  MessageStop      :72  Commentary
  :85  ToolCallChunk       :104 ToolCallFinished :122 LongToolHint
  :135 GatewayNotice
roveagent/gateway/stream_dispatch.py / stream_consumer.py
```

#### ★ 重要：不要从 `api/app.py` import `gateway.stream_events`

已验证的导入代价链：

```
roveagent/gateway/stream_events.py   自身仅 stdlib（dataclasses + typing）
        ↓ 但 import 子模块会先执行包的 __init__.py
roveagent/gateway/__init__.py
  from .config    import GatewayConfig, PlatformConfig, HomeChannel, load_gateway_config
  from .session   import SessionContext, SessionStore, SessionResetPolicy, …
  from .delivery  import DeliveryRouter, DeliveryTarget
        ↓ 而这三者又拉入
  gateway/shutdown_watchdog.py
  core/secret_scope.py            ← 凭据作用域
  core/turn_context.py
  clisupport/config.py            ← CLI 配置栈
  whatsapp_identity.py            ← 平台渠道
```

**结论**：`api/app.py` 是一个刻意保持轻量的服务层
（`:660` 注释「延迟构建，避免无 fastapi 环境下 import 失败」）。
从它 import gateway 会**拖入整个平台消息与 CLI 配置栈**，与既有设计意图冲突，
且可能触发未预期的配置文件读取。

**建议**：Step 2 在 `api/app.py` 内**直接定义 SSE wire-format 的轻量事件构造**
（纯 `json.dumps` 的 helper），对齐 TS 侧 `AgentSseEvent` 契约。
`gateway/stream_events.py` 的 dataclass 属于**进程内**事件类型，
**不是 wire format** —— 二者不必共用。这样既避免重依赖，
也让对外契约只有一处定义（TS 侧 `stream-events.ts`）。

---

## 2. Step 0 要求的四项确认

### 2.1 Next.js 入口

| 层 | 文件 | 行 |
|---|---|---|
| 页面 | `src/app/[locale]/agent/page.tsx` | `:124` `useSSE()`，`:354` `start({url:'/api/agent/chat'})` |
| Hook | `src/hooks/use-sse.ts` | `:33` `useSSE()` |
| 路由 | `src/app/api/agent/chat/route.ts` | 711 行；`:449` 分流判断，`:484` `agentSseResponse`，`:611` 交付 |

另有两个页面复用 `useSSE`（非 Agent 主链路）：
`src/app/[locale]/reviews/page.tsx:46`、`src/app/[locale]/knowledge/page.tsx:45`。

### 2.2 Python 启动入口

```
scripts/roveagent-service.sh:35
  exec "$PYBIN" -m uvicorn roveagent.api.app:get_app --factory \
       --host "$HOST" --port "$PORT"
        └── roveagent/api/app.py:660  get_app()
              └── roveagent/api/app.py:228  create_app() → FastAPI
```

必需环境变量（脚本 `:25` 对 API_KEY 用 `${VAR:?}` 强制）：

| 变量 | 必需性 | 代码位置 |
|---|---|---|
| `ROVEAGENT_API_KEY` | **必需** | `app.py:234` |
| `ROVEAGENT_ROOT` | 建议（否则回落相对路径 `.roveagent`） | `app.py:138` |
| `ROVEAGENT_APPROVAL_SECRET` | 签名端点必需（缺失回落 API_KEY） | `app.py:253` |
| `ROVEAGENT_LLM_API_KEY` | **业务必需**（缺失 → 503） | `app.py:112` |
| `ROVEAGENT_LLM_BASE_URL` | 可选 | `app.py:120` |
| `ROVEAGENT_LLM_MODEL` | 可选（默认 `gpt-4o-mini`） | `app.py:122` |

### 2.3 client 调用方式

`src/lib/roveagent/client.ts` 全部经私有 `call<T>()`（`:36`）：

```
:28  roveAgentConfigured()   → Boolean(URL || KEY)
:36  call()                  → fetch + X-RoveAgent-Key + 30s AbortController
:62  signedBody()            → HMAC 签名（仅 :163 / :197 使用）

:101 roveAgentChat()         非流式    POST /api/agent/chat
:151 roveAgentCreateTask()   非流式    POST /api/agent/task
:163 roveAgentExecuteTask()  签名      POST /api/agent/execute
:184 roveAgentTaskStatus()   非流式    GET  /api/agent/status/{id}
:197 roveAgentResolveTool()  签名      POST /api/agent/tool/resolve
:247 roveAgentMemory()       非流式    GET  /api/agent/memory
:295 roveAgentSkillMarket()  非流式    GET  /api/agent/skills/market
:303 roveAgentInstallSkill() 非流式    POST /api/agent/skills/install
:264 roveAgentCreateSkill()  非流式    POST /api/agent/skill/create
```

**无任何流式调用** —— `call()` 是 `res.json()`，Step 2 需新增流式变体。

### 2.4 SSE 实现位置

| 位置 | 形态 | 用途 |
|---|---|---|
| `src/lib/api-helpers.ts:30` | `sseResponse(gen)` → `data: {text}` | 简单文本流 |
| `src/app/api/agent/chat/route.ts:484` | `agentSseResponse(async emit => …)` | **有类型事件流（主链路）** |
| `src/lib/agent/stream-events.ts:116` | `AgentSseEvent` 联合类型 | **权威事件契约** |
| `src/hooks/use-sse.ts:58-92` | 手写 reader 解析 | 前端消费 |

---

## 3. 四层断链（精确落点）

| 层 | 位置 | 现状 | Step |
|---|---|---|---|
| L1 配置 | `.env`(缺) / `scripts/deploy.env`(无 `ROVEAGENT_*`) | 内核未运行，:8788 拒连 | Step 1 |
| L2 降级 | `route.ts:470-476` | `console.warn` 后静默走 TS；前端无感 | Step 1 / Step 3 |
| L3 契约 | `app.py:277` 返回 `dict` vs `client.ts:101` `res.json()` | **两端都是非流式** | Step 2 |
| L4 权限 | `app.py:332` `toolsets=("safe","memory","business")` | 与 `req.agent` 无关 | Stage 2 |

---

## 4. Step 2 的关键发现：**流式引擎已经存在，只是没接线**

这是本次扫描最重要的结果，直接改变 Step 2 的工作量估算。

`roveagent/runtime.py:445` 的 `AIAgent.__init__` 暴露 **21 个回调**，其中与流式直接相关的：

```python
:488  stream_delta_callback: callable = None      # ★ 逐 token 增量
:489  interim_assistant_callback: callable = None # ★ 中间态助手文本
:475  tool_progress_callback: callable = None     # 工具进度
:476  tool_start_callback: callable = None        # ★ 工具开始
:477  tool_complete_callback: callable = None     # ★ 工具结束
:490  tool_gen_callback: callable = None
:491  status_callback: callable = None            # ★ 阶段状态
:492  notice_callback: callable = None            # ★ 提示
:494  event_callback: Optional[Callable[[str, dict], None]] = None  # ★ 通用事件
```

而 `api/app.py:100-129` 的 `agent_chat()`：

```python
def agent_chat(self, system, user, *, max_iterations=8,
               toolsets=("safe","memory"), history=None) -> str:      # :103 返回 str
    agent = AIAgent(
        base_url=…, api_key=…, model=…,
        enabled_toolsets=list(toolsets),
        max_iterations=max_iterations,
        quiet_mode=True,
        ephemeral_system_prompt=system,
        prefill_messages=list(history) if history else None,
    )                                                                  # :119-128
    return agent.chat(user)                                            # :129
```

**21 个回调一个都没传。**

→ **结论**：Step 2 **不需要新建流式引擎，也不需要改 `runtime.py`**。
只需在 `api/app.py` 新增一个流式包装函数，把已有回调桥接到 SSE 事件。

**这是接线工作，不是开发工作。** 需新增的代码量估计在 150–250 行（含事件构造与一个路由）。

需要特别确认的一点（Step 2 首要动作）：`stream_delta_callback` 在 `runtime.py` 中的
**实际调用点与频率**——决定 token 粒度是真实逐字，还是按上游 chunk 到达。
若上游是 chunk 级，前端体验仍是流式，但不必声称「逐 token」。

---

## 5. Step 2 的事件契约映射（建议）

你给的事件名与仓库既有 `AgentSseEvent`（`stream-events.ts:116`）**不一致**。
`use-sse.ts:17` 的 `KNOWN_EVENT_TYPES` 是白名单，**未知类型被静默丢弃**（`:85`）。

因此 Python 流式端点**必须映射到既有契约**，否则前端收不到任何东西：

| 你的命名 | 必须映射为既有契约 | 依据 | Python 来源 |
|---|---|---|---|
| `token` | `delta` `{text}` | `stream-events.ts:42` | `stream_delta_callback` |
| `tool_call` | `status` `{phase:'calling_tool', tool}` | `:33-40` | `tool_start_callback` |
| `tool_result` | `status` `{phase:'tool_done', tool}` | `:33-40` | `tool_complete_callback` |
| `approval_required` | `notice` `{level,message,code}` | `:52-63` | `gate_hook` 已回 JSON 结果 |
| `completed` | `done` `{}` | `:109-114` | 流结束 |
| `error` | `error` `{error,code}` | `:96-107` | 异常 |
| （阶段） | `status` `{phase:'thinking'|'analyzing'|'generating'}` | `:15-21` | `status_callback` |

**建议**：对外提供既有契约（前端零改动即可逐 token 显示），
另在同一条流内附带 `type:'runtime'` 与 `type:'tool_event'` 作为**附加**事件——
但**必须先加进 `KNOWN_EVENT_TYPES`**，否则会被丢弃。这是个 `use-sse.ts` 的单点改动。

---

## 6. 本轮扫描发现的三个既有缺陷（Step 1/2 需顺带处理）

| # | 缺陷 | 证据 | 影响 |
|---|---|---|---|
| B1 | `approval` 事件不可达 | `use-sse.ts:17` 白名单无 `approval`；但 `page.tsx:402` 有处理分支 | 服务端若推 `approval` 会被**静默丢弃**；聊天内审批卡片无法工作 |
| B2 | `runtime_status` 字段不存在 | 全仓无 `runtime_status` | Step 3 需新增，并同步 `AgentSseEvent` |
| B3 | `agent_chat` 的 `toolsets` 与 `max_iterations` 默认值未生效 | `app.py:332` 未传 `max_iterations`，用默认 8；`toolsets` 被硬编码 | Stage 2 的处理点 |

B1 值得注意：**它意味着功能已写好但接线断了**——与本次审计的主结论同型。

---

## 7. 阻塞清单（Step 1 启动前必须解决）

| # | 阻塞 | 现状 | 谁能解 |
|---|---|---|---|
| **E1** | 无 `.env`，`scripts/deploy.env` 无 `ROVEAGENT_*` | 已实测确认 | 需你确认内核地址与密钥策略 |
| **E2** | **无 LLM 凭据** → `/api/agent/chat` 必然 503 | 探针实测 `LLM configured: False` | **需你提供**（TS 侧 `model_configs` 里有，但需库访问权限） |
| **E3** | 内核启动路径有真实 aux 上游调用与计费告警 | 探针实测 OpenRouter payment 错误 | 建议 `auxiliary.free_only: true` 或禁用 |
| **E4** | 无法验证 Step 1 完成标准 | 测试 1 需 `curl :8788/api/health` → **必须有 E2** | 依赖 E2 |

**关键约束**：你在 §六 列的「阶段1完成标准」测试 1–4，**全部需要 E2 才能执行**。
其中测试 2/3（RoveAgent Runtime 生效、逐 token 显示）需要能真正完成一次模型调用。

→ **在拿到 LLM 凭据前，我可以完成 Step 1 与 Step 2 的全部代码改造，
但无法产出测试结果。** 按你 §七 的要求（必须给出「测试结果」），
这一点必须先说清楚，避免交付一份没有测试结果的报告。

**可选的推进方式**（任一即可解锁 E2）：

| 方式 | 说明 |
|---|---|
| A | 你把 `model_configs` 中某个 provider 的 key 与 base_url 给我（或写入 `.env`） |
| B | 你授权我读取 Supabase（需 `.env` 里的 `COZE_SUPABASE_*`）—— 注意本机当前无 `.env` |
| C | 你先手工执行 Step 1 的配置部分，我只交付代码改造，测试由你在有凭据的环境执行 |

我推荐 **A**：最小暴露面，且能立刻跑通测试 1–4。

---

## 8. 待你确认的 Step 2 设计选择

| # | 问题 | 选项 | 我的建议 |
|---|---|---|---|
| S1 | 流式端点形态 | (a) 新增 `POST /api/agent/chat/stream`（你 §四 的写法）<br>(b) 同一端点按 `Accept: text/event-stream` 分支 | **(a)**，符合你 §五「保留非流式接口」的要求，且路由清晰 |
| S2 | 是否保留 `/api/agent/chat` | 你 §五 明确要求保留 | **保留**，且 `client.ts` 两个方法并存 |
| S3 | `use-sse.ts` 白名单是否扩展 | 必须扩展才能传 `runtime` / `approval` / `tool_event` | **扩展**（同时修 B1） |
| S4 | Python 侧是否需要流式 DB 落库 | 现有 `chat()` 在返回后落 `chat_sessions` + memory + audit | **流结束后落一次**，保持与现有行为一致 |

---

## 9. Confidence & gaps

**本轮已取证（含行号）**：Next.js 双入口与 hook、Python 启动链与 6 个环境变量、
`client.ts` 9 个方法与私有 `call()`、SSE 三处实现位置、
`AIAgent` 21 个回调（含 6 个流式相关）、`agent_chat()` 只传 7 个参数且返回 `str`、
`use-sse.ts` 白名单 7 种类型、`approval` 不可达、
`AgentSseEvent` 8 种事件契约、前端 7 个事件分支。

**未取证**：
1. `runtime.py` 中 `stream_delta_callback` 的**实际调用点与调用频率**（未逐一读实现）——
   这决定 Step 2 的 token 粒度是否真实逐字，还是按 chunk。**Step 2 首要验证项。**
2. `agentSseResponse` 的实现（未读；推断为 `stream-events` 的 SSE 包装）。
3. ~~`gateway/stream_events.py` 是否可直接 import~~ → **已取证：不要 import**（见 §1.1）。
   `gateway/__init__.py` 会拉入 config/session/delivery → shutdown_watchdog /
   `core.secret_scope` / `clisupport.config` / `whatsapp_identity`。Step 2 改为在
   `api/app.py` 内自定义轻量 wire-format 事件构造。
4. `E2` LLM 凭据的可用来源。
5. `tools/environments/docker.py` 的真实隔离强度（Stage 6 才需要）。

**本报告未修改任何业务代码。** 前序只读探针：`scripts/_probe_roveagent_boot.py`。

---

## 10. 下一步

请答复 **E2**（LLM 凭据来源）与 **S1/S3**（两个设计选择）。
收到后我按你的顺序执行 Step 1 → Step 2 → Step 3 → Step 4，
并按 §七 格式逐项交付：**修改文件 / 修改原因 / 完整 diff / 测试命令 / 测试结果**。

若你希望**先要代码、测试后补**，请明确说明——
我会交付 Step 1+2 的完整改造与 diff，并把「测试结果」一栏留为待执行，
绝不填写未实际运行的结果。
