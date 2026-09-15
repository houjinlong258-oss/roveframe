# Phase 2b Complete — Developer Agent 真实执行闭环

**日期**：2026-09-12
**自主执行**：未逐项询问；未触碰生产数据、未删模块、未改安全模型、未用生产密钥。
**前置**：`docs/phase2a-availability-aware-toolsets-report.md`

---

## 完成内容

目标（用户最终验收标准 #1「让 Developer Agent 修改真实代码」）**已达成并实测**：
文件被真实创建、`patch` 真实修改内容、每一步都经 `EnterpriseToolGate` 判定。

过程中发现并修复了**三个真实缺陷**，其中两个此前完全不可见。

### 1. ★★ 写路径被「不存在的可选依赖」全面阻断（最关键）

**症状**：`write_file` / `patch` 在 agent 循环里**全部失败**，文件不落盘；
但直接调用 registry handler 却完全成功 —— 极难定位。

**定位过程**（逐步排除）：
- gate 审计显示 `write_file: ok`（放行）→ 不是门控问题
- Mock 生成的参数正确（拿到绝对路径）→ 不是参数问题
- 直接调 registry handler 用**完全相同**的参数 → 文件成功落盘
- 最终从响应正文里拿到决定性证据：

```
⚠️ File-mutation verifier: 1 file(s) were NOT modified this turn
  • ...mock_created.txt — [write_file] Edit approval denied: approval guard failed
```

→ 文件**从未被写入**，是被**拒绝**的。

**根因**：`model_tools.py:1472-1508` 的 ACP/Zed 编辑审批守卫：

```python
try:
    from acp_adapter.edit_approval import maybe_require_edit_approval
    ...
except Exception as _edit_approval_err:
    logger.debug(...)                       # ← 真因被压到 debug
    if function_name in {"write_file", "patch"}:
        return tool_error("Edit approval denied: approval guard failed")   # ← fail-closed 误判
```

`acp_adapter` 是**外部可选模块**（ACP/Zed 集成，本仓不包含）。它的
`ModuleNotFoundError` 被那个宽泛的 `except` 当成「守卫失败」，
于是**在没有装 ACP 适配器的部署里，每一次写文件/打补丁都被 fail-closed 拒绝**。

讽刺的是，紧跟其上的注释（`:1469-1471`）明确写着：

> the requester is bound via ContextVar only for ACP sessions,
> **so CLI/gateway paths are unaffected when it is unset**

即**设计意图就是「非 ACP 会话不受影响」**，实现却把「未安装」也当成了失败。

**修复**：把「模块不存在」与「守卫真的失败」分开：

```python
_edit_guard = None
try:
    from acp_adapter.edit_approval import maybe_require_edit_approval as _edit_guard
except ImportError as _acp_missing:
    logger.debug("ACP edit approval adapter not installed; guard skipped: %s", _acp_missing)

if _edit_guard is not None:
    try:
        ...                                   # 真正的守卫逻辑
    except Exception:
        ...                                   # 仍然 fail-closed（安全语义不变）
```

- 模块**不存在** → 守卫不适用，跳过（符合原设计意图）
- 模块存在但调用/超时失败 → **仍然 fail-closed**（不削弱安全）

**这不是安全模型变更**：ACP 守卫本就只对 ACP 会话生效，而本部署不是 ACP 会话。
真正该管这条路径的是 `EnterpriseToolGate`（未被改动、仍然生效）。

### 2. ★ `_approval` 未绑定（同类缺陷，第二例）

`file_tools.py` 多处使用 `_approval.<name>`（`get_current_session_key` /
`_gateway_notify_cbs` / `_await_gateway_decision` / `prompt_dangerous_approval` /
`_run_approval_gate`），而函数体内的 `import roveagent.tools.approval`
**只绑定顶层包名 `roveagent`**，从不绑定 `_approval`。

**实测症状**：向受审批保护的文件写入时抛
`NameError: name '_approval' is not defined` —— 即「写 SSH 配置需要审批」
这条守卫**实际上是崩的**，不是生效的。

**修复**：新增惰性访问器 `_approval_module()`，替换 7 处 `_approval.` 引用
（`_wt` 同类修法的第二例）。

### 3. 可复用的 Mock LLM 多步执行能力

原 Mock 只会「第一次调用出工具、之后出终稿」，**一轮只能触发一个工具**，
无法验证多步闭环。改造为按「哪些工具已调用过」推进，
支持 `read_file → write_file → patch → terminal → git commit` 序列。

新增 `ROVEAGENT_MOCK_TRACE=1` 与 `ROVEAGENT_GATE_TRACE=1` 两个诊断开关：
- Mock 打印真实发出的工具参数
- 门控打印实际收到的参数

这两个开关是把「工具被放行但副作用没发生」这类问题从**不可见**变为**可定位**的关键。

---

## 修改文件

| # | 文件 | 动作 |
|---|---|---|
| 1 | `roveagent/model_tools.py` | **修复写路径全面阻断**（ACP 守卫：区分「未安装」与「真失败」） |
| 2 | `roveagent/tools/file_tools.py` | 修复 `_approval` 未绑定（+惰性访问器，7 处引用） |
| 3 | `roveagent/enterprise/gate_hook.py` | 新增 `ROVEAGENT_GATE_TRACE` 诊断开关（默认关闭，零开销） |
| 4 | `scripts/mock_llm_provider.py` | 多步执行 + `ROVEAGENT_MOCK_TRACE` |
| 5 | `scripts/_e2e_developer_loop.py` | **新建**：真实闭环 e2e（7 项断言） |

**未修改**：`runtime.py`、`EnterpriseToolGate` 策略表、`PermissionEngine`、
任何 provider 插件。

---

## 架构变化

```
Before（写路径全断）:
  agent loop → EnterpriseToolGate（放行）
             → ACP 守卫 import acp_adapter  → ModuleNotFoundError
             → 被当成「守卫失败」→ fail-closed 拒绝
             → 文件从未写入，但门控审计显示 allowed=True  ← 极难发现

After（修复）:
  agent loop → EnterpriseToolGate（放行，唯一执行门）
             → ACP 守卫：未安装 ⇒ 不适用，跳过
                        （已安装且真失败 ⇒ 仍 fail-closed）
             → write_file / patch 真实执行 → 磁盘真实变化
```

关键性质：**「依赖未安装」不再等同于「安全拒绝」**，而真正的安全门
（`EnterpriseToolGate`）保持不变。

---

## 测试结果

### 端到端真实闭环（7/7 通过）

```
$ python scripts/_e2e_developer_loop.py
[PASS] kernel 启动 — port 8788
[PASS] POST /api/agent/chat — HTTP 200
[PASS] write_file 产生真实文件 — ...\.roveagent\mock-sandbox\mock_created.txt
[PASS] 文件内容正确 — # written by mock LLM
[PASS] patch 真实生效（42 → 43） — # written by mock LLM | value = 43
[PASS] 门控审计记录了闭环工具 — write_file:ok, patch:ok, terminal:blocked, read_file:ok
[PASS] 返回了真实执行结果
[summary] 7/7 checks passed
```

**磁盘实证**：

```
file exists: True
content: # written by mock LLM | value = 43 |
```

即：`write_file` 创建了文件，`patch` 把它从 `value = 42` 改成 `value = 43`。

### 门控行为（实测，安全语义正确）

| 工具 | 角色 | 结果 |
|---|---|---|
| `read_file` | owner / manager / staff | **allowed**（LOW，免审批） |
| `write_file` / `patch` | owner | allowed（`_role_gate` 既有语义） |
| `write_file` / `patch` | manager / staff | **requires_approval=True**（不执行） |
| `terminal` | （仅 `files:*` 权限） | **blocked** — `permission denied: requires 'admin:process'` |

`terminal` 被拦是 Step 1.5 策略正确生效的证明（高风险工具需 `admin:process`）。

### 回归

```
$ python -m pytest roveagent/api roveagent/tools/permissions_policy_test.py -q
97 passed, 160 subtests passed in 28.39s

$ pnpm exec tsc -p tsconfig.json --noEmit
exit 0
```

---

## 当前剩余风险

| # | 风险 | 状态 | 处置 |
|---|---|---|---|
| ~~R1~~ | 组合 toolset 可用性门控 | Phase 2a 已修 | — |
| ~~R11~~ | 写路径被 ACP 守卫全面阻断 | **本阶段已修** | — |
| ~~R12~~ | `file_tools._approval` 未绑定 | **本阶段已修** | — |
| **R13** | **「依赖未安装 = 安全拒绝」是系统性反模式** | 新发现 | 本阶段修了 ACP 一处，但同类模式可能存在于其它可选依赖守卫。建议全仓排查 `except Exception` + fail-closed 组合 |
| **R14** | **真因被 `logger.debug` 压掉** | 新发现 | `model_tools.py:1492` 把守卫异常记为 debug，导致排查极难。建议此类安全相关失败至少 `logger.warning` |
| R2/R3 | `video_generate` / `tts` / `vision` 缺凭据 | 未变 | 配置后复测 |
| R4 | `social` 无内置发布工具 | 未变 | Phase 5 |
| R6 | `image_generate` 未经真实上游验证 | 未变 | 接入 provider 后复测 |
| R7 | DB 迁移未应用 | 未变 | 在有凭据环境执行 |
| R8 | TS→浏览器仍未经运行时验证 | 未变 | 提供 `.env` |
| R9 | 仓库既有失败测试 | 未变 | 建议清理 |

**R14 值得强调**：本次排查耗时长的直接原因就是真因被压在 `debug` 级别。
一个「所有写操作都失败」的严重故障，在默认日志级别下**没有任何可见线索**。

---

## 下一步（Phase 2c）

Phase 2b 已证明 Developer Agent 的写路径真实可用。Phase 2c 将覆盖
DevOps Agent：

1. 只读巡检（`terminal` 只读命令：服务状态、日志、进程、容器）
2. 生产变更**必须审批**（Step 1.5 已把 `terminal` 设为 `HIGH + MANAGER`，
   且需 `admin:process` 权限点）
3. 验证「无审批时生产命令被拦」与「审批后放行」两条路径

之后进入 Phase 3（Plugin Center + 沙箱隔离）、Phase 4（Media Hub + 中文 PDF）、
Phase 5（Social 单平台闭环）。

将继续自主推进。
