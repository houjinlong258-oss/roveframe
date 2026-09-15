# Runtime Takeover Report — Step 1.5（EnterpriseToolGate 策略修正）

**日期**：2026-09-12
**范围**：Step 1.5 — 修复 EnterpriseToolGate 已确认的权限策略缺陷
**性质**：**安全边界修改**。方向为「收紧」，不扩大任何权限。
**前置**：`docs/stage1-step1-runtime-connection-report.md`（缺陷 A/B/C/D 的发现记录）

---

## 1. 修改文件列表

| # | 文件 | 动作 | 说明 |
|---|---|---|---|
| 1 | `roveagent/tools/framework.py` | 修改 | 策略表：新增 4 条显式策略行 |
| 2 | `roveagent/enterprise/gate_hook.py` | 修改 | 新增 `audit_root()`；sink 改为统一根 |
| 3 | `scripts/roveagent-service.sh` | 修改 | 单一数据根（`ROVEAGENT_HOME` 对齐）+ 依赖预检 |
| 4 | `roveagent/tools/permissions_policy_test.py` | **新建** | 21 个测试 / 23 个子测试 |

**未修改**：`runtime.py`、`api/app.py`、`write_file` / `patch` 策略、任何业务逻辑、任何 Agent prompt。

---

## 2. 修改原因与完整 diff

### 2.1 `roveagent/tools/framework.py` — 问题 A + B

**原因**：`policy_for()` 是 `fnmatch` **顺序匹配、先命中先生效**（`framework.py:149-153`）。
`read_file` 因此被前面的 `read_*` 通配捕获，要求业务分析权限 `analytics:read`；
而 `terminal` / `process` 没有任何显式行，落到兜底 `("*", "", LOW, NONE)` ——
因二者**已注册**，`authorize()` 的 fail-closed 分支（`:221`）不触发，等于免审批直执。

```diff
     # 写文件：至少经理审批（P0-11：不得免审批直执）
     ToolPolicy("write_file", "files:write", RiskLevel.MEDIUM, ApprovalPolicy.MANAGER),
     ToolPolicy("patch", "files:write", RiskLevel.MEDIUM, ApprovalPolicy.MANAGER),
-    # 只读分析类
-    ToolPolicy("read_*", "analytics:read", RiskLevel.LOW, ApprovalPolicy.NONE),
-    ToolPolicy("*_sales", "analytics:read", RiskLevel.LOW, ApprovalPolicy.NONE),
-    # 兜底（P0-11：兜底仅放行「已注册」工具；未登记工具在 authorize 中一律拒绝）
-    ToolPolicy("*", "", RiskLevel.LOW, ApprovalPolicy.NONE),
-]
+    # 文件读取：必须排在下面 `read_*` 之前 —— policy_for() 顺序匹配、先命中先生效。
+    # 在 Step 1.5 之前 read_file 会命中 `read_*` 被要求 analytics:read（业务分析权限），
+    # 语义错误（见 docs/stage1-step1-runtime-connection-report.md 缺陷 A）。
+    # 文件工具与业务查询工具严格分离：文件 → files:read，业务 → analytics:read。
+    ToolPolicy("read_file", "files:read", RiskLevel.LOW, ApprovalPolicy.NONE),
+    ToolPolicy("search_files", "files:read", RiskLevel.LOW, ApprovalPolicy.NONE),
+    # 进程/终端：显式登记，禁止落到兜底策略。
+    # 在 Step 1.5 之前二者命中 `*`（已注册 → 放行且免审批），属安全缺口（缺陷 B）。
+    ToolPolicy("terminal", "admin:process", RiskLevel.HIGH, ApprovalPolicy.MANAGER),
+    ToolPolicy("process", "admin:process", RiskLevel.HIGH, ApprovalPolicy.MANAGER),
+    # 注意：process_kill / deploy_* / refund_* / send_* 等在策略表更靠前的位置
+    # 已有显式行（顺序匹配先命中），因此这里不需要再补 `process_*` 之类的宽模式 ——
+    # 加了也会被前面的行抢先匹配，成为死行。
+    # 只读分析类（业务数据查询；文件工具不在此列）
+    ToolPolicy("read_*", "analytics:read", RiskLevel.LOW, ApprovalPolicy.NONE),
+    ToolPolicy("*_sales", "analytics:read", RiskLevel.LOW, ApprovalPolicy.NONE),
+    # 兜底（P0-11：兜底仅放行「已注册」工具；未登记工具在 authorize 中一律拒绝）
+    # 注意：**不要**在此之外新增工具而不补策略行 —— 兜底 = 免审批直执。
+    ToolPolicy("*", "", RiskLevel.LOW, ApprovalPolicy.NONE),
+]
```

**与你原始建议的两处偏离（均为收紧或等价，特此说明）**：

| 你的建议 | 我的实现 | 原因 |
|---|---|---|
| `process` 用模式 `"process*"` | 用 `"process"` 精确匹配 | 工具名就叫 `process`（`process_registry.py:3486`）。且 `fnmatch("process_kill", "process*")` = **False**（`_kill` 不匹配 `*`），所以 `"process*"` 既非必要也无法覆盖 `process_kill` |
| 另加 `process_*` → ADMIN 以保 `process_kill` | **不加**（初版加过，后删除） | 策略表**第 12 行**已有 `ToolPolicy("process_kill", …, ADMIN)`，位置更靠前、先命中。再加 `process_*` 是**死行**，且 `_is_fallback` 只看 `pattern=="*"`，`process_*` 即使命中也不是兜底 —— 无实际效果 |

### 2.2 `roveagent/enterprise/gate_hook.py` — 问题 C

**原因**：审计 sink 读 `ROVEAGENT_HOME`（默认 `~/.roveagent`），内核数据根读
`ROVEAGENT_ROOT`（`api/app.py:138`）。二者不一致 → 按配置的 ROOT 找不到审计。
实测：内核 `ROOT=<repo>/.roveagent`，审计却写在 `C:\Users\24749\.roveagent\audit\`。

```diff
-def _default_audit_sink(event: dict) -> None:
-    """默认审计落地；写入失败由门控按 fail-closed 处理。"""
-    root = Path(os.environ.get("ROVEAGENT_HOME", Path.home() / ".roveagent"))
-    path = root / "audit" / "tool_gate.jsonl"
-    path.parent.mkdir(parents=True, exist_ok=True)
-    with path.open("a", encoding="utf-8") as f:
-        f.write(json.dumps(event, ensure_ascii=False) + "\n")
+def audit_root() -> Path:
+    """审计根目录 —— 与内核数据根统一。
+
+    新的优先级：
+      1. ``ROVEAGENT_ROOT``  —— 内核数据根的权威来源
+      2. ``ROVEAGENT_HOME``  —— 旧变量，仅作兼容回落
+      3. ``~/.roveagent``    —— 最终默认值
+    """
+    explicit_root = os.environ.get("ROVEAGENT_ROOT", "").strip()
+    if explicit_root:
+        return Path(explicit_root) / "audit"
+    legacy_home = os.environ.get("ROVEAGENT_HOME", "").strip()
+    if legacy_home:
+        return Path(legacy_home) / "audit"
+    return Path.home() / ".roveagent" / "audit"
+
+
+def _default_audit_sink(event: dict) -> None:
+    """默认审计落地；写入失败由门控按 fail-closed 处理。"""
+    path = audit_root() / "tool_gate.jsonl"
+    path.parent.mkdir(parents=True, exist_ok=True)
+    with path.open("a", encoding="utf-8") as f:
+        f.write(json.dumps(event, ensure_ascii=False) + "\n")
```

**为什么不能只改 sink**：全文检索确认 `ROVEAGENT_HOME` 是 roveagent **系统级约定** ——
`constants.get_roveagent_home()` 驱动 logs / skills / auth.json / memory / plugin-data /
cache 等数十个子系统。只改审计会让审计成为**唯一的例外**，问题从「两个根」变成
「一个根 + 一个特例」。因此 `.3` 补上了 **launcher 侧的根对齐**：

```diff
 export ROVEAGENT_ROOT="${ROVEAGENT_ROOT:-$(pwd)/.roveagent}"
+
+# 单一数据根（Step 1.5 / 问题 C）
+# 内核读 ROVEAGENT_ROOT，其余子系统通过 get_roveagent_home() 读 ROVEAGENT_HOME。
+# 这里把 ROVEAGENT_HOME 显式对齐到同一个根，保证只有【一个】数据根。
+if [[ -z "${ROVEAGENT_HOME:-}" ]]; then
+  export ROVEAGENT_HOME="${ROVEAGENT_ROOT}"
+  echo "[roveagent] data root pinned: ROVEAGENT_HOME=ROVEAGENT_ROOT=${ROVEAGENT_ROOT}"
+elif [[ "${ROVEAGENT_HOME}" != "${ROVEAGENT_ROOT}" ]]; then
+  echo "[roveagent] WARNING: ROVEAGENT_HOME (${ROVEAGENT_HOME}) != ROVEAGENT_ROOT (${ROVEAGENT_ROOT})"
+  echo "[roveagent]          audit goes to ROVEAGENT_ROOT/audit; other state follows ROVEAGENT_HOME"
+fi
```

### 2.3 `scripts/roveagent-service.sh` — 问题 D

**原因**：`concurrent-log-handler` 在 `pyproject.toml:40` 已声明为 win32 依赖，
但缺装时导入失败发生在**第一个用户请求**上（`agent_init.py:1079` → `logsetup.py:65`），
表现为 `/api/agent/chat` 返回 **HTTP 500**，而不是启动失败。把失败前移到启动阶段。

```diff
 PYBIN="${ROVEAGENT_PYTHON:-python}"
+
+# 依赖预检（用 `python -c` 而非 heredoc：本项目在 Windows 上也会被调用）
+DEP_CHECK='import importlib, sys
+missing = []
+try:
+    import fastapi, uvicorn  # noqa: F401
+except ImportError as exc:
+    missing.append(exc.name + " (install: pip install -e \".[web]\")")
+if sys.platform == "win32":
+    try:
+        importlib.import_module("concurrent_log_handler")
+    except ImportError:
+        missing.append("concurrent-log-handler (install: pip install concurrent-log-handler==0.9.29)")
+if missing:
+    sys.stderr.write("[roveagent] FATAL: missing runtime dependencies:\n")
+    for item in missing:
+        sys.stderr.write("  - " + item + "\n")
+    sys.exit(1)'
+"$PYBIN" -c "$DEP_CHECK" || exit 1
```

---

## 3. 安全影响分析

### 3.1 权限变化矩阵（全部为收紧或不变）

| 工具 | 修改前 | 修改后 | 方向 |
|---|---|---|---|
| `read_file` | `read_*` → `analytics:read`，LOW，免审批 | `read_file` → **`files:read`**，LOW，免审批 | **权限点修正**（不是放宽：`analytics:read` 不再能解锁文件读） |
| `search_files` | 兜底 `*` → 无权限点，免审批 | **`files:read`**，LOW，免审批 | **收紧**：新增权限要求 |
| `terminal` | 兜底 `*` → 无权限点，**免审批直执** | **`admin:process`**，HIGH，**MANAGER 审批** | **显著收紧** |
| `process` | 兜底 `*` → 无权限点，**免审批直执** | **`admin:process`**，HIGH，**MANAGER 审批** | **显著收紧** |
| `write_file` | `files:write`，MEDIUM，MANAGER | 不变 | 未触碰 |
| `patch` | `files:write`，MEDIUM，MANAGER | 不变 | 未触碰 |
| `process_kill` | `admin:process`，HIGH，ADMIN | 不变（第 12 行显式命中） | 未触碰 |
| `deploy_*` | `admin:deploy`，CRITICAL，ADMIN | 不变 | **未开放部署权限** |
| `read_sales` 等 8 个业务查询 | 各自的细粒度权限点 | 不变 | 未触碰（有回归测试锁定） |

### 3.2 缺陷 A 的真实性质（一个容易误判的点）

`read_file` 在修改前**已经需要权限**（`analytics:read`），所以它**不是**「无权限直执」。
真实危害是**权限语义错配**：

- **收紧了错的维度**：只做业务分析的账号（有 `analytics:read`）能读任意文件
- **放宽了错的维度**：只有 `files:read` 的 Developer Agent 读不了文件

修改后 `analytics:read` **不再**能解锁文件读（`test_4c` 锁定该回归）。

### 3.3 缺陷 B 是本次真正的安全修复

`terminal` / `process` 命中兜底策略时，因工具**已注册**而**放行且免审批**。
即：任何拿到这两个 toolset 的 Agent 都能无审批执行任意命令。
修改后二者需要 `admin:process` 权限**且**走审批流程。

### 3.4 未扩大权限的证明

本次**只新增策略行，未删除任何策略行**，未修改 `DEFAULT_POLICIES` 之外的任何
授权判断逻辑。唯一的逻辑新增是 `audit_root()`，它只影响审计**路径**，不参与授权决策。
`test_dangerous_tools_not_silently_opened` 与 `test_fallback_policy_still_denies_unknown_tools`
作为回归保护锁定这两点。

### 3.5 遗留安全观察（**未修**，需你决策）

**发起者可自行批准 MANAGER 级动作。** `_role_gate`（`framework.py:205-207`）用：

```python
return _ROLE_RANK.get(ctx.role, 0) >= _ROLE_RANK[required_role] + 1
```

`_ROLE_RANK = {viewer:0, staff:1, manager:2, owner:3, admin:4}`。
因此 `owner(3) >= manager(2)+1` 成立 → **owner 可以自行放行 MANAGER 级动作**，
不产生审批单、不留二次确认。

这意味着：**owner 身份的 DevOps Agent 调用 `terminal` 时不会进入审批**。
`test_5c_owner_bypasses_manager_level_via_role_rank` 明确记录了这一行为。

- 这是 `_role_gate` 的**既有语义，不是本次引入**
- 它可能是**有意设计**（小微企业里老板即经理，不需要自批自）
- 但若你的意图是「所有生产操作必须审批」，那么需要一个 Stage 2 议题：
  **对 `HIGH`/`CRITICAL` 风险级，即使发起者有权限，也强制留审批留痕**

我没有擅自改这一条 —— 它会影响所有 MANAGER 级策略（含 `send_*` 对外通信），
属于行为语义变更，超出 Step 1.5「只修正已有工具对应权限」的范围。

---

## 4. 测试命令

```bash
# 策略单元测试（验收测试 1–5 + 安全回归 + 审计根）
python -m pytest roveagent/tools/permissions_policy_test.py -v

# 语法检查
python -m py_compile roveagent/tools/framework.py roveagent/enterprise/gate_hook.py
"C:\Program Files\Git\bin\bash.exe" -n scripts/roveagent-service.sh

# 依赖预检
python -c "import importlib,sys; importlib.import_module('concurrent_log_handler'); print('OK')"

# 端到端（需先起 Mock 与内核；见 Step 1 报告 §3.3）
curl -s -H "X-RoveAgent-Key: <key>" http://127.0.0.1:8788/api/health
```

---

## 5. 实际测试结果

### 5.1 验收测试 1–5

```
$ python -m pytest roveagent/tools/permissions_policy_test.py -q
21 passed, 23 subtests passed in 0.11s
```

逐项对照：

| 你的测试 | 断言 | 结果 |
|---|---|---|
| 测试 1 `policy_for(read_file)` → `files:read` | `test_1_read_file_requires_files_read` | **PASSED** |
| 测试 2 `policy_for(write_file)` 保持 `files:write` + MANAGER | `test_2_write_file_unchanged` | **PASSED** |
| 测试 3 `policy_for(terminal)` → `admin:process` + MANAGER | `test_3_terminal_requires_admin_process_with_approval` | **PASSED** |
| 测试 4 developer + `files:read` → `read_file` 通过门控 | `test_4_developer_with_files_read_passes_gate` | **PASSED** |
| 测试 5 `terminal` 必须进入审批流程 | `test_5_terminal_enters_approval_flow` | **PASSED** |

**测试 5 的说明**：断言用 `role="manager"` 作为发起者，因为按 §3.5 的既有语义，
`owner` 会凭角色等级自行放行。两条路径都有测试覆盖：

```
test_5_terminal_enters_approval_flow                 PASSED  (manager → requires_approval=True)
test_5c_owner_bypasses_manager_level_via_role_rank   PASSED  (owner → allowed，记录既有行为)
```

### 5.2 策略表实测输出（修改后）

```
 8 refund_*           perm=payments:refund  risk=HIGH      approval=owner
11 deploy_*           perm=admin:deploy     risk=CRITICAL  approval=admin
12 process_kill       perm=admin:process    risk=HIGH      approval=admin     ← 未被改动
16 write_file         perm=files:write      risk=MEDIUM    approval=manager   ← 未被改动
17 patch              perm=files:write      risk=MEDIUM    approval=manager   ← 未被改动
18 read_file          perm=files:read       risk=LOW       approval=none      ← 新增
19 search_files       perm=files:read       risk=LOW       approval=none      ← 新增
20 terminal           perm=admin:process    risk=HIGH      approval=manager   ← 新增
21 process            perm=admin:process    risk=HIGH      approval=manager   ← 新增
23 read_*             perm=analytics:read   risk=LOW       approval=none      ← 未改动
25 *                  perm=                risk=LOW       approval=none      ← 兜底未改动
```

解析结果：

```
read_file    -> pattern='read_file'    perm='files:read'     approval=none
read_sales   -> pattern='read_sales'   perm='orders:read'    approval=none   ← 未被污染
process      -> pattern='process'      perm='admin:process'  approval=manager
process_kill -> pattern='process_kill' perm='admin:process'  approval=admin   ← 原语义保持
terminal     -> pattern='terminal'     perm='admin:process'  approval=manager
search_files -> pattern='search_files' perm='files:read'     approval=none
```

### 5.3 问题 C 端到端验证（关键）

```
修改前：
  BEFORE .roveagent\audit\tool_gate.jsonl exists: False
  BEFORE C:\Users\24749\.roveagent\audit\tool_gate.jsonl lines: 48

启动（ROVEAGENT_HOME 与 ROOT 对齐）后发一次真实请求：
  new file exists: True
  {"event_id": "0093d5b0…", "request_id": "step15-t4", "tool": "read_sales",
   "allowed": false, "required_permissions": ["orders:read"],
   "reason": "permission denied: requires 'orders:read'", …}
```

**审计已落在配置的 `ROVEAGENT_ROOT/audit`。**

**旧日志保持可读**（问题 C 的附加要求）：

```
C:\Users\24749\.roveagent\audit\tool_gate.jsonl   48 行  ← 未迁移、未删除
<repo>\.roveagent\audit\tool_gate.jsonl            2 行  ← 新增
```

同时确认 `tool_gate.jsonl` 的**唯一写入点**是 `gate_hook.py:73`
（全仓检索），不存在其它写入方，因此不会出现「审计被劈成两处」。

### 5.4 问题 D 依赖验证

```
pyproject.toml:40   "concurrent-log-handler==0.9.29; sys_platform == 'win32'"   ← 已声明
$ python -c "import concurrent_log_handler" → OK                                ← 已安装
$ 预检镜像脚本 → PREFLIGHT: PASS (all deps present)
```

### 5.5 语法与编译

```
$ python -m py_compile roveagent/tools/framework.py roveagent/enterprise/gate_hook.py \
      roveagent/tools/permissions_policy_test.py scripts/mock_llm_provider.py
exit=0

$ "C:\Program Files\Git\bin\bash.exe" -n scripts/roveagent-service.sh
exit=0
```

### 5.6 一个必须诚实说明的验证边界

**策略层面的验收测试 1–5 全部通过**（单元测试直接调用 `gate.authorize()`，这是
策略验证的正确层级）。

但**通过真实 `/api/agent/chat` 的 HTTP 路径无法验证 `read_file`** —— 原因是
`api/app.py:332` 把 toolset **硬编码**为 `("safe","memory","business")`，
其中 **不含 `file`**，因此模型根本拿不到 `read_file` 工具。

实测证据（对照）：
```
req=step15-t4   tool=read_sales  allowed=False  reqPerm=orders:read   reason=permission denied
req=step15-t4b  tool=read_sales  allowed=True   reqPerm=orders:read   reason=
```
即：在 HTTP 路径上 Mock 只能选中 `read_sales`（`business` 工具集内的工具），
权限判定正确，但 `read_file` 不可达。

**这正是 Stage 2 要解决的 L4 断链**（`Agent → Toolset` 映射）。
Step 1.5 的 `read_file` 修复本身有效，但要在 HTTP 端到端被观察到，
必须先完成 Stage 2 的 toolset 映射。

---

## 6. 与 Step 1 报告的关系

| 缺陷 | Step 1 状态 | Step 1.5 状态 |
|---|---|---|
| A `read_file` 权限错配 | 已发现 | **已修复** + 回归测试 |
| B `terminal`/`process` 免审批 | 已发现 | **已修复** + 回归测试 |
| C 审计根不一致 | 已发现 | **已修复**（含 launcher 根对齐 + 旧日志保留） |
| D 依赖缺失 | 已发现 | **已修复**（预检前移，不再首请求 500） |
| 新增观察：owner 可自批 MANAGER 动作 | — | **已记录，未修**（§3.5，需你决策） |

---

## 7. 下一步

Step 1.5 已交付，四类缺陷全部处理完毕，门控策略表已与实际工具语义对齐。

按你的指令，下一步进入 **Step 2：SSE Runtime 事件接线**。

Step 2 的三个设计要点在 Step 0 报告中已确认，可直接开工：

1. **不新建流式引擎**：`AIAgent.__init__` 已有 `stream_delta_callback` /
   `tool_start_callback` / `tool_complete_callback` / `status_callback` /
   `event_callback`；`api/app.py:119-129` 没传而已
2. **不 import `gateway.stream_events`**：`gateway/__init__.py` 会拉入
   config/session/delivery → shutdown_watchdog / `core.secret_scope` /
   `clisupport.config` / `whatsapp_identity`
3. **事件名必须映射到既有契约**：`use-sse.ts:17` 的 `KNOWN_EVENT_TYPES` 是白名单，
   未知类型被静默丢弃。`token`→`delta`、`tool_call`→`status{calling_tool}`、
   `tool_result`→`status{tool_done}`、`completed`→`done`

另请注意 Step 3 的一个前置：**`runtime_status` 与 `approval` 都必须先加入
`KNOWN_EVENT_TYPES`**，否则会被前端丢弃（Step 1 报告缺陷 B1 同型问题）。

**一个建议**：Step 2 完成后，`read_file` 的 HTTP 端到端验证仍会受 `app.py:332`
硬编码 toolset 阻塞。如果你希望尽早看到「Developer Agent 真的读到文件」，
可以考虑把 Stage 2 的 toolset 映射提前一小步（只加映射，不加新工具集）。
请指示是否要调整顺序。
