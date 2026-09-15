# Runtime Takeover Report — Step 1（Runtime 连接修复）

**日期**：2026-09-12
**范围**：Step 1 — 修 Runtime 连接。SSE 接线属 Step 2，未在本步实施。
**依据**：`docs/stage1-step0-architecture-scan.md`（Step 0 扫描）

---

## 1. 修改文件

| # | 文件 | 动作 | 行数变化 |
|---|---|---|---|
| 1 | `.env` | **新建**（已 gitignore，不入库） | +33 |
| 2 | `.env.example` | 修改（补契约文档） | +19 |
| 3 | `scripts/roveagent-service.sh` | 修改（密钥补齐 + 测试模式） | +45 −7 |
| 4 | `src/lib/roveagent/client.ts` | 修改（连接判定修正 + 健康探针） | +66 −4 |
| 5 | `scripts/mock_llm_provider.py` | **新建**（Mock LLM，仅测试） | 258 |
| 6 | `scripts/_probe_roveagent_boot.py` | 上一轮已建（只读探针） | — |
| 7 | `scripts/_probe_gate_wiring.py` | **新建**（只读探针） | 118 |
| 8 | `scripts/_probe_context_propagation{,2,3}.py` | **新建**（只读探针） | 3 个 |

**未修改**：`roveagent/runtime.py`、`roveagent/api/app.py`、任何业务逻辑与 Agent prompt。
（严格遵守你的「禁止修改 runtime.py 大结构」「禁止修改业务 Agent Prompt」。）

---

## 2. 修改原因与 diff

### 2.1 `.env`（新建）

**原因**：Step 0 实测 `.env` 不存在、`scripts/deploy.env` 无任何 `ROVEAGENT_*`，
导致 `roveAgentConfigured() === false`，每个请求静默降级到 TS 路径。

**内容**（密钥以 `python -c "import secrets;print(secrets.token_urlsafe(36))"` 生成）：

```ini
ROVEAGENT_API_URL=http://127.0.0.1:8788
ROVEAGENT_API_KEY=<48 字符随机>
ROVEAGENT_APPROVAL_SECRET=<48 字符随机>
ROVEAGENT_ROOT=./.roveagent
ROVEAGENT_TEST_MODE=true
# ROVEAGENT_LLM_* 留空 —— Step 5 由 Runtime Manager 注入
```

**已验证 gitignore**：

```
$ git check-ignore -v .env
roveframe-src-latest/.gitignore:15:.env	.env
```

### 2.2 `.env.example`

**原因**：原模板缺 `ROVEAGENT_ROOT` / `ROVEAGENT_TEST_MODE` / `ROVEAGENT_LLM_*`，
且未说明「URL 与 KEY 必须同时提供」。补上契约文档。

```diff
 # RoveAgent Core service boundary
+# API_URL + API_KEY 必须【同时】提供；只给其中一个时 roveAgentConfigured() 判定为未配置
 ROVEAGENT_API_URL=https://replace-me.internal
 ROVEAGENT_API_KEY=replace-me-with-a-random-service-key
 ROVEAGENT_APPROVAL_SECRET=replace-me-with-a-separate-random-signing-key
 ROVEFRAME_INTERNAL_API_URL=https://replace-me.internal
+
+ROVEAGENT_ROOT=./.roveagent
+ROVEAGENT_TEST_MODE=false
+# ROVEAGENT_LLM_API_KEY=
+# ROVEAGENT_LLM_BASE_URL=
+# ROVEAGENT_LLM_MODEL=
```

### 2.3 `scripts/roveagent-service.sh`

**原因**：三处缺陷。
① 只读 `ROVEAGENT_API_KEY`，不读 `ROVEAGENT_APPROVAL_SECRET` → 签名端点会落到
API_KEY 回落，与 `app.py:253` 语义虽一致但未显式；② 无测试模式，无密钥时内核虽返回 503
（正确）但无法做链路测试；③ `PYBIN` 在文件末尾才定义。

```diff
 done
+
+# Python 解释器（先解析，后续 Mock Provider 与 uvicorn 都依赖）
+PYBIN="${ROVEAGENT_PYTHON:-python}"
 
 # 从 .env 读取共享密钥（与 Next.js 保持一致），不在脚本里硬编码
 if [[ -z "${ROVEAGENT_API_KEY:-}" && -f .env ]]; then
   ROVEAGENT_API_KEY="$(grep -E '^ROVEAGENT_API_KEY=' .env | head -1 | cut -d= -f2- | tr -d '\r' | tr -d '"')"
 fi
+# 审批签名密钥：优先独立密钥，缺失时回落 API_KEY
+if [[ -z "${ROVEAGENT_APPROVAL_SECRET:-}" && -f .env ]]; then
+  ROVEAGENT_APPROVAL_SECRET="$(grep -E '^ROVEAGENT_APPROVAL_SECRET=' .env | head -1 | cut -d= -f2- | tr -d '\r' | tr -d '"')"
+fi
+# 测试模式标记
+if [[ -z "${ROVEAGENT_TEST_MODE:-}" && -f .env ]]; then
+  ROVEAGENT_TEST_MODE="$(grep -E '^ROVEAGENT_TEST_MODE=' .env | head -1 | cut -d= -f2- | tr -d '\r' | tr -d '"')"
+fi
+
 export ROVEAGENT_API_KEY="${ROVEAGENT_API_KEY:?ROVEAGENT_API_KEY missing (set in .env or environment)}"
+export ROVEAGENT_APPROVAL_SECRET="${ROVEAGENT_APPROVAL_SECRET:-$ROVEAGENT_API_KEY}"
 export ROVEAGENT_ROOT="${ROVEAGENT_ROOT:-$(pwd)/.roveagent}"
 
-# LLM 配置可选：缺失时 /api/agent/chat 返回 503（不伪造回答），其余端点正常
+# 三种情况：生产要求真实 Key；测试模式无 Key 时指向本机 Mock Provider；
+# 测试模式已有真实 Key 时尊重真实 Key。
 export ROVEAGENT_LLM_BASE_URL="${ROVEAGENT_LLM_BASE_URL:-}"
 export ROVEAGENT_LLM_API_KEY="${ROVEAGENT_LLM_API_KEY:-}"
 export ROVEAGENT_LLM_MODEL="${ROVEAGENT_LLM_MODEL:-}"
+
+MOCK_PORT="${ROVEAGENT_MOCK_PORT:-8799}"
+MOCK_PID=""
+
+if [[ "${ROVEAGENT_TEST_MODE:-false}" == "true" ]]; then
+  if [[ -z "$ROVEAGENT_LLM_API_KEY" ]]; then
+    echo "[roveagent] TEST MODE: no real LLM key -> starting Mock LLM Provider on 127.0.0.1:${MOCK_PORT}"
+    ROVEAGENT_MOCK_PORT="$MOCK_PORT" "$PYBIN" -m scripts.mock_llm_provider &
+    MOCK_PID=$!
+    export ROVEAGENT_LLM_BASE_URL="http://127.0.0.1:${MOCK_PORT}/v1"
+    export ROVEAGENT_LLM_API_KEY="mock-test-key"
+    export ROVEAGENT_LLM_MODEL="${ROVEAGENT_LLM_MODEL:-mock-model}"
+    trap '[[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null || true' EXIT INT TERM
+  else
+    echo "[roveagent] TEST MODE: real LLM key present -> using configured provider"
+  fi
+else
+  if [[ -z "$ROVEAGENT_LLM_API_KEY" ]]; then
+    echo "[roveagent] WARNING: ROVEAGENT_LLM_API_KEY not set — /api/agent/chat will return 503 (by design, no fabricated replies)"
+  fi
+fi
```

**生产约束保持不变**：`ROVEAGENT_TEST_MODE != true` 且无 `ROVEAGENT_LLM_API_KEY` 时，
脚本只打印警告，内核照旧在 `app.py:113-116` 抛 `RuntimeError` → `app.py:338-339` 转 **503**。
`ROVEAGENT_TEST_MODE` **不被内核读取**，它只影响脚本是否拉起 Mock Provider ——
因此不存在「用环境变量绕过生产约束」的路径。

### 2.4 `src/lib/roveagent/client.ts`

**原因**：`roveAgentConfigured()` 用 `||`，只给一个变量就判定「已配置」，
必然去打一个注定失败的连接（缺 Key 401 / 缺 URL 打默认本地端口）。

```diff
-export function roveAgentConfigured(): boolean {
-  return Boolean(process.env.ROVEAGENT_API_URL || process.env.ROVEAGENT_API_KEY);
-}
+export function roveAgentConfigured(): boolean {
+  return Boolean(process.env.ROVEAGENT_API_URL && process.env.ROVEAGENT_API_KEY);
+}
+
+/** 已配置的 URL / Key 各缺哪个（用于诊断提示，返回值不含密钥本身）。 */
+export function roveAgentConfigGaps(): string[] { … }
+
+export interface RoveAgentHealth {
+  ok: boolean;
+  status: 'ok' | 'unreachable' | 'unauthorized' | 'error' | 'unconfigured';
+  latencyMs: number | null;
+  detail: string;
+}
+
+/** 探测 Runtime 可达性（GET /api/health）。吞异常，超时默认 2s。 */
+export async function roveAgentHealth(timeoutMs = 2_000): Promise<RoveAgentHealth> { … }
```

`roveAgentHealth()` 是 Step 3 的数据源（`runtime_status`），本步先落地。

### 2.5 `scripts/mock_llm_provider.py`（新建，仅测试）

OpenAI 兼容的流式 Mock，**仅标准库**（`http.server` / `json` / `threading`），
不新增任何依赖、不改 `pyproject.toml`。

行为矩阵（确定性，便于断言）：

| 输入 | 输出 |
|---|---|
| 最后一条 user 含 `read`/`tool` 且**无** tool 结果 | `tool_calls: read_file({path:README.md})` + `finish_reason=tool_calls` |
| 已有 tool 结果 | 逐 6 字符的 `content` delta + `finish_reason=stop` |
| 其他 | 逐 6 字符的 `content` delta + `finish_reason=stop` |

**一个必须记录的设计修正**：初版把 `protocol_version` 设为 `HTTP/1.1` 且声明
keep-alive，但 SSE 流无 `Content-Length` 也未做 chunked 分帧 ——
客户端（httpx / Invoke-WebRequest）会一直等 body 结束直到超时。
**实测复现**：`Invoke-WebRequest` 在 120s 超时失败。
改为 `HTTP/1.0` + `Connection: close`（close-delimited）后正常。

---

## 3. 测试命令与**实际测试结果**

### 3.1 类型检查

```
$ pnpm exec tsc -p tsconfig.json --noEmit
（无输出）
exit=0
```

**结果：通过。**

### 3.2 Mock LLM Provider 单独验证

```
$ python -m scripts.mock_llm_provider
[mock-llm] listening on http://127.0.0.1:8799/v1  model=mock-model

$ curl -s http://127.0.0.1:8799/v1/models
{"object": "list", "data": [{"id": "mock-model", ...}]}
→ HTTP 200
```

**流式（`stream=true`，plain prompt）** —— 逐片 delta，实测输出：

```
data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}
data: {"choices":[{"delta":{"content":"Mock P"},"finish_reason":null}]}
data: {"choices":[{"delta":{"content":"rovide"},"finish_reason":null}]}
data: {"choices":[{"delta":{"content":"r 在线。这"},"finish_reason":null}]}
…
```

**工具调用路径**（prompt 含 `read`）：

```
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1f7a6f09fd89",
       "type":"function","function":{"name":"read_file",
       "arguments":"{\"path\": \"README.md\"}"}}]},"finish_reason":null}]}
data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}
```

**工具结果后终稿**（消息里含 `role:"tool"`）：

```
data: {"choices":[{"delta":{"content":"已读取文件。"},"finish_reason":null}]}
data: {"choices":[{"delta":{"content":"Mock P"},"finish_reason":null}]}
```

**结果：三条路径全部符合预期。**

### 3.3 内核 + Mock 全链路（Step 1 核心）

测试 1 —— `GET /api/health`：

```
$ curl -H "X-RoveAgent-Key: <key>" http://127.0.0.1:8788/api/health
{"status":"ok","service":"roveagent","ts":1789206859.516136,"tenants":0}
→ HTTP 200
```

测试 2 —— `POST /api/agent/chat` 无 Key（鉴权必须生效）：

```
→ HTTP 401  {"detail":"invalid X-RoveAgent-Key"}
```

测试 3 —— `POST /api/agent/chat` 带 Key，`agent=ceo`：

```
→ HTTP 200
{"reply":"Mock Provider 在线。这是用于验证 TS → Python Runtime → SSE 链路的测试回复。",
 "agent":"ceo","tenant_id":"00000000-0000-0000-0000-000000000000",
 "business_id":"00000000-0000-0000-0000-000000000001","session_id":"s1",
 "history_turns":0,"memory_used":0}
```

测试 4 —— `agent=developer`，消息含 `read`（触发工具调用 + 门控）：

```
→ HTTP 200
{"reply":"已读取文件。Mock Provider 链路验证完成：工具调用已通过 EnterpriseToolGate，SSE 事件已回传。",
 "agent":"developer", …}
```

**结果：链路打通 —— TS 契约形状 → Python Runtime → AIAgent 工具循环 → Mock LLM → 200 正常返回。**

### 3.4 门控（EnterpriseToolGate）实测

我核实了门控是否真的被执行（这是 Stage 2 的地基）。

**中间件确实已注册**：

```
$ python -c "... install_enterprise_gate(); get_plugin_manager()._middleware ..."
middleware kinds: ['tool_execution']
  tool_execution -> ['enterprise_gate_middleware']
gate installed: True
```

**门控确实在工具执行时被调用**（探针 v3，先装 gate 再替换 `_resolve_context`）：

```
[probe] enterprise gate installed
[probe] caller thread = 'MainThread'
[probe] _resolve_context invocations: 1
  thread='ThreadPoolExecutor-0_0'   DIFFERENT filled=True agent_id='developer'
[verdict] 不同线程执行，但 context 已正确传递
```

**审计确实落盘**（真实 HTTP 调用产生的门控事件）：

```json
{"tool": "read_sales", "risk": "LOW", "required_permissions": ["orders:read"],
 "approval_policy": "none", "tenant_id": "00000000-…-000000000000",
 "business_id": "00000000-…-000000000001", "user_id": "u1",
 "agent_id": "developer", "request_id": "r-ctx-2", "task_id": "t-ctx-2",
 "allowed": true, "requires_approval": false}
```

**结果：门控链路完整可用（注册 → 调用 → 审计落盘），且 tool context 跨线程正确传递。**

---

## 4. 本步发现的 4 个真实缺陷（未修，需你定优先级）

### 缺陷 A ★ `read_file` 被错配到 `analytics:read` 权限

`EnterpriseToolGate.policy_for()` 实测解析（顺序匹配，先命中先生效）：

```
read_file      -> pattern='read_*'       permission='analytics:read'  risk=LOW     approval=none
write_file     -> pattern='write_file'   permission='files:write'     risk=MEDIUM  approval=manager
patch          -> pattern='patch'        permission='files:write'     risk=MEDIUM  approval=manager
search_files   -> pattern='*'            permission=''               risk=LOW     approval=none
terminal       -> pattern='*'            permission=''               risk=LOW     approval=none
process        -> pattern='*'            permission=''               risk=LOW     approval=none
```

**问题**：`read_file` 命中 `ToolPolicy("read_*", "analytics:read", …)`（`framework.py:112`）。
`analytics:read` 是**业务分析**权限，不是文件读权限。
而 `employees.py` 给 developer 声明的是 `permissions=["files:read", "analytics:read"]` ——
语义上文件读应当是 `files:read`。

**实测后果**（审计原文）：

```json
{"tool": "read_file", "required_permissions": ["analytics:read"],
 "allowed": false, "reason": "permission denied: requires 'analytics:read'"}
```

→ **Developer Agent 读文件会被拒**，除非它同时拿到 `analytics:read`。
这正是 Stage 3「读取项目文件」的第一个拦路石。

### 缺陷 B ★★ `terminal` / `process` 无审批直执（安全缺口）

`terminal` / `process` / `search_files` 全部命中**兜底策略**
`ToolPolicy("*", "", LOW, ApprovalPolicy.NONE)`（`framework.py:115`）。

`framework.py:221` 的 fail-closed 只拦「**未注册** + 兜底」：

```python
if self._is_fallback(policy) and not self._tool_is_registered(tool_name):
```

`terminal` 与 `process` 是**已注册**工具（`terminal_tool.py:4216`、`process_registry.py:3486`），
所以 **已注册 + 兜底 = 放行且不需要审批**。

→ **Stage 4 一旦把 `terminal` 交给 DevOps Agent，它就能无审批执行任意命令。**
必须在开放前补策略行。

### 缺陷 C 门控审计根目录与内核数据根不一致

`gate_hook.py:52` 的默认审计 sink 用的是 **`ROVEAGENT_HOME`**：

```python
root = Path(os.environ.get("ROVEAGENT_HOME", Path.home() / ".roveagent"))
```

而内核数据根用 **`ROVEAGENT_ROOT`**（`app.py:138`）。

**实测**：内核 `ROVEAGENT_ROOT=<repo>/.roveagent`，但门控审计写到了
`C:\Users\24749\.roveagent\audit\tool_gate.jsonl`（46 条历史记录）。

→ 运维排查时「按配置的 ROOT 找审计」会找不到。**审计与数据分家**，
两个变量至少要有明确的优先级与文档。

### 缺陷 D 依赖缺失导致 `/api/agent/chat` 500

首次调用返回 **HTTP 500**，traceback：

```
File "roveagent/core/agent_init.py", line 1079, in init_agent
    from roveagent.logsetup import setup_logging, setup_verbose_logging
File "roveagent/logsetup.py", line 65, in <module>
    from concurrent_log_handler import (
ModuleNotFoundError: No module named 'concurrent_log_handler'
```

`pyproject.toml` 已声明 `concurrent-log-handler==0.9.29; sys_platform == 'win32'`，
但**未安装**。`pip install` 后恢复正常。

→ 建议在 `roveagent-service.sh` 启动前加一个依赖预检，
让这类失败在启动时就暴露，而不是在第一个用户请求上炸。

### 一处**自我更正**

上一轮我基于审计里 `"missing trusted tool context"` 一度判断
「HTTP 入口丢失 tool context，所有工具都会被拒」。
**这个判断是错的。** 探针 v3 证明跨线程传递正常；真实原因是当时的 `permissions`
数组只含 `files:read`，而 `read_sales` 需要 `orders:read` —— **权限不足，不是上下文丢失**。
修正后（`permissions` 含 `orders:read`）门控正常放行，审计中的 tenant/business/user
字段完整。特此留痕。

---

## 5. Step 1 完成标准对照

| # | 你的标准 | 实测结果 |
|---|---|---|
| 1 | `scripts/roveagent-service.sh` 启动成功，`curl /api/health` 返回 200 | **达成**（内核启用，health 200）<br>⚠ 本机 `bash` 是 WSL 且未挂载仓库，故脚本改为等价 Python 命令直启；脚本本身已更新 |
| 2 | 前端请求普通聊天，日志显示 RoveAgent Runtime | **部分达成**：内核侧已确认 200 + Mock 回复；TS 侧路由改动属 Step 3，**未做** |
| 3 | 流式逐 token 显示 | **未达成（属 Step 2）**：Python 侧 Mock 流式已实测正常；`/api/agent/chat/stream` 端点尚未创建 |
| 4 | Runtime 关闭时显示 fallback / unavailable | **未达成（属 Step 3）**：`roveAgentHealth()` 已落地作为数据源；路由分支与前端事件未做 |

**结论：Step 1 的 Runtime 连接部分完成并通过实测；测试 2/3/4 依赖 Step 2/3 的代码，本步未触及。**

---

## 6. 一处需要你注意的执行环境限制

本机 `bash` → `C:\WINDOWS\system32\bash.exe` 是 **WSL**，且未挂载本仓库：

```
WSL (12 - Relay) ERROR: CreateProcessCommon:640: execvpe(/bin/bash) failed: No such file or directory
```

所以 `scripts/roveagent-service.sh` **无法在本机直接执行**。
我改用等价的 PowerShell 环境变量 + `python -m uvicorn` 直启，结果等效。
在 Linux 部署环境或已挂载的 WSL 里，脚本可直接用。

---

## 7. 下一步

Step 1 已交付。按你的顺序，下一步是 **Step 2：SSE 接线**（新增
`POST /api/agent/chat/stream` + `roveAgentChatStream()`，采用已有 callback 接线，
不新建事件系统、不改 `runtime.py`）。

Step 2 的三个设计要点已在 Step 0 报告中确认，可直接开工：

1. **不需要新建流式引擎**：`AIAgent.__init__` 的 `stream_delta_callback` /
   `tool_start_callback` / `tool_complete_callback` / `status_callback` 已具备，
   `api/app.py:119-129` 没传而已。Step 2 = 在 `app.py` 新增流式包装 + 一个路由。
2. **不要 import `gateway.stream_events`**：`gateway/__init__.py` 会拉入
   config/session/delivery → shutdown_watchdog / `core.secret_scope` /
   `clisupport.config` / `whatsapp_identity`。事件构造在 `app.py` 内轻量实现。
3. **事件名必须映射到既有契约**：`use-sse.ts:17` 的 `KNOWN_EVENT_TYPES` 是白名单，
   未知类型被静默丢弃。`token`→`delta`、`tool_call`→`status{calling_tool}`、
   `tool_result`→`status{tool_done}`、`completed`→`done`。

**但缺陷 A 与 B 会影响 Step 2 的验证结果**：
Step 2 要验证「工具事件经 SSE 到达前端」，而 `read_file` 当前会因缺陷 A 被门控拒绝 ——
到时 SSE 会如实推一条 denied 结果，而不是成功。这是**正确行为**（诚实优于伪装），
但需要你先决定是否在 Step 2 之前先补策略行。

请指示：
- **(a)** 先修缺陷 A + B（补策略行，约 6 行），再进 Step 2 —— 我推荐这条
- **(b)** 直接进 Step 2，用 `read_sales`（需 `orders:read`）作为工具事件验证样本
- **(c)** 其他优先级

我不会在未确认前改动门控策略表 —— 那属于安全边界，且会改变 Stage 2 的行为语义。
