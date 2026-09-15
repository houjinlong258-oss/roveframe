# RoveFrame Phase 9 Production Closure — Completion Report

执行范围：Tool Policy Closure / Approval Contract / E2E 测试层 / 性能测量 / Skill 收敛 / 部署清单
验证基线（全部为本次实测输出）：

| 检查 | Phase 9 前 | Phase 9 后 |
|---|---|---|
| `pnpm ts-check` | PASS | **PASS** |
| `pnpm test` | 615 / 615 | **621 / 621 / 0 fail** |
| `python -B -m unittest discover …` | 765 / 765 | **777 / 777** |
| 命中兜底策略的已注册工具 | **82 / 101** | **0 / 101** |

---

# Task 1 — Tool Policy Closure ✅ 完成

## 1. 修改文件

| 文件 | 变更 |
|---|---|
| `roveagent/tools/framework.py` | `DEFAULT_POLICIES` 新增 88 条显式策略行；兜底行由 `LOW/NONE/""` 改为 `HIGH/ADMIN`；新增 `decide_approval()`；`check_approval()` 委托给它；`write_file` / `patch` 由 `MEDIUM` 升为 `HIGH` |
| `roveagent/tools/framework.py` (`authorize`) | 兜底分支由「仅拒绝未注册工具」改为「命中兜底即拒绝」，无论是否已注册 |
| `docs/production-audit/tool_policy_inventory.md` | **新增** —— 101 个工具的实测清单（tool / source / risk / permission / approval / policy） |
| `roveagent/enterprise/gate_fail_closed_test.py` | 2 个用例改写为新契约 |
| `roveagent/tools/permissions_policy_test.py` | `test_2_write_file_unchanged` → `test_2_write_file_risk_raised_to_high`；`test_5c_owner_bypasses_manager_level_via_role_rank` → `test_5c_high_risk_actions_never_auto_skip_approval` + 新增 `test_5c2_medium_risk_keeps_senior_role_exemption` |
| `roveagent/api/toolsets_test.py` | `test_4_write_file_still_requires_manager` → 断言 HIGH |
| `roveagent/api/plugin_trust_test.py` | `test_without_the_pack_the_tool_lands_on_the_catch_all` 改写为断言 default-deny |

## 2. 生产调用链变化

**是，且是本阶段最重要的变化。**

改造前的实测数据（用生产发现入口 `roveagent.model_tools` 枚举，非静态推测）：

```
REGISTERED_TOTAL 101
FALLBACK_ONLY_COUNT 82
```

即 **101 个已注册工具中有 82 个只能命中兜底行**，而兜底行当时是 `permission="" + approval=NONE + risk=LOW`。`authorize()` 只在「命中兜底 **且** 未注册」时拒绝，因此这 82 个「已注册但无策略行」的工具全部**免权限、免审批直执**。其中包含：

`execute_code`（任意代码执行）、`computer_use`（桌面控制）、`browser_exec`、`browser_cdp`（浏览器代码执行 / DevTools 协议）、`setup_mcp`（装配 MCP 服务器）、`skill_manage`、`delegate_task`、`cronjob`、`discord` / `discord_admin`、`ha_call_service`、`yb_send_dm`、`image_generate` / `video_generate` / `xai_video_extend`（外部有成本）等。

改造后：

```
REGISTERED_TOTAL 101
FALLBACK_ONLY_COUNT 0
EXPLICIT_PATTERNS 99
```

**且未导致任何工具失效** —— 这正是任务约束「禁止直接修改默认 deny 而导致大量工具失效」。做法是先为全部 82 个工具补齐显式策略行，再翻转兜底语义：

- 权限保持 `""`（有意为之）：这些工具当前以空权限运行，赋一个调用方并不持有的新权限会造成**静默锁死**（manager/staff 立即失去今日可用的工具）。本阶段收紧的是**审批与风险**，权限收敛留待角色权限模型统一后再做。
- 风险/审批按类别逐条判定：代码执行类 `CRITICAL`，对外通信与外部有成本类 `HIGH`，浏览器交互与看板写操作 `MEDIUM`，检索与视图类 `LOW`。

## 3. 测试证据

```
$ python -B -m unittest discover -s roveagent -t . -p "*_test.py"
Ran 777 tests in 85.843s
OK
```

关键用例：

| 用例 | 断言 |
|---|---|
| `gate_fail_closed_test::test_unknown_tool_is_denied` | 未注册工具 → `not registered` |
| `gate_fail_closed_test::test_registered_tool_without_explicit_policy_is_denied` | **已注册但无策略行 → `no explicit policy row`**（本阶段新增的契约） |
| `permissions_policy_test::test_5c_high_risk_actions_never_auto_skip_approval` | owner 调用 `terminal`（HIGH）→ 不再免审直执 |
| `permissions_policy_test::test_5c2_medium_risk_keeps_senior_role_exemption` | `image_generate`（MEDIUM）→ owner 仍可免审（收紧范围未扩大） |
| `plugin_trust_test::test_without_the_pack_the_tool_lands_on_the_catch_all` | 无策略包的插件工具 → 落在可识别的兜底行上，`authorize` 据此拒绝 |

**同时验证了「不破坏已有工具」**：`read_*` / `send_*` / `terminal` / `process` / `deploy_*` / `refund_*` 等原有显式策略行的行为全部保持不变（相关用例未改动或只改断言数值）。

## 4. 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 新增工具默认不可用 | 这是刻意行为（fail-closed）。开发者注册工具后若忘记补策略行，该工具会静默不可用 | `authorize()` 的拒绝原因明确写 `no explicit policy row (default deny)`，且审计留痕；`tool_policy_inventory.md` 给出补行范式 |
| `write_file` 升为 HIGH | owner 现在改文件会产生审批单，日常流程变慢 | 这是任务要求（HIGH/CRITICAL 不得自动跳过）。若产品认为文件写入不应要求第二方确认，应显式下调该行并记录决策 |
| 空权限的 82 行 | 权限层仍未收敛，这些工具对任何已认证角色都可通过权限检查 | 已在本报告与清单中显式标注；后续权限模型统一时需逐行补 permission |
| 兜底行 risk=HIGH | 兜底行本身不再被授权路径使用，仅作为 `_is_fallback()` 标记 | 无实际影响 |

## 5. 是否可以上线

**可以，且这是本阶段安全收益最大的一项。** 但需注意：`terminal` / `write_file` / `send_*` 对 owner 产生审批单是**行为变更**，上线前需与产品确认 owner 的日常操作是否接受额外的审批步骤。若不可接受，应在 `DEFAULT_POLICIES` 中对该行显式降级并留下决策记录 —— **不要**恢复兜底放行。

---

# Task 2 — Approval Contract 统一 ✅ 完成

## 1. 修改文件

| 文件 | 变更 |
|---|---|
| `tests/fixtures/approval_decision_contract.json` | **新增** —— 跨语言共享契约样例集：15 个 `decide` 用例 + 6 个 `can_approve` 用例 + 规则说明 + 角色阶梯 |
| `src/lib/agent/approvals.ts` | 新增 `ApprovalActor`、`ApprovalDecision`、`decideApproval()`；`canApprove()` 参数放宽为 `ApprovalActor` |
| `roveagent/tools/framework.py` | 新增 `EnterpriseToolGate.decide_approval()`（与 TS 同契约）；`check_approval()` 委托给它 |
| `tests/approval-contract.test.ts` | **新增** —— TS 侧契约测试（6 用例） |
| `roveagent/tools/approval_contract_test.py` | **新增** —— Python 侧契约测试（5 用例） |

## 2. 生产调用链变化

**是。** 改造前两侧语义分叉：

| | 改造前 | 改造后 |
|---|---|---|
| Python gate | `rank >= required + 1`，**完全不看 risk** | `decide_approval()`，含 risk 维度 |
| TS approvals | `rank >= required`，对 `admin` 恒 false | 同上，同一份规则 |
| 同一个 (role, required_role) 结论 | **可能相反** | **必然一致** |

统一后的规则（按顺序判定）：

```
1. required_role == null        → approval_required = false
2. risk ∈ {high, critical}      → approval_required = true（任何角色都不得自动跳过）
3. required_role == 'admin'     → approval_required = true（平台控制面动作，商户域无人可批）
4. 其余（medium / low）          → approval_required = rank(role) < rank(required_role) + 1
```

规范形状 `{ role, required_role, risk, approval_required, reason }` 是两侧交换数据的唯一结构。

## 3. 测试证据

```
$ node --test tests/approval-contract.test.ts
✔ Approval Decision cross-language contract
ℹ tests 6  ℹ pass 6  ℹ fail 0

$ python -B -m unittest roveagent.tools.approval_contract_test
Ran 5 tests — OK

$ pnpm test          → 621 / 621 pass
$ python … unittest  → 777 / 777 OK
```

两侧读取**同一个** JSON 文件。任一侧语义漂移都会让两侧测试同时变红 —— 这是该契约存在的唯一理由。

额外锁定两条不变量：
- `HIGH`/`CRITICAL` × 全部 4 个角色 → 全部 `approval_required = true`
- `MEDIUM`/`LOW` → owner 仍可免审、manager 必须审批（**收紧范围未被扩大**）

## 4. 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 契约文件成为双方强耦合点 | 修改样例集必须两侧同时理解 | 这是目的而非缺陷；样例集带有 `rule` 与 `rank` 字段自描述 |
| `canApprove` 参数放宽到含 `admin` | 类型放宽可能让误传 admin 的代码通过编译 | `canApprove` 对 `requiredRole === 'admin'` 恒 false，且契约用例锁定该行为 |
| `reason` 文案被 UI 依赖 | 文案属契约的一部分 | 样例集断言的是 `approval_required` 布尔值；文案仅作可读性，UI 不应解析 |

## 5. 是否可以上线

**可以。** 这是纯语义统一 + 契约加固，无行为回归；且它使 Task 1 的收紧在两侧同时成立。

---

# Task 3 — 真实 E2E 测试层 ✅ 完成

## 1. 修改文件

| 文件 | 变更 |
|---|---|
| `roveagent/enterprise/production_chain_e2e_test.py` | **新增** —— 6 个用例覆盖 5 个必需场景 |

## 2. 生产调用链变化

**无生产代码变更** —— 本任务的产物是**对真实链路的可执行证明**，不是新功能。

链路：`API → Tool → EnterpriseToolGate → 执行 → 审计`

真实组件（非 mock）：

- 真实 `EnterpriseToolGate`（含 `DEFAULT_POLICIES` 与 Phase 9 的 default-deny）
- 真实 `install_enterprise_gate` 中间件装配（`fail_closed` 标记生效）
- 真实 `run_tool_execution_middleware` 执行链
- 真实 FastAPI app（`create_app()`）+ 真实 HMAC 签名回调 `/api/agent/tool/resolve`
- 真实审计 sink（断言每条决策都留痕，**含拒绝**）

唯一替身是**被执行的工具处理器**：`read_file` / `write_file` 需要终端后端，离线环境不可用，故用同名探针 handler 代替。**被测对象是门控与审批契约，不是文件系统本身** —— 这一点在每个用例的 docstring 中显式标注。

## 3. 测试证据

```
$ python -B -m unittest roveagent.enterprise.production_chain_e2e_test
Ran 6 tests in 3.218s
OK
```

| 场景 | 用例 | 关键断言 |
|---|---|---|
| 1. developer `read_file` | `test_1_developer_read_file_is_allowed_and_audited` | 放行、执行一次、审计 `allowed=True` |
| 2. developer `write_file` 审批 | `test_2_developer_write_file_requires_approval_and_does_not_execute` | 策略 risk == HIGH；权限齐备的 owner 也进入审批；**未批准时处理器零调用** |
| 3. plugin tool sandbox | `test_3_plugin_tool_without_policy_pack_is_denied` | 未注册 → `not registered`；已注册无策略行 → `no explicit policy row`；有策略包 → 独立策略行 |
| 4. approval reject | `test_5_rejection_executes_nothing` | 拒绝路径零执行 |
| 5. approval accept | `test_5b_acceptance_executes_exactly_once` | 首次 200；**重复回调不产生第二次执行** |
| 附加 | `test_4_callback_without_distinct_approval_secret_is_rejected` | 审批密钥 == 调用密钥 → **503**（Task A4 契约的 E2E 验证） |

## 4. 风险

| 风险 | 说明 |
|---|---|
| 导入 `create_app()` 会触发 auxiliary provider 解析，实测出现 `PAID lane engaged … may incur real spend` 与对 OpenRouter / Nous 的网络尝试 | **这是既有行为**（`recovery_campaign_test.py` 同样触发），非本阶段引入。但测试环境不应产生真实花费 —— 建议后续在测试 setup 中显式关闭 auxiliary 通道 |
| 场景 1/2 的执行处理器是探针 | 已在 docstring 标注；真实文件工具的执行仍未被 E2E 覆盖 |
| 用例 `test_5_rejection_executes_nothing` 接受 200/409/422/500 多种状态码 | 放宽是因为拒绝路径的错误码取决于 grant 状态；核心断言是「零执行」 |

## 5. 是否可以上线

**可以。** 该测试层现在能在离线环境证明「门控 → 执行 → 审计」链路真实成立，且能捕获本阶段这类「策略表与注册表脱节」的缺陷。

---

# Task 4 — Agent 性能优化 ⚠️ 部分完成（诚实登记）

## 状态

| 项 | 状态 |
|---|---|
| Timing Trace 埋点（classification / planner / memory / retrieval / LLM / tool） | ❌ **未交付** |
| `agent_latency_report` | ❌ **未交付** |
| 「简单请求跳过 planner」 | ✅ 已在上一阶段实现（`gateway.ts` 的 `skipPlanning` + `chat/route.ts` 的分流接线，开关 `RF_AGENT_FAST_PATH`） |
| 「memory 异步」 | ✅ 已在上一阶段实现（`extractAndStoreMemory` 移入 `onSettled`） |
| 「tool schema 压缩」 | ❌ 未做 |

## 必须指出的问题

任务规则写明「**禁止：没有 benchmark 直接优化**」。而上述两项已实现的优化，恰恰是**在没有 benchmark 的情况下**做的 —— 它们的收益目前只有结构性论证（LLM 调用次数 2→1、`done` 不再被额外一次 LLM 往返阻塞），**没有任何实测数字**。

因此本任务不能标记为完成，且已实现的两项应被视为「**待基准验证**」，而不是「已优化」。

## Timing Trace 设计（可直接实现，约 1 人日）

在 `src/app/api/agent/chat/route.ts` 的 `runChat` 内引入一个请求级计时器，记录以下阶段的耗时（毫秒）：

| 阶段 | 埋点位置 | 用途 |
|---|---|---|
| `pre_llm_db_ms` | 从进入 `runChat` 到首次发起 LLM 请求 | 分离数据库成本与模型成本 |
| `classification_ms` | 包裹 `classifyRequest()` | 预期 ≈0，用于证明它不构成瓶颈 |
| `planner_ms` | 包裹 `invokeToolDecision()`（经 `runAgentTurn`） | **验证「planner 非流式整段生成」这一主因** |
| `synthesis_ms` | 包裹 `streamChatWithFailover()` | 与 planner 路径对比 |
| `tool_ms` | 在 `AgentToolRegistry.execute` 的审计回调中累加 | 工具占比 |
| `retrieval_ms` | `/api/knowledge/ask` 的向量检索段 | RAG 路径 |
| `memory_ms` | `extractAndStoreMemory()`（已在 `onSettled`） | 证明它不再阻塞 `done` |
| `post_answer_ms` | 最后一个 `delta` 到 `done` | 验证 Task P3 的收益（目标 < 50ms） |
| `llm_calls_per_turn` | 计数器，每次 provider 请求 +1 | 目标 简单对话 = 1 |
| `prompt_chars` | 请求组装完成时 | 验证 context 膨胀 |

**输出方式（不破坏 9 事件契约）**：不改 SSE 事件类型。写入两处：
1. 结构化日志行 `console.info('[agent/timing] ' + JSON.stringify(trace))`
2. `chat_sessions.runtime_*` 同族的元数据列（需一条迁移，或复用现有 jsonb 列）

`ai_usage_ledger` 已有 `latencyMs` 与 `correlationId`（`router.ts`），因此**每 provider 调用的延迟已存在**，缺的只是「一次 turn 内的阶段拆分」。

## 基准方法

`scripts/agent-latency.mjs`（建议新增，约 0.5 人日）：对运行中的栈发 N=30 次请求，分别用简单短句与工具类长句，收集上述 trace，输出 `agent_latency_report.md`（P50/P90 各阶段耗时 + LLM 调用次数分布）。

**前置条件**：需要运行中的 TS + Python 双平面（D-3 / D-5），因此**该基准无法在离线环境完成**，属暂缓项。

## 是否可以上线

**性能优化本身不阻塞上线**（功能正确性不受影响）。但本任务按规则应标记为**未完成**：无 benchmark 即无「优化」的证明。

---

# Task 5 — Skill 系统收敛：Migration Plan 📋 交付计划（未执行删除）

按任务要求「不要删除，先分析并输出 migration plan」，以下为分析结论与迁移方案。

## 现状（实测）

| # | 位置 | 构成 | 行数 | 生产可达 |
|---|---|---|---|---|
| 1 | `roveagent/skills/` | `packs.py`(68) + `marketplace.py`(104) + `packs/*.json`(4 行业) + `packs/knowledge/*.md`(12) | 174 | ✅ `app.py:848,864`（catalog/install）；`kernel.py:29`（品种包） |
| 2 | `roveagent/skills_library/` | 65 py + **261 md** + `index-cache/lobehub_index.json`(251 KB) | 内容库 | 仅被 #1 的 `_SKILLS_LIBRARY` glob 读取 |
| 3 | `roveagent/skills_market/` | installer(386) manifest(243) permissions(194) registry(196) sandbox(197) scanner(356) versions(255) + test(773) | **2,441** | ❌ **零 HTTP / 内核引用** |
| 4 | `src/lib/skills.ts` | `INDUSTRY_SKILLS` 5 条硬编码字符串 | 11 | ✅ 注入 `chat/route.ts` 系统提示词 |

**关键事实**：HTTP 端点用的是 **#1 的 104 行简化版**（`from ..skills.marketplace import catalog/install`），而不是 **#3 的 2,441 行完整版**。后者含 `sandbox.py` / `scanner.py` / `permissions.py` / `versions.py` —— 即安全加固最充分的实现 —— 却从未被调用。

附带分裂：
- **5 个** skills 目录解析器：`constants.py:1667 get_skills_dir()`、`:338 get_optional_skills_dir()`、`:368 get_bundled_skills_dir()`、`tools/skills_tool.py SKILLS_DIR`、`core/skill_utils.py get_external_skills_dirs()/get_project_skills_dirs()`
- **行业枚举分叉**：#1 的 `packs/*.json` = {healthcare, hotel, restaurant, retail}；#4 的 `INDUSTRY_SKILLS` = {restaurant, fastfood, cafe, retail, service}

## 目标体系：Skill Bundle

```
Skill Bundle
├── manifest        name / version / description / industry / source
├── capabilities    该 bundle 向 Capability Registry 发布的工具名
├── permissions     所需 permission（与 ROLE_PERMISSIONS 同一套词汇）
└── sandbox         隔离要求（none | subprocess | container）
```

与既有架构的对应关系（**不新建体系**）：

| Bundle 字段 | 现有实现 |
|---|---|
| manifest | `skills_market/manifest.py`（243 行，已实现） |
| capabilities | `api/capability_providers.py` 的 `SkillCapabilityProvider`（已存在） |
| permissions | `skills_market/permissions.py`（194 行） |
| sandbox | `skills_market/sandbox.py`（197 行） + `api/plugin_isolation.py` |

即：**Skill Bundle 不是新东西，而是把 `skills_market/` 已有的四个模块接到 `skills/marketplace.py` 的调用点上。** 这正是「不创建新架构、不新增平行模块」的做法。

## 迁移步骤

| 步 | 动作 | 前置证据 | 工作量 |
|---|---|---|---|
| S1 | 在 `app.py` 的 `/api/agent/skills/market` 与 `/api/agent/skills/install` 中，把 `..skills.marketplace` 换成 `skills_market.registry` + `installer`，保留 `catalog()` 作为 fallback 一个发布周期 | 已有：两个端点的 import 行 | 1 人日 |
| S2 | 为 `skills_market` 增加 `/api/skills/bundles` 只读端点（manifest + capabilities + permissions + sandbox），供 UI 消费 | `skills_market/registry.py:196` | 1 人日 |
| S3 | `skills_market/scanner.py`（356 行）接入安装路径 —— 当前安装无任何代码扫描 | 该文件已存在且已测试（773 行测试） | 0.5 人日 |
| S4 | 删除 `skills/marketplace.py` 的 `install()`（保留 `catalog()` 作为只读聚合） | S1 完成后 `install` 无调用方 | 0.5 人日 |
| S5 | `src/lib/skills.ts` 的 `INDUSTRY_SKILLS` 改为从 `skills/packs/*.json` 派生（或删除，改由服务端注入） | 需先确认 `chat/route.ts` 的注入点可由 Python 侧提供同一内容 | 1 人日 |
| S6 | `skills_library/` 只保留业务相关分类（restaurant/retail 相关），删除 apple / creative / note-taking / autonomous-ai-agents / social-media | 需产品确认保留清单 | 1 人日 + 决策 |
| S7 | 统一 5 个目录解析器至 `constants.get_skills_dir()` 单一入口 | 需逐个确认调用方 | 1 人日 |

**合计 6 人日**（不含 S6 的产品决策等待时间）。

## 删除前必须产出的引用证据

按任务要求「删除前证明无生产引用」，需对每个待删项产出引用清单：

| 待删项 | 已确认 | 待确认 |
|---|---|---|
| `skills/marketplace.py::install()` | ✅ 调用方仅 `app.py:864`（S1 后消失） | — |
| `skills_library/` 非业务分类 | ⚠️ 被 `skills/marketplace.py:26` 的 `*/*/SKILL.md` glob 读取 | 需确认 `packs/*.json` 是否引用了这些分类 |
| `src/lib/skills.ts` | ✅ 调用方仅 `chat/route.ts:491` | — |
| `skills_market/`（若不迁移） | ✅ **零非测试引用**（已实测） | — |

**决策点（需产品确认）**：`skills_market/` 是**接进去**还是**删掉**。二选一，不能继续让它以「已测试但无人调用」的状态存在 —— 这是本仓库最贵的一种债务。

---

# Task 6 — Production Deployment Checklist 📋 交付清单（未自动修改任何部署配置）

按任务要求「不要自动修改」，以下仅为人工执行清单。

## D-1 容器化

| 项 | 内容 |
|---|---|
| 现状 | 无 Dockerfile、无 docker-compose、无 systemd、无 k8s manifest |
| 需要 | Node 24 + Python 3.13 多阶段构建，或双容器 + 编排 |
| 关键约束 | `src/server.ts` 是自定义 server，运行时需要完整 `.next` 与 `node_modules`；无法改用 `next start` 之外的形态 |
| 持久卷 | `ROVEAGENT_ROOT` 必须指向持久卷。`roveagent-service.sh:82-88` 已警告 `ROVEAGENT_HOME` 与 `ROVEAGENT_ROOT` 必须对齐，否则状态分裂到两个根 |
| 进程编排 | uvicorn 需 supervisor + 重启策略 + liveness 探针；`.coze` 目前 `requires=["nodejs-24"]`，无 Python |
| 验收 | `curl -H "X-RoveAgent-Key: …" :8788/api/health` → 200 |

## D-2 Secrets

| 变量 | 用途 | 备注 |
|---|---|---|
| `COZE_SUPABASE_URL` / `ANON_KEY` / `SERVICE_ROLE_KEY` / `JWT_SECRET` | 数据库与会话 | 现落于 `scripts/deploy.env`，**既未跟踪也未 gitignore** → 需先加入 `.gitignore` 并改用平台 secret |
| `ENCRYPTION_SECRET` | 凭据加密 | **必须提供**。缺省时会回落到 `COZE_SUPABASE_SERVICE_ROLE_KEY`（已加告警但仍是有害复用） |
| `ROVEAGENT_API_KEY` | 服务间调用 | — |
| `ROVEAGENT_APPROVAL_SECRET` | 审批 HMAC | **必须与 API key 不同**。Phase 9 / A4 已强制：缺失或相同 → 审批回调 503 |
| `ROVEAGENT_LLM_API_KEY` / `_BASE_URL` / `_MODEL` | 运行时模型 | 生产缺 Key → `/api/agent/chat` 503（设计如此） |
| `SQUARE_APP_ID` / `SQUARE_APP_SECRET` | Square OAuth | 回调白名单 = `<APP_URL>/api/integrations/square/oauth/callback` |
| `WEB_PUSH_VAPID_*` | Web Push | `node scripts/generate-vapid.mjs` |

**禁止**：`RF_E2E_DEMO=1`（`server.ts` 在 PROD 下直接拒绝启动，已有 fail-closed）。
**禁止**：`ROVEAGENT_TEST_MODE=true` 进入生产 —— 它会启动返回罐头文本的 mock LLM，而 `runtime_status` 仍报告 `"roveagent"`（见技术债登记 P1-8）。

## D-3 数据库迁移

按顺序在目标 Supabase 项目执行：

1. `scripts/migrate.sql`
2. `scripts/migrate-business-tables.sql`
3. `scripts/migrate-pilot-ready.sql`
4. `scripts/migrate-rls.sql`
5. `scripts/verify-rls.sql` —— **出现 `RLS FAIL` 或 `raise exception` 即停止上线**
6. `scripts/migrate-runtime-metadata.sql`（`chat_sessions.runtime_*` 列）
7. `scripts/ensure-initial-user.ts`（幂等创建初始 owner）

注意：`src/server.ts` 启动时会调用 `autoMigrate()` 执行前三个文件；该路径需要 `DATABASE_URL` 或 `SUPABASE_ACCESS_TOKEN`，且当前使用 `ssl: { rejectUnauthorized: false }`（建议先在部署侧收紧）。

## D-4 Provider Keys

Stripe（live key）、Square（生产 token + location + webhook URL）、IMAP/SMTP（真实邮箱）、LLM provider。缺失时的行为已 fail-closed，不会伪造成功，但功能不可用。

## D-5 Domain / TLS / Cookie

- `NEXT_PUBLIC_APP_URL` 用于 OAuth 回调与站点链接
- 会话 cookie 的 `Secure` 属性按**请求协议**自适应（`isSecureRequest`），不能只看 `NODE_ENV` —— 这是已修事故，回归会重现「登录成功后被弹回登录页」

## D-6 Monitoring

| 项 | 现状 |
|---|---|
| APM / metrics / tracing | **不存在** |
| `/api/health` | 存在，但**公开且泄漏表名清单**；不探测 Python runtime。建议拆分为公开 liveness + 鉴权 detail |
| Python `/api/health` | **无鉴权**且返回租户数量（`app.py:350-354`） |
| 审计 | 双落点：Postgres `audit_events`（TS）+ 本机 `*.jsonl`（Python）。后者容器回收即丢 |
| 建议最小集 | 结构化日志 + request-id 跨平面贯通 + 首 token 延迟 / 工具成功率 / 审批时长 / failover 次数四个指标 + 告警 |

## D-7 Backup

无脚本、无演练。最低要求：Supabase 每日备份 + `ROVEAGENT_ROOT` 持久卷快照 + 一次恢复演练记录。

## D-8 环境差异验证

Linux 容器内需验证：CJK 字体可用性（`public/fonts/` 目前只有 README.md，中文 PDF 会降级）、Python 依赖可复现（无 lock 文件；`[web]` 是 optional extra）。

---

# 质量规则遵守声明

| 规则 | 遵守情况 |
|---|---|
| 不创建新架构 | 遵守。Skill Bundle 是「把 `skills_market/` 已有模块接到调用点」，非新建体系 |
| 不新增平行模块 | 遵守。新增文件均为测试或文档：`tool_policy_inventory.md`、`approval_decision_contract.json`、`approval-contract.test.ts`、`approval_contract_test.py`、`production_chain_e2e_test.py`、本报告 |
| 优先安全 | 遵守。Task 1/2 是本阶段主体 |
| 优先真实调用链 | 遵守。Task 3 在真实 FastAPI + 真实 gate + 真实 HMAC 回调上验证 |
| 禁止「代码完成」 | 遵守。Task 4 明确标记**部分完成**并说明已实现的优化缺 benchmark；Task 5/6 明确标记为计划/清单 |
| 每条结论附实测 | 遵守。所有数字来自本次 `pnpm test` / `python -B -m unittest` / `pnpm ts-check` / 注册表枚举脚本的输出 |

## 未完成事项（按依赖排序）

1. **Task 4 全部** —— 需要运行中的双平面栈才能做基准（D-3 / D-5）
2. **Task 5 S1–S7** —— 需产品确认 `skills_market/` 是接入还是删除
3. **Task 6 全部** —— 人工执行，需真实账号与服务器
4. **上一阶段遗留的 5 项无行为级测试的修复**（A7/A8/A9/A10/P2）—— 本阶段的 Task 3 已提供路由级测试的可行范式，可据此回补
