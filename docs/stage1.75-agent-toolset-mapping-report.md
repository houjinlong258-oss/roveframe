# Runtime Takeover Report — Step 1.75（Agent → Toolset 最小打通）

**日期**：2026-09-12
**范围**：Step 1.75 — 最小化打通 `Agent → Toolset` 映射。**未进入完整 Stage 2。**
**性质**：连接层修复 + 服务端权威推导。**未修改任何权限策略。**
**前置**：`docs/stage1.5-gate-policy-fix-report.md`

---

## 1. 修改文件

| # | 文件 | 动作 | 行数 |
|---|---|---|---|
| 1 | `roveagent/api/toolsets.py` | **新建** | 112 |
| 2 | `roveagent/api/toolsets_test.py` | **新建** | 176 |
| 3 | `roveagent/api/app.py` | 修改（3 处） | +8 −4 |
| 4 | `scripts/_probe_toolset_mapping.py` | **新建**（只读探针） | 61 |

**未修改**：`tools/framework.py`（权限策略表）、`permissions/engine.py`、
`api/permissions.py`、`write_file` / `patch` 策略、`runtime.py`、任何 Agent prompt。

---

## 2. 修改原因与 diff

### 2.1 根因

`api/app.py` 的 `/api/agent/chat` 把 toolset **硬编码**：

```python
reply = ctx.agent_chat(
    system, user,
    toolsets=("safe", "memory", "business"),   # ← 与 req.agent 无关
    history=history,
)
```

`("safe","memory","business")` **不含 `file`**，所以 Developer Agent 拿不到
`read_file` / `write_file` / `patch` / `search_files`；`devops` 也拿不到 `terminal`。
而 `workforce/employees.py` 里每个员工的 `tools` 声明从未被消费。

### 2.2 新增 `roveagent/api/toolsets.py` — Agent Toolset Resolver

设计**刻意与 `api/permissions.py` 的 P0-11 同构**（服务端推导 + fail-closed 收缩），
因为同一类问题在那里已经解决过一次，复用既有模式比另创一套更安全。

```python
_AGENT_RUNTIME: Final[dict[str, tuple[tuple[str, ...], int]]] = {
    "ceo":        (("safe", "memory", "business"), 8),
    "operations": (("safe", "memory", "business"), 8),
    "marketing":  (("safe", "memory", "business"), 8),
    "developer":  (("file", "terminal", "todo"), 16),
    "devops":     (("terminal", "todo"), 16),      # 见 §2.3 的偏离说明
}

DEFAULT_TOOLSETS: Final[tuple[str, ...]] = ("safe", "memory", "business")
DEFAULT_MAX_ITERATIONS: Final[int] = 8
MAX_ITERATIONS_CEILING: Final[int] = 32

def resolve_toolsets(agent_key: str) -> tuple[str, ...]: ...
def resolve_max_iterations(agent_key: str) -> int: ...
def describe_runtime(agent_key: str) -> dict[str, object]: ...
```

**职责边界（关键）**：本模块只决定「把哪些工具**递到模型面前**」；
工具**能否执行**由 `EnterpriseToolGate` 独立裁决。两层是**与**关系，不是替代关系。

### 2.3 ★ 与你给出的映射有一处偏离（必须说明）

你指定 devops 为 `terminal, process, todo`。**但 `process` 不是 toolset 名。**

registry 实测（权威来源，非文档）：

```
terminal      -> toolset='terminal'
process       -> toolset='terminal'     ← process 属于 terminal 工具集
read_file     -> toolset='file'
write_file    -> toolset='file'
patch         -> toolset='file'
search_files  -> toolset='file'
todo          -> toolset='todo'
```

`TOOLSETS` 字典中**不存在** `process` 键（实测 `"process" in TOOLSETS == False`）。

因此 `("terminal","process","todo")` 里的 `"process"` 是一个**无效名**，
会被静默忽略 —— 结果与 `("terminal","todo")` **完全等价**。
我按最小且诚实的原则写为 `("terminal","todo")`，并在代码注释里留痕。

**这不会减少任何能力**：`process` 工具随 `terminal` 工具集一并授出。
我另加了一条测试 `test_process_is_not_a_toolset_name` 锁定这个事实，
防止日后有人再把它写回去。

### 2.4 `api/app.py` 三处改动

```diff
-from pydantic import BaseModel, Field, field_validator  # noqa: E402
+from pydantic import BaseModel, ConfigDict, Field, field_validator  # noqa: E402
```

```diff
 from .security import require_safe_id, sanitize_skill_name  # P0-10 输入白名单
 from .permissions import derive_permissions  # P0-11 权限服务端推导
+from .toolsets import resolve_max_iterations, resolve_toolsets  # Step 1.75 agent→toolset 映射
```

```diff
 class _TenantScopedRequest(BaseModel):
-    """P0-10：所有请求模型的 tenant_id/business_id 统一白名单校验（fail-closed）。"""
+    """P0-10：所有请求模型的 tenant_id/business_id 统一白名单校验（fail-closed）。
+
+    Step 1.75：显式声明 ``extra="ignore"`` —— 客户端**不能**通过请求体注入
+    未被声明的字段（如 ``toolsets`` / ``max_iterations`` / ``api_key`` / ``system``）。
+    """
+
+    model_config = ConfigDict(extra="ignore")
```

```diff
         try:
-            # P0-11(c)：权限由服务端推导 —— 客户端权限按角色允许集裁剪，
-            # 员工档案固有能力（analytics:read 等）由服务端并入。
+            # P0-11(c)：权限由服务端推导 —— 客户端权限按角色允许集裁剪，
+            # 员工档案固有能力（analytics:read 等）由服务端并入。
+            #
+            # Step 1.75：toolset 与迭代预算同样由服务端按 agent 身份推导。
+            # **客户端无权指定**：ChatRequest 未定义 toolsets 字段，
+            # 请求体里即使带了该字段也不会被读取。
             with bind_tool_context(ToolContext(
                 ...
                 agent_id=emp.key,
             )):
                 reply = ctx.agent_chat(
                     system,
                     user,
-                    toolsets=("safe", "memory", "business"),
+                    toolsets=resolve_toolsets(emp.key),
+                    max_iterations=resolve_max_iterations(emp.key),
                     history=history,
                 )
```

**装配位置证明**（`app.py` 实际行号）：

```
151: from .toolsets import resolve_max_iterations, resolve_toolsets
346: reply = ctx.agent_chat(
349:     toolsets=resolve_toolsets(emp.key),
350:     max_iterations=resolve_max_iterations(emp.key),
```

注意 `emp.key` 是 `find_employee()` 解析**之后**的规范 key，
因此 `coo`/`cmo`/`cto`/`ceo-insight` 等别名都会被正确归一（实测见 §4.1）。

---

## 3. 安全影响分析

### 3.1 授权链没有变化，只是多了一层「递送」判定

```
请求
 └─ resolve_toolsets(agent)      ← 本次新增：决定「模型能看到哪些工具」
     └─ EnterpriseToolGate.authorize(ctx, tool)   ← 未改动：决定「工具能否执行」
         ├─ 权限点（derive_permissions，未改动）
         ├─ 风险级 + 审批策略（Step 1.5 修正，未改动）
         └─ 审计落盘
```

**关键性质**：拿到 `file` 工具集 **不等于** 能写文件。
`write_file` 仍需 `files:write` 权限点，且策略为 `MEDIUM + MANAGER`。
有测试 `test_toolset_grant_does_not_bypass_gate` 锁定这一点：
持有 `file` 工具集但只有 `files:read` 时，`write_file` **仍被拒绝**。

### 3.2 未开放新工具

本次**没有**授予任何此前不可达的工具集给任何 agent，唯一变化是：

| agent | 修改前（硬编码） | 修改后 | 变化 |
|---|---|---|---|
| `ceo` / `operations` / `marketing` | `safe, memory, business` | `safe, memory, business` | **无变化** |
| `developer` | `safe, memory, business` | `file, terminal, todo` | 新增 file/terminal/todo；**移除** safe/memory/business |
| `devops` | `safe, memory, business` | `terminal, todo` | 新增 terminal/todo；**移除** safe/memory/business |

注意 `developer` / `devops` **同时失去了** `business`（经营数据读取）。
这是「精确授权」的必然结果 —— 不是疏漏：Developer Agent 不该读经营数据。
如果后续需要，应由你明确指示再补。

`terminal` 是本次唯一的高风险新增。但 Step 1.5 已经把它的策略从
「兜底 → 免审批直执」改为 `admin:process + HIGH + MANAGER 审批`，
因此它**不是**一个无门槛的开放。

### 3.3 客户端权威被显式封死（测试 6）

三层防护：

1. `ChatRequest` **未定义** `toolsets` / `max_iterations` / `api_key` / `system` 字段
2. `model_config = ConfigDict(extra="ignore")` —— 显式声明丢弃策略，不再依赖框架默认
3. `resolve_toolsets()` 签名只接受 `agent_key`，多传参数会 `TypeError`

实测（§4.4）客户端注入 5 个字段，**全部被丢弃**。

### 3.4 未修改权限策略

`tools/framework.py` 的策略表**一个字节未动**。Step 1.5 的修正完整保留：

```
read_file  -> files:read   / LOW    / none
write_file -> files:write  / MEDIUM / MANAGER
patch      -> files:write  / MEDIUM / MANAGER
terminal   -> admin:process/ HIGH   / MANAGER
```

### 3.5 遗留观察（沿用 Step 1.5，未修）

`_role_gate` 的 `owner(3) >= manager(2)+1` 语义使 **owner 可自行放行 MANAGER 级动作**。
因此 owner 身份的 Developer Agent 调 `terminal` 不会进入审批。
这是既有设计，仍需你在 Stage 2 决定是否对 HIGH/CRITICAL 强制留审批留痕。

### 3.6 一个必须记录的运行时事实

出厂态实测 `get_available_toolsets()`：

```
safe=NO   coding=NO   file=yes   terminal=yes   business=yes
image_gen=NO   video_gen=yes   web=yes   search=NO
```

`ceo` 映射里的 **`safe` 当前不可用**（其 `check_fn` 依赖 web/vision/image_gen 凭据），
因此 ceo 实际只拿到 `memory` + `business` 的工具。
这不影响 Step 1.75 的验收（核心是 developer 拿到 `file`），
但说明：**toolset 名有效 ≠ 其中的工具可用**。补凭据后 `safe` 会自动恢复。

---

## 4. 测试命令与**实际测试结果**

### 4.1 映射解析（只读探针）

```
$ python scripts/_probe_toolset_mapping.py

--- 1. find_employee() resolution ---
  ceo            -> emp.key='ceo'
  operations     -> emp.key='operations'
  marketing      -> emp.key='marketing'
  developer      -> emp.key='developer'
  devops         -> emp.key='devops'
  coo            -> emp.key='operations'      ← 别名正确归一
  cmo            -> emp.key='marketing'
  cto            -> emp.key='devops'
  ceo-insight    -> emp.key='ceo'

--- 2. resolver output ---
  ceo              known=True  toolsets=['safe', 'memory', 'business'] iters=8
  operations       known=True  toolsets=['safe', 'memory', 'business'] iters=8
  marketing        known=True  toolsets=['safe', 'memory', 'business'] iters=8
  developer        known=True  toolsets=['file', 'terminal', 'todo'] iters=16
  devops           known=True  toolsets=['terminal', 'todo'] iters=16
  unknown-agent    known=False toolsets=['safe', 'memory', 'business'] iters=8   ← fail-closed
  (empty)          known=False toolsets=['safe', 'memory', 'business'] iters=8
```

### 4.2 单元测试（两套合并）

```
$ python -m pytest roveagent/api/toolsets_test.py roveagent/tools/permissions_policy_test.py -q
40 passed, 43 subtests passed in 0.69s
```

`py_compile` exit=0。

### 4.3 端到端（真实 HTTP + Mock LLM + 真实 Gate）

```
$ curl -H "X-RoveAgent-Key: <key>" http://127.0.0.1:8788/api/health
{"status":"ok",...}  HTTP 200
```

**测试 1 + 2** —— `agent=developer`，`permissions=["files:read"]`：

```
HTTP 200
{"reply":"已读取文件。Mock Provider 链路验证完成：工具调用已通过 EnterpriseToolGate，SSE 事件已回传。"}

--- gate 审计 ---
req=fin-dev  tool=read_file  allowed=True  perm=files:read
```

**这是 Step 1.75 的核心证据**：Step 1.5 之前该请求产生的是
`tool=read_sales ... permission denied: requires 'orders:read'`；
Step 1.5 之后是 `read_file` 但被拒（`analytics:read`）；
**现在 `read_file` 被真实调用、进入 Gate、并以 `files:read` 放行。**

**测试 5** —— `agent=ceo`（同样问 read 文件，同时故意授予 `files:read`）：

```
req=fin-ceo  tool=read_sales  allowed=True  perm=orders:read
```

ceo **没有** `read_file` —— 因为它没有 `file` 工具集。
即使客户端把 `files:read` 塞进 `permissions`，也拿不到文件工具（工具集是服务端权威）。

### 4.4 测试 6 —— 客户端注入（严格版）

**HTTP 层实测**：请求体带 `toolsets=["file","terminal"]` + `max_iterations=999`
的 ceo 请求 → 审计仍是 `read_sales`，**未获得 file/terminal**。

**解析层实测**：

```
raw payload keys : [agent, api_key, business_context, business_id, enabled_tools,
                    industry, max_iterations, message, request_id, role,
                    session_id, system, task_id, tenant_id, toolsets, user_id]
parsed keys      : [agent, business_context, business_id, industry, message,
                    permissions, request_id, role, session_id, task_id,
                    tenant_id, user_id]
extra policy     : ignore
LEAKED FIELDS    : NONE (all dropped)
```

### 4.5 测试 3 / 4 —— 权限策略未被回退

| 测试 | 断言 | 结果 |
|---|---|---|
| 3 | `policy_for("read_file").permission == "files:read"` | **PASSED** |
| 4 | `policy_for("write_file")` = `files:write` / MEDIUM / MANAGER | **PASSED** |
| 4b | `policy_for("patch")` approval == MANAGER | **PASSED** |
| — | 持有 `file` 工具集 + 仅 `files:read` → `write_file` 被拒 | **PASSED** |

### 4.6 验收对照（你的 6 项）

| # | 你的测试 | 结果 | 证据 |
|---|---|---|---|
| 1 | developer HTTP 请求 toolsets 含 `file` | **PASS** | §4.1 + §4.3（`read_file` 实际被调用） |
| 2 | Mock 触发 `read_file` 必须进入 Gate | **PASS** | §4.3 审计 `tool=read_file` |
| 3 | `read_file` permission = `files:read` | **PASS** | §4.5 + §4.3 `perm=files:read` |
| 4 | `write_file` 仍 MANAGER approval | **PASS** | §4.5 |
| 5 | ceo 不能获得 file/terminal | **PASS** | §4.3 `fin-ceo` 只有 `read_sales` |
| 6 | 客户端非法 toolsets 必须忽略 | **PASS** | §4.4 |

---

## 5. 下一步

Step 1.75 已交付，`Agent → Toolset` 断链（Step 0 报告的 **L4**）已打通。
Developer Agent 现在能真实拿到文件与终端工具，且这些工具的执行仍受门控约束。

按你的指令，下一步进入 **Step 2：SSE Runtime 事件接线**。

Step 2 的三个设计要点在 Step 0 报告已确认：

1. **不新建流式引擎**：`AIAgent.__init__` 已有 `stream_delta_callback` /
   `tool_start_callback` / `tool_complete_callback` / `status_callback` /
   `event_callback`；`app.py:119-129` 没传而已
2. **不 import `gateway.stream_events`**：`gateway/__init__.py` 会拉入
   config/session/delivery → shutdown_watchdog / `core.secret_scope` /
   `clisupport.config` / `whatsapp_identity`
3. **事件名必须映射到既有契约**：`use-sse.ts:17` 的 `KNOWN_EVENT_TYPES` 是白名单，
   未知类型被静默丢弃

**Step 2 现在可以拿到真实工具事件做验证** —— 这是 Step 1.75 的直接收益：
`developer` 请求会真实产生 `read_file` 调用，因此
`tool_start_callback` / `tool_complete_callback` 会真的触发，
SSE 的 `status{calling_tool}` / `status{tool_done}` 可以被端到端观察到，
而不再需要像 Step 1 那样用 `read_sales` 替代。
