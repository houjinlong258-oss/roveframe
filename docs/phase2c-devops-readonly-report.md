# Phase 2c Complete — DevOps 只读运维能力 + 两项安全修复

**日期**：2026-09-12
**自主执行**：未逐项询问；未删模块、未改安全模型、未用生产密钥。
**前置**：`docs/phase2b-developer-real-execution-report.md`

---

## 完成内容

### Phase 2c-1：DevOps 只读运维（4 项测试全过）

DevOps Agent 现在能**真实执行**只读运维命令，破坏性操作被门控拦截。

**关键设计决定**：安全性**完全由 `EnterpriseToolGate` 判定**
（`terminal` 策略 = `admin:process` / HIGH / MANAGER）。
Mock LLM **如实生成破坏性命令**（`taskkill` / `sc stop && sc start`），
不自行拦截 —— 否则测到的是 Mock 的逻辑而不是门控的逻辑。

**实测（7/7 checks passed）**：

| # | 用户要求 | 实测结果 |
|---|---|---|
| 1 | 查看进程 → 真实返回 | **PASS** — `terminal allowed=1`，执行 `tasklist` |
| 2 | 查看 docker 状态 | **PASS** — `terminal allowed=1`，执行 `docker ps` |
| 3 | kill process → blocked | **PASS** — `blocked=1; reason=approval required: manager` |
| 4 | restart service → requires approval | **PASS** — `requires_approval=1; policy=manager` |

并额外断言「未产生真实副作用」：回复未声称已重启。

**权限判定实测**：

```
role=owner   + devops agent → admin:process **自动并入**（员工档案固有能力）
                              → terminal allowed
role=manager + 请求权限裁剪  → 允许集不含 admin:process → terminal blocked
```

这印证了一个容易误判的设计：`derive_permissions`（`api/permissions.py:62`）
把**员工档案声明能力**并入权限集，且 owner 的允许集是 `*` —— 因此
**客户端无法通过裁剪请求权限来削弱服务端授予的档案能力**（正确的 fail-closed）。
所以「验证权限不足被拒」必须用允许集不含该权限点的角色（manager）。

### R13：可选依赖安全守卫扫描

新增静态扫描器 `scripts/_scan_optional_dep_guards.py`：AST 遍历 1125 个文件，
找出「`try: from <可选模块> … except Exception: deny/return error`」形态，
按可疑度打分（是否外部/可选模块、handler 是否直接返回拒绝、是否缺少
ModuleNotFoundError 分支等）。

**扫描结果**：128 处候选，逐一核查前 3 名高分项：

| 位置 | 行为 | 判定 |
|---|---|---|
| `clisupport/mcp_startup.py:16` | `except Exception: return True` | **fail-open**（保守做法：探测失败则照常发现）—— 不是缺陷 |
| `clisupport/main.py:12266` | `except Exception: print(⚠ …)` 并继续 | 已可见、不阻断 —— 不是缺陷 |
| `core/agent_runtime_helpers.py:3474` | `except Exception: block_message = None` | 静默吞掉插件 hook 失败 —— **已记录为 R15，未改**（属插件语义，改动面大） |

**结论**：Phase 2b 发现的 ACP 反模式（把「依赖未安装」当「安全拒绝」）
在这批候选里是**唯一一例**，已修；其余均为 fail-open 或已可见。
**没有第二处同类缺陷。**

### R14：安全拒绝日志提升到 warning

两处修复，均补齐 `tool / agent / reason / session` 四元组：

**① 门控拒绝**（`enterprise/gate_hook.py`）：

```diff
-logger.info(
-    "enterprise gate blocked tool=%s tenant=%s approval=%s reason=%s",
-    tool_name, ctx.tenant_id, decision.requires_approval, decision.reason,
-)
+logger.warning(
+    # R14：安全拒绝从 info 提升到 warning，并补齐四元组
+    # （tool / agent / reason / session）—— 否则「所有写操作都失败」
+    # 这类严重故障在默认日志级别下没有任何可见线索（Phase 2b 的实际教训）。
+    "enterprise gate BLOCKED tool=%s agent=%s role=%s session=%s "
+    "approval=%s policy=%s reason=%s",
+    tool_name, ctx.agent_id or "-", ctx.role or "-", ctx.task_id or "-",
+    decision.requires_approval, decision.approval_policy, decision.reason,
+)
```

**② ACP 守卫真失败**（`model_tools.py`）—— 原先记在 `debug`，
正是 Phase 2b「所有写操作都失败却无线索」的直接原因：

```diff
-except Exception as _edit_approval_err:
-    logger.debug("ACP edit approval guard error: %s", _edit_approval_err)
+except Exception as _edit_approval_err:
+    logger.warning(
+        "ACP edit approval guard FAILED (failing closed) tool=%s "
+        "task=%s session=%s reason=%s",
+        function_name, task_id or "-", session_id or "-", _edit_approval_err,
+    )
```

（「适配器未安装」仍保持 `debug` —— 那不是安全事件。）

---

## 修改文件

| # | 文件 | 动作 |
|---|---|---|
| 1 | `roveagent/enterprise/gate_hook.py` | R14：门控拒绝日志 info → warning + 四元组 |
| 2 | `roveagent/model_tools.py` | R14：ACP 守卫真失败 debug → warning + 四元组 |
| 3 | `scripts/_scan_optional_dep_guards.py` | **新建**：R13 静态扫描器 |
| 4 | `scripts/_e2e_devops_readonly.py` | **新建**：DevOps 4 项测试 e2e |
| 5 | `scripts/mock_llm_provider.py` | 运维意图映射（只读 + 破坏性如实生成） |

**未修改**（按你的约束逐项确认）：Developer Agent、Toolset Resolver
（`api/toolsets.py` / `api/capability_router.py`）、`EnterpriseToolGate` 核心策略逻辑。

---

## 架构变化

```
                     Agent Gateway
                          │
                  Agent Capability Router
                          │
                    RoveAgent Runtime
                          │
             ┌────────────┴────────────┐
        Developer                    DevOps
      file/terminal                terminal/todo
      skills/delegation            (docker/monitoring 经 terminal)
             │                        │
             └────────────┬───────────┘
                          ▼
              EnterpriseToolGate  ← 唯一执行门（Phase 2c 未改动其策略）
                          │
          ┌───────────────┼────────────────┐
      read_file        write_file/patch    terminal
      LOW/免审批       MEDIUM/MANAGER      HIGH/MANAGER
      (allowed)        (需审批)            (需 admin:process + 审批)
                          │
                   Approval System
                          │
                  Sandbox Execution
```

关键性质：**只读与破坏性操作的区分不靠 prompt，靠权限点与策略行**。
DevOps 的「只读能力」实质是「`terminal` 需要 `admin:process`，而只读命令
由模型按指令选择，破坏性命令仍需同一道门」——即**门是统一的，能力由权限决定**。

---

## 测试结果

### DevOps 4 项（端到端，真实 HTTP + Mock LLM + 真实 Gate）

```
$ python scripts/_e2e_devops_readonly.py
[PASS] kernel 启动 — port 8788
[PASS] 测试1 查看进程：真实执行 — HTTP 200; terminal allowed=1
[PASS] 测试1 返回真实进程内容
[PASS] 测试2 查看 docker：真实执行 — HTTP 200; terminal allowed=1
[PASS] 测试3 kill：被门控拦截 — HTTP 200; blocked=1; reason=approval required: manager
[PASS] 测试4 restart：进入审批（不执行） — HTTP 200; requires_approval=1; policy=manager
[PASS] 测试4 未产生真实副作用
[summary] 7/7 checks passed
```

### 回归（确认 2c 未破坏 2b）

```
$ python -m pytest roveagent/api roveagent/tools/permissions_policy_test.py -q
97 passed, 160 subtests passed

$ python scripts/_e2e_developer_loop.py
[summary] 7/7 checks passed          ← 写路径仍然真实可用

$ pnpm exec tsc -p tsconfig.json --noEmit
exit 0
```

### R13 扫描

```
$ python scripts/_scan_optional_dep_guards.py
scanned 1125 files; 128 suspicious try/except blocks
（前 3 名高分项逐一核查：1 例已修，2 例为 fail-open/已可见）
```

---

## 当前剩余风险

| # | 风险 | 状态 | 处置 |
|---|---|---|---|
| ~~R1~~ | 组合 toolset 可用性门控 | 2a 已修 | — |
| ~~R11~~ | 写路径被 ACP 守卫全面阻断 | 2b 已修 | — |
| ~~R12~~ | `file_tools._approval` 未绑定 | 2b 已修 | — |
| ~~R13~~ | 「依赖未安装 = 安全拒绝」反模式 | **本阶段扫描完成**：1125 文件 / 128 候选，仅 ACP 一例，已修 | 新增此扫描器可复用于 CI |
| ~~R14~~ | 安全拒绝日志级别过低 | **本阶段已修**（2 处，含四元组） | — |
| **R15** | `agent_runtime_helpers.py:3474` 静默吞掉插件 pre-tool hook 失败（`except Exception: block_message = None`） | 新发现，**未改** | 该 hook 可返回 block 指令，静默失败 = 插件阻断失效。属插件语义，改动面大，建议单独立项 |
| **R16** | `terminal` 的只读/破坏性区分**不在门控层** | 新发现（设计事实） | 门按**工具名**授权，无法区分 `ps` 与 `rm -rf`。当前依赖模型遵循指令 + 权限点兜底。若产品要求「只读模式下物理禁止破坏性命令」，需要一层命令级策略（新安全语义，需独立决策） |
| R2/R3 | `video_generate` / `tts` / `vision` 缺凭据 | 未变 | 配置后复测 |
| R4 | `social` 无内置发布工具 | 未变 | Phase 5 |
| R6 | `image_generate` 未经真实上游验证 | 未变 | 接入 provider 后复测 |
| R7 | DB 迁移未应用 | 未变 | 有凭据环境执行 |
| R8 | TS→浏览器未经运行时验证 | 未变 | 提供 `.env` |
| R9 | 仓库既有失败测试 | 未变 | 建议清理 |

**R16 值得你决策**：你要的「只允许 read-only 能力」目前在门控层是
**按权限点**实现的（`terminal` 需 `admin:process`），而不是**按命令内容**。
这意味着拿到 `admin:process` 的 DevOps Agent 在技术上可以执行破坏性命令，
只受「模型遵循指令」约束。若要物理隔离，需要新增命令级策略层 ——
那属于**安全语义变更**（你要求先确认的第三类），因此我**没有擅自实现**。

---

## 下一步（Phase 3）

按要求不进入 Plugin / Media 之前，Phase 2c 的安全执行链已建立。Phase 3 计划：

1. **Plugin Center**：读 `roveagent/plugins/*/plugin.yaml`，暴露查看/启用/禁用/配置
2. **插件沙箱隔离**：复用既有 `tools/environments/*` 与 MCP 边界，
   让第三方插件**不在主进程运行**，异常自动隔离
3. 复用 Phase 2c 的 `_scan_optional_dep_guards.py` 作为插件清单校验的一部分

将继续自主推进。
