# Runtime Takeover Report — Step 2（SSE Runtime 事件接线）

**日期**：2026-09-12
**范围**：Step 2 — 新增 `POST /api/agent/chat/stream`，把已有的 Runtime 回调接到 SSE。
**约束遵守**：只接线不重写流式；复用 `runtime.py` 已有 callback；事件符合 `AgentSseEvent` 契约；
**未修改 `runtime.py`**；未新增权限系统。
**前置**：`docs/stage1.75-agent-toolset-mapping-report.md`

---

## 1. 修改文件

| # | 文件 | 动作 | 说明 |
|---|---|---|---|
| 1 | `roveagent/api/stream_wire.py` | **新建** | SSE wire format 事件构造 + 回调翻译 |
| 2 | `roveagent/api/stream_wire_test.py` | **新建** | 18 测试 / 29 子测试（契约） |
| 3 | `roveagent/api/app.py` | 修改 | `stream_agent_chat` + `/api/agent/chat/stream` + 抽取共用前置 |
| 4 | `src/lib/roveagent/client.ts` | 修改 | `roveAgentChatStream()` |
| 5 | `src/app/api/agent/chat/route.ts` | 修改 | 消费内核对流 + 映射事件 + `runtime_status` |
| 6 | `src/lib/agent/stream-events.ts` | 修改 | 新增 `AgentRuntimeStatusEvent` |
| 7 | `src/hooks/use-sse.ts` | 修改 | 白名单补 `runtime_status` + `approval` |
| 8 | `tests/roveagent-stream-contract.test.ts` | **新建** | 跨语言契约护栏（5 测试） |
| 9 | `scripts/_probe_stream_route.py` | **新建** | 只读路由探针 |

**未修改**：`roveagent/runtime.py`（零改动）、权限策略表、`permissions/engine.py`。

---

## 2. 修改原因与 diff

### 2.1 为什么需要映射而不是直传

前端 `src/hooks/use-sse.ts` 的 `KNOWN_EVENT_TYPES` 是**白名单**，
未知 `type` 被 `continue` **静默丢弃**。你需求文档里的 `token` / `tool_call` /
`tool_result` / `completed` 都**不在**白名单内 —— 直传等于什么都不显示。

因此严格映射到既有 `AgentSseEvent` 契约：

| 需求文档的说法 | 实际事件 | 来源回调 |
|---|---|---|
| `token` | `delta{text}` | `stream_delta_callback(text)` |
| `tool_call` | `status{phase:'calling_tool', tool}` | `tool_progress_callback("tool.started", …)` |
| `tool_result` | `status{phase:'tool_done', tool}` | `tool_progress_callback("tool.completed", …)` |
| `approval_required` | `notice{level,code}` | 门控拦截结果的 JSON |
| `completed` | `done{}` | 流结束 |

### 2.2 `roveagent/api/stream_wire.py`（新建）

**不 import `gateway.stream_events`** —— 理由已实测：`gateway/__init__.py` 会拉入
`config` / `session` / `delivery` → `shutdown_watchdog` / `core.secret_scope` /
`clisupport.config` / `whatsapp_identity`。`api` 层保持轻量。

```python
def events_for_callback(payload: Mapping[str, Any]) -> list[str]:
    """把 stream_agent_chat 的回调负载翻成 0..n 条 SSE 行。"""
    kind = payload.get("kind")
    if kind == "delta":
        text = payload.get("text")
        return [ev_delta(text)] if isinstance(text, str) and text else []
    if kind == "tool":
        phase = tool_progress_to_phase(str(payload.get("event") or ""))
        if phase is None:
            return []          # _thinking / reasoning.available 等非工具事件：忽略
        out = [ev_status(phase, tool=str(payload.get("tool") or ""))]
        notice = gate_denied_notice(payload.get("result"))
        if notice:
            out.append(notice)  # 被门控拦下时额外补一条可见提示
        return out
    if kind == "status":
        args = payload.get("args") or []
        return [ev_status("analyzing", label=str(args[0]))] if args else []
    return []
```

**关键性质**：未知回调类型返回**空列表** —— 不猜、不自造事件名。

`gate_denied_notice()` 把 `enterprise/gate_hook.py:_block_result` 产出的 JSON
（`{"error":"enterprise_gate_blocked", "requires_approval":…}`）翻成用户可读 notice。
这样「工具被门控拒绝」在流里是**可见**的，而不是静默消失。

### 2.3 `roveagent/api/app.py`

**（a）抽取共用前置** —— `_prepare_chat()` / `_persist_turn()` 从原 `chat()` 原样抽出，
逐字保留（记忆检索、persona 文案、system/user 拼装、历史注入语义不变）。
`/api/agent/chat` 的**非流式契约、HMAC 签名、审批回放、任务执行全部不变**。

**（b）`_build_agent()`** —— `agent_chat` 与 `stream_agent_chat` 共用构造，
把三个**早已存在但从未被传**的回调透传：

```diff
         return AIAgent(
             base_url=os.environ.get("ROVEAGENT_LLM_BASE_URL") or None,
             api_key=api_key,
             model=os.environ.get("ROVEAGENT_LLM_MODEL", "gpt-4o-mini"),
             enabled_toolsets=list(toolsets),
             max_iterations=max_iterations,
             quiet_mode=True,
             ephemeral_system_prompt=system,
             prefill_messages=list(history) if history else None,
+            stream_delta_callback=on_delta,
+            tool_progress_callback=on_tool,
+            status_callback=on_status,
         )
```

**（c）新增 `/api/agent/chat/stream`** —— 同步生成器 + `queue.Queue` 桥接。

**一个必须记录的设计修正**：初版用 `loop.call_soon_threadsafe` +
`asyncio.ensure_future(asyncio.to_thread(...))`（照搬
`gateway/platforms/api_server_runs.py` 的做法），实测**直接 500**：

```
File "roveagent/api/app.py", line 489, in _generate
    loop = asyncio.get_running_loop()
RuntimeError: no running event loop
```

原因：Starlette 用 `run_in_threadpool` 迭代**同步生成器**
（`starlette/concurrency.py:51` 的 `_next`），因此 `_generate()` 本身运行在
**线程池线程**里，此处**没有** running event loop。

修正为纯 `threading.Thread` + `queue.Queue`（二者自身线程安全），
不经过事件循环 —— 更简单也更贴合实际执行模型。同步生成器里也不再需要 `await`。

### 2.4 `src/lib/roveagent/client.ts` — `roveAgentChatStream()`

异步生成器，逐行解析 `data:` 前缀。与 `call()` 相同的鉴权头与
`RoveAgentUnavailable` 语义；超时放宽到 10 分钟（工具循环可能很长），
并支持外部 `AbortSignal`（用户点停止）。

### 2.5 `src/app/api/agent/chat/route.ts`

- **连通探测前移**：先 `await stream.next()` 取首事件。这样「Runtime 不可用」
  仍能在流开始前捕获并走降级判断；一旦开始 `emit` 就无法再改走 TS 路径。
- **`mapRoveAgentEvent()`**：把内核宽松的 `Record<string, unknown>` 收窄为
  `AgentSseEvent` 联合类型的一支；未知类型返回 `null` 跳过。
- **`runtime_status` 最先发出**，前端据此知道本次由谁执行。
- **`roveAgentFull` 累积**内核正文，交给下游**同一份**产物交付逻辑
  （`deliverRequestedFiles`），因此 RoveAgent 路径同样能产出 PDF/Word/Excel。
- 修正了一个自引入 bug：曾在转发后立即 `emit({type:'done'})`，
  那会让前端在产物与审批卡片之前就结束；已移除，`done` 由下方统一逻辑发出。

### 2.6 `src/lib/agent/stream-events.ts` + `src/hooks/use-sse.ts`

```diff
+export interface AgentRuntimeStatusEvent {
+  type: 'runtime_status';
+  mode: 'roveagent' | 'fallback' | 'unavailable';
+  detail?: string;
+}
+
 export type AgentSseEvent =
   …
   | AgentDoneEvent
+  | AgentRuntimeStatusEvent;
```

```diff
-const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
+export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
   'status', 'provider', 'delta', 'artifact', 'notice', 'error', 'done',
+  'approval',
+  'runtime_status',
 ]);
```

**修复了一个既有缺陷**（Step 1 报告 B1）：`approval` 此前不在白名单，
而 `page.tsx:402` 早就有 `case 'approval'` 分支 —— 服务端推的审批卡片
一直被**静默丢弃**。现已补齐。

---

## 3. 实际测试结果

### 3.1 端到端 SSE（真实 HTTP + Mock LLM + 真实 Gate）

```
$ curl -s -N -D - -X POST http://127.0.0.1:8788/api/agent/chat/stream \
    -H "X-RoveAgent-Key: k-s2" -d @payload.json

HTTP/1.1 200 OK
cache-control: no-cache
connection: keep-alive
x-accel-buffering: no
content-type: text/event-stream; charset=utf-8
transfer-encoding: chunked

data: {"type": "runtime_status", "mode": "roveagent", "detail": "agent=developer"}
data: {"type": "status", "phase": "thinking"}
data: {"type": "status", "phase": "calling_tool", "tool": "read_file"}
data: {"type": "status", "phase": "tool_done", "tool": "read_file"}
data: {"type": "delta", "text": "\n\n已读取文件。"}
data: {"type": "delta", "text": "Mock P"}
data: {"type": "delta", "text": "rovide"}
data: {"type": "delta", "text": "r 链路验证"}
data: {"type": "delta", "text": "完成：工具调"}
data: {"type": "delta", "text": "用已通过 E"}
data: {"type": "delta", "text": "nterpr"}
data: {"type": "delta", "text": "iseToo"}
data: {"type": "delta", "text": "lGate，"}
data: {"type": "delta", "text": "SSE 事件"}
data: {"type": "delta", "text": "已回传。"}
data: {"type": "done"}
data: [DONE]
```

**这是 Step 2 的核心证据**：真实逐片流式（11 个 delta），
且 `calling_tool` / `tool_done` 是**真实工具调用**产生的事件，
不是伪造的 —— `read_file` 确实经过 `EnterpriseToolGate` 执行。

### 3.2 回归（非流式端点未被破坏）

```
$ POST /api/agent/chat   →  HTTP 200
{"reply":"已读取文件。…","agent":"developer","history_turns":1,"memory_used":1}
```

`history_turns=1` / `memory_used=1` 说明落库与记忆沉淀仍正常。

### 3.3 鉴权（流式端点同样受保护）

```
$ POST /api/agent/chat/stream  （无 Key）
HTTP 401  {"detail":"invalid X-RoveAgent-Key"}
```

### 3.4 Agent 隔离仍然生效

```
$ agent=ceo, permissions=["files:read","orders:read"]
data: {"type": "runtime_status", "mode": "roveagent", "detail": "agent=ceo"}
data: {"type": "status", "phase": "calling_tool", "tool": "read_sales"}   ← 不是 read_file
```

### 3.5 单元与契约测试

```
$ python -m pytest roveagent/api/stream_wire_test.py \
      roveagent/api/toolsets_test.py roveagent/tools/permissions_policy_test.py -q
58 passed, 72 subtests passed in 0.67s

$ pnpm exec tsx --test tests/roveagent-stream-contract.test.ts
✔ Python 产出的每个事件名都在前端白名单内
✔ 白名单覆盖 Step 2 必需的事件类型
✔ 不得为后端事件自造名字（token/tool_call/tool_result/completed）
✔ AgentSseEvent 联合类型包含 runtime_status
✔ runtime_status 的 mode 取值与 Python 侧一致
ℹ pass 5  fail 0

$ pnpm exec tsx --test tests/roveagent-stream-contract.test.ts \
      tests/roveagent-core.test.ts tests/agent-workspace-21.test.ts tests/personas.test.ts
ℹ tests 50  pass 50  fail 0

$ pnpm exec tsc -p tsconfig.json --noEmit     →  exit 0
```

### 3.6 路由清单（17 条，新旧端点并存）

```
POST /api/agent/chat          ← 保留（非流式）
POST /api/agent/chat/stream   ← 新增
POST /api/agent/execute       ← 保留（HMAC 签名）
POST /api/agent/tool/resolve  ← 保留（HMAC 签名）
```

---

## 4. 契约护栏（防漂移）

新增 `tests/roveagent-stream-contract.test.ts`：它**不启动 Python、不连数据库**，
直接读两侧源码文本，断言：

1. Python `stream_wire.py` 产出的每个事件名都在前端白名单内
2. 白名单覆盖 `runtime_status` / `approval` 等必需类型
3. Python 侧**不得**出现 `token` / `tool_call` / `tool_result` / `completed` 自造名
4. `AgentSseEvent` 联合类型已并入 `AgentRuntimeStatusEvent`

这条护栏的价值：事件名漂移在生产里的表现是「AI 不说话」，**且没有任何报错**。

---

## 5. 未验证的部分（诚实说明）

| 项 | 状态 |
|---|---|
| Python SSE 端点端到端 | **已验证**（§3.1，真实 HTTP） |
| 内核事件 → 前端事件名契约 | **已验证**（Python 单元 + TS 契约测试） |
| `mapRoveAgentEvent()` 的运行时行为 | 仅 `tsc` 通过；**未做**运行时验证（需起 Next.js + Supabase） |
| `use-sse.ts` 在浏览器里逐 token 渲染 | **未验证**（需浏览器） |
| TS 路由消费内核对流的完整链路 | **未验证**（需 `.env` 里的 Supabase 凭据 + 登录态） |

**Step 4「Mock LLM 链路测试」严格来说只完成了前半段**：
Python → SSE 已实测；TS → 浏览器那一段需要可运行的 Next.js 环境，
而本机无 `.env`（无 Supabase 凭据），无法启动完整应用。

这一点我按你的要求如实标注，不填未实际运行的结果。

---

## 6. 下一步

按你的顺序，Step 3 是 **frontend event whitelist** —— 但该改动**已在本次一并完成**
（`use-sse.ts` 白名单已补 `runtime_status` + `approval`，且 `approval` 是修复既有缺陷）。
因此 Step 3 剩余的实际内容是：

1. **`runtime_status` 的前端渲染** —— 收到 `mode !== 'roveagent'` 时给出可见提示
   （Step 1 报告 B2：全仓此前无 `runtime_status`）
2. **工具任务硬失败** —— Runtime 不可用时，工具类请求（改代码/文件/终端/部署/媒体/插件）
   必须**失败并显示明确错误**，普通聊天才允许降级。这是你 Step 1 需求 §二的原话
3. `page.tsx` 增加 `case 'runtime_status'` 分支（目前会落到 `default` 被忽略）

请确认进入 Step 3。
