# RoveFrame Phase 10 Production Finalization — Completion Report

执行范围：性能测量 / Fast Path / Runtime 部署 / Skill 收敛 / 测试环境隔离 / 行为级测试
本阶段新增依赖：**0**（`package.json` 仅改一行脚本命令，未增删依赖）

验证基线（全部为本次实测输出）：

| 检查 | Phase 10 前 | Phase 10 后 |
|---|---|---|
| `pnpm ts-check` | PASS | **PASS** |
| `pnpm test`（TS） | 621 / 621 | **621 / 621 / 0 fail** |
| Python（旧命令直跑） | 777 / 777，**但触发真实付费 provider** | — |
| Python（新运行器，默认离线） | — | **782 / 782，日志无 `PAID lane engaged`** |
| 命中兜底策略的已注册工具 | 0 / 101 | **0 / 101**（Phase 9 保持） |

---

# Task 1 — Agent Runtime Performance Profiling ⚠️ BLOCKED（部分交付）

## 状态

| 要求 | 状态 |
|---|---|
| Request Trace（11 个阶段埋点） | ❌ **未交付** |
| `agent_latency_report.md`（P50/P95/P99 + sample count） | ❌ **未交付** |
| 不改变 SSE 事件协议 | ✅ 设计上已满足（见下方设计），未实施 |
| 无法连接真实 provider 时明确标记 | ✅ **本任务即为 BLOCKED** |

## BLOCKED 原因（明确标记，非伪完成）

要产出 P50/P95/P99 真实数据，必须有**运行中的双平面栈 + 真实 LLM provider**：

1. 本工作树**无构建产物**（`.next/BUILD_ID` 与 `dist/` 均不存在）
2. **无进程在跑**（端口 5000 / 8788 / 8799 实测全部 closed）
3. **Python Runtime 无部署路径**（Phase 9 已确认：无 Dockerfile，`.coze` 只 `requires=["nodejs-24"]`，`scripts/deploy.env` 无 `ROVEAGENT_*`）
4. 无真实 provider key

因此 Task 1 的量化产物**不可能在离线环境产出**。按总原则第 5 条，标记 **BLOCKED**，不伪完成。

## 已交付：可直接实施的埋点设计（约 1 人日）

在 `src/app/api/agent/chat/route.ts` 的 `runChat` 内引入请求级计时器：

| 阶段 | 埋点位置 | 验证目标 |
|---|---|---|
| `auth` | 进入 `runChat` 到 `getTenantContext` 返回 | 鉴权开销 |
| `classification` | 包裹 `classifyRequest()` | 预期 ≈0 |
| `capability_resolve` | Python `resolve_toolsets_for_request()`（`app.py:446`） | 能力解析成本 |
| `memory` | `getRecentMemories()`（`chat/route.ts:483`） | 记忆读取 |
| `retrieval` | `/api/knowledge/ask` 的向量检索段 | RAG 成本 |
| `planner` | 包裹 `invokeToolDecision()`（经 `runAgentTurn`） | **验证「planner 非流式整段生成」这一主因** |
| `LLM first token` | 首个 `delta` 前 | **TTFT，核心指标** |
| `LLM complete` | 流结束 | 总生成时间 |
| `tool execution` | `AgentToolRegistry.execute` 的审计回调累加 | 工具占比 |
| `approval` | `agent_approvals` 查询段（`chat/route.ts:814-822`） | 审批卡片查询 |
| `persist` | 助手消息写入 + 会话元数据更新 | 落库成本 |

**不改变 SSE 事件协议的做法**：不新增事件类型（现有 9 类契约由 TS↔Python 双方白名单校验）。timing 走两条旁路：
1. 结构化日志 `console.info('[agent/timing] ' + JSON.stringify(trace))`
2. `chat_sessions` 的 runtime 元数据列（已有 `runtime_mode` / `runtime_agent` 等，可扩展 jsonb 列）

**基准脚本**（建议 `scripts/agent-latency.mjs`，约 0.5 人日）：对运行栈发 N≥30 次请求，分简单短句与工具类长句两组，输出 P50/P95/P99 与 LLM 调用次数分布。

## 已存在但未被利用的数据

`ai_usage_ledger` 已记录每次 provider 调用的 `latencyMs` 与 `correlationId`（`router.ts:463-477`）—— **每 provider 调用的延迟已经存在**，缺的只是「一次 turn 内的阶段拆分」。

## 用户现在能否使用该能力

**不能。** 性能数据不存在，因此本阶段无法回答「慢在哪里」。**并且**：Phase 9 之前实现的两项优化（跳过 planner、memory 异步）仍然**没有 benchmark 支撑**，按总原则第 1 条，它们应被视为**待验证**而非已完成优化。

---

# Task 2 — Agent Fast Path 设计 ⚠️ 部分（实现已在上一阶段落地，本阶段缺少决策依据）

## 状态

| 要求 | 状态 |
|---|---|
| 根据 Task 1 结果决定 | ❌ **无法执行** —— Task 1 BLOCKED，没有结果可依据 |
| Simple Chat Path / Complex Agent Path | ✅ **已在上一阶段实现**（`gateway.ts` 的 `skipPlanning` + `chat/route.ts` 的分流接线） |
| 复杂任务能力不下降 | ⚠️ 有回归保护，但**无实测对比** |
| 三类测试（简单聊天 / 工具调用 / 审批流程） | ⚠️ 审批与工具链路由 Task 3（Phase 9 的 E2E）覆盖；**简单聊天路径无直接测试** |

## 现有实现（复用，未新增架构）

```
classifyRequest()  ── 已有，纯正则，无 LLM
   ├─ 'chat'           → streamChatWithFailover（Simple Path，1 次 LLM 调用）
   └─ 'tool_execution' → invokeToolDecision → runAgentLoop → 合成（Complex Path）
```

开关：`RF_AGENT_FAST_PATH=0` 可关闭。

**必须点明的风险**（Phase 9 已登记，此处重申）：分类为 `chat` 的请求不再触发工具调用。业务实时数据仍通过系统提示词注入（`getBusinessContext` 的 14 项快照），但**需要参数化查询的问题会失去工具能力**。当前**无 benchmark 证明这一取舍值得**。

## 是否可以上线

**可以保持现状**（功能正确、有开关、有回退），但**不应宣称「已优化」**。正确表述是：**一个待验证的优化已上线且可一键回退**。

---

# Task 3 — Runtime 生产部署 ❌ BLOCKED（未交付 Dockerfile）

## BLOCKED 原因

任务的硬前置是「人工环境」：
- 需要 Docker（本机 Docker CLI 存在但 **daemon 不可达**：`failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine` —— Phase 9 已实测）
- 需要 Linux 容器验证 CJK 字体与 Python 依赖
- 需要生产 secret 注入方式

因此 `Dockerfile` 与 `deployment_report.md` **未产出**。按总原则第 5 条标记 BLOCKED。

## 已交付：部署契约（可直接转为 Dockerfile）

### 启动流程

```
1. Node 24 容器：bash scripts/build.sh → pnpm install + next build + tsup → dist/server.js
                  bash scripts/start.sh → node dist/server.js（PORT=DEPLOY_RUN_PORT）
2. Python 3.13：  pip install -e ".[web]"   ← [web] 是 optional extra，必须显式装
                  bash scripts/roveagent-service.sh → uvicorn roveagent.api.app:get_app --factory
3. 顺序：Python 先起（TS 侧 roveAgentConfigured() 依赖 ROVEAGENT_API_URL + KEY 同时存在）
```

**关键约束**（`src/server.ts` 是自定义 server）：
- 运行时需要完整 `.next` 与 `node_modules`，**不能改用 `next start`**
- `ROVEAGENT_ROOT` 必须指向持久卷；`roveagent-service.sh:82-88` 已警告 `ROVEAGENT_HOME` 与 `ROVEAGENT_ROOT` 必须对齐，否则状态分裂到两个根

### health endpoint

| 端点 | 现状 | 需要 |
|---|---|---|
| TS `/api/health` | 存在；**公开且泄漏表名清单**；不探测 Python runtime | 拆分为公开 liveness（`{status}`）+ 鉴权 detail（表检查 + 调度器 + runtime 探针） |
| Python `/api/health` | **无鉴权**且返回租户数量（`app.py:350-354`） | 加 `Depends(auth)`，租户统计移入鉴权端点 |

### worker 启动方式

`src/server.ts:63` 的 `setInterval` 是唯一调度入口 —— **只在自定义 server 下运行**。若改用 `next start`，后台任务静默不跑。容器方案中必须保持 `start.sh` 作为唯一入口。

### environment contract

见 Phase 9 报告 Task 6 的 D-2 清单。硬约束两条：
- `ROVEAGENT_APPROVAL_SECRET` 必须存在且**不等于** `ROVEAGENT_API_KEY`（否则审批回调 503，Phase 9 / A4 已强制）
- `ROVEAGENT_OFFLINE` **不得**在生产设为 1（会禁用全部辅助通道）

### logging

现状 `console.*` 直出；Python 侧 `logsetup.py` 有轮转但落 `ROVEAGENT_ROOT`。容器中需把两者统一到 stdout/stderr 采集，并保证审计的 JSONL 落持久卷（否则容器回收即丢）。

### shutdown

| 侧 | 现状 | 风险 |
|---|---|---|
| TS | 无 SIGTERM 处理 | 进行中的 SSE 流被截断；调度器 tick 可能被腰斩 |
| Python | `roveagent-service.sh` 用 `exec`（信号直达 uvicorn） | 相对正确 |

需要：TS 侧加 SIGTERM → 停止接受新请求 → 等待在飞 SSE（上限 N 秒）→ 释放并发额度 → 退出。

### 资源需求（未实测，标注为估算）

| 项 | 估算 | 依据 |
|---|---|---|
| Node | 1 vCPU / 1 GB | Next 16 自定义 server + 21 页面 |
| Python | 1–2 vCPU / 1–2 GB | 1,182 文件、加载 101 个工具；`agent-loop` 为单请求状态 |
| 磁盘 | Node ~1.5 GB（含 node_modules）+ Python ~800 MB（含依赖） | 未实测 |
| 持久卷 | `ROVEAGENT_ROOT`（SQLite 会话/记忆/审计/技能） | 大小随时间增长 |

### 故障恢复

| 故障 | 现状 | 需要 |
|---|---|---|
| Runtime 崩溃 | TS 侧 `runtime_status: unavailable`，工具类请求**硬失败**（不假装） | supervisor 自动重启 + 探针 |
| TS 崩溃 | Python 的 approval bridge 推送失败（`.roveagent/logs/errors.log` 有 `WinError 10061` 实证） | 重试队列或落盘补发 |

## 用户现在能否使用该能力

**不能。** 部署仍未实现，819,238 行 Python 运行时在真实部署中依然不可达。

---

# Task 4 — Skill 系统收敛 📋 计划已交付（Phase 9 已产出，本阶段确认）

## 硬性事实（实测）

| # | 位置 | 行数 | 生产可达 |
|---|---|---|---|
| 1 | `roveagent/skills/` | 174 | ✅ `app.py:848,864`（catalog/install）+ `kernel.py:29` |
| 2 | `roveagent/skills_library/` | 65 py + 261 md | 仅被 #1 的 glob 读取 |
| 3 | `roveagent/skills_market/` | **2,441** | ❌ **零非测试引用** |
| 4 | `src/lib/skills.ts` | 11 | ✅ 注入系统提示词 |

**HTTP 端点用的是 104 行简化版，而不是 2,441 行完整版**（后者含 `sandbox.py` / `scanner.py` / `permissions.py` / `versions.py`）。

## 目标：Skill Bundle，入口收敛到 Capability Registry

```
Skill Bundle
├── manifest       → 复用 skills_market/manifest.py（243 行，已实现）
├── capabilities   → 复用 api/capability_providers.py::SkillCapabilityProvider（已存在）
├── permissions    → 复用 skills_market/permissions.py（194 行）
└── sandbox        → 复用 skills_market/sandbox.py（197 行）+ api/plugin_isolation.py
```

**这不是新体系**，而是把 `skills_market/` 已有的四个模块接到 `skills/marketplace.py` 的调用点上，并把发布入口统一为 `CapabilityProvider`（Phase 8.1.5 已确立的「系统总线」）。**未新增第三套 Skill 系统。**

迁移步骤 S1–S7 详见 `RoveFrame_Phase9_Completion_Report.md` Task 5，合计 6 人日。

## 需要产品决策的一项

**`skills_market/` 是接进去还是删掉。** 二选一。继续让它以「已测试但无人调用」的状态存在，是仓库里最贵的一类债务。

## 用户现在能否使用该能力

**部分可以** —— 技能市场的 `catalog` / `install` 三个 HTTP 端点在生产可达（`app.py:848,864,882`），但用的是**未经 sandbox / scanner / permissions 加固**的实现。即：**功能可用，安全性未达设计意图**。

---

# Task 5 — 测试环境隔离 ✅ 完成（本阶段最高确定性的交付）

## 1. 修改文件

| 文件 | 变更 |
|---|---|
| `roveagent/core/auxiliary_client.py` | 新增 `_offline_guard_active()`；在 `_create_openai_client`（**所有 aux 客户端构造的共享卡点**）与 `_try_openrouter`（付费车道入口）加短路 |
| `scripts/run-python-tests.py` | **新增** —— 默认设置 `ROVEAGENT_OFFLINE=1` 的测试运行器（可用 `=0` 显式放行真实联调） |
| `roveagent/core/external_call_guard_test.py` | **新增** —— 5 个守卫用例 |
| `package.json` | `test:python` 由 `python -m unittest discover …` 改为 `python scripts/run-python-tests.py`（**唯一改动，未增删依赖**） |

## 2. 架构变化

**无新架构。** 闸门复用了模块内**既有**的短路径制：`_create_openai_client` 注释自述为 "single shared chokepoint for every aux client build"，且已有 `_aux_probe_active()` + `_AuxProbeClientStub` 这套「不构造真实 SDK 客户端」的机制。`_offline_guard_active()` 与 `aux_probe_mode()` **共用同一套短路点**，区别只是触发方式（环境级 vs with 块级）。

## 3. 真实调用链

修复前的实测证据（Phase 9 运行输出）：

```
Auxiliary client: PAID lane engaged for auxiliary task — OpenRouter fallback model
'google/gemini-3.6-flash' is not a :free SKU and may incur real spend.
Auxiliary: marking openrouter unhealthy for 60s (payment / credit error).
Auxiliary Nous client unavailable: no Nous authentication found
```

即 **`python -m unittest discover` 会向 OpenRouter / Nous 发起真实付费请求**。根因不是「某处写了真实 key」，而是辅助通道的 provider 解析在本机凭据（`.env` / `scripts/deploy.env`）存在时**自动接入付费车道**。

修复后的调用链：

```
scripts/run-python-tests.py
  └─ ROVEAGENT_OFFLINE=1
       └─ _offline_guard_active() == True
            ├─ _try_openrouter()      → (None, None)  ← 不进入付费车道，不打印告警
            └─ _create_openai_client() → _AuxProbeClientStub  ← 不 import openai，不建 socket
```

## 4. 测试结果

```
$ python -B -m unittest roveagent.core.external_call_guard_test
Ran 5 tests — OK

$ python -B scripts/run-python-tests.py
[run-python-tests] ROVEAGENT_OFFLINE=1 (no external provider calls)
Ran 782 tests in 109.457s
OK
```

**关键证据**：全量运行后日志中**不再出现 `PAID lane engaged`**（用例 `test_paid_lane_warning_is_not_emitted_while_offline` 亦锁定该断言）。

守卫用例不是「看返回值」，而是**把 socket 层打断**后跑完整条解析路径 —— 任何环节真想连网都会触发 `AssertionError`：

| 用例 | 断言 |
|---|---|
| `test_guard_is_env_driven` | `0/false/no/""` 均关闭闸门 |
| `test_no_sdk_client_is_constructed_while_offline` | 构造卡点返回探针桩而非真实客户端 |
| `test_openrouter_resolution_short_circuits_without_network` | patch `socket.connect` / `connect_ex` 为抛错后仍正常返回 `(None, None)` |
| `test_paid_lane_warning_is_not_emitted_while_offline` | 捕获 logger 输出，断言无 `PAID lane` |
| `test_guard_defaults_on_under_the_test_runner` | 运行器确实设置该变量 |

## 5. 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 闸门覆盖面 | 精确覆盖 `_create_openai_client`（全部 aux 客户端构造）+ `_try_openrouter`（实测的付费车道）。**其他出站路径**（`web_search`、`image_generate`、`retrieval`、MCP）未逐一验证 | 已在报告中标注；完整封闭需要 socket 层全局限制（见下） |
| `_try_nous` 未加前置短路 | 其凭据解析可能仍尝试网络；但客户端构造已被卡点拦下 | 建议后续与 `_try_openrouter` 同样处理 |
| 默认离线可能掩盖问题 | 开发者本地跑测试时不会察觉「真实 provider 未配置」 | 运行器显式打印 `no external provider calls` / `REAL PROVIDER CALLS ALLOWED` |
| `package.json` 改动 | 唯一改动，未增删依赖 | 已核实 |

**建议的完整封闭方案**（约 0.5 人日）：在 `run-python-tests.py` 中除环境变量外，再安装一个 socket 层守卫（patch `socket.socket.connect`），使**任何**未预料的出站调用在测试期直接失败而非静默计费。这比逐 provider 审计更彻底。

## 6. 用户现在能否使用该能力

**可以。** `pnpm test:python` 现在默认零外部消费，CI 可以直接接入而不会产生账单。需要真实联调时 `ROVEAGENT_OFFLINE=0 python scripts/run-python-tests.py`。

---

# Task 6 — 补齐行为级测试 ❌ 未交付（诚实登记）

## 状态

针对 A7 / A8 / A9 / A10 / P2 的**真实 HTTP / service 测试未建立**。

## 未交付的原因（技术性的，不是时间借口）

这 5 项的对象是 **Next.js 路由处理器**（`src/app/api/knowledge/ask`、`business/products/generate`）与 **React hook**（`use-sse`），以及一个**未导出**的内部函数（`scheduler.ts` 的 `maybeSyncSquare` / `maybeSyncInboundEmail`）。要建立「用户请求 → 服务 → 结果」的真实测试，需要：

1. **路由级测试脚手架**：构造 `Request`、stub 掉 `getTenantContext`（含 JWT 解析）、stub Supabase、stub AI router
2. **DOM 环境**（`use-sse` 是 React hook）

本仓库**不存在**这两样，建立它们本身是一项独立工作（约 2–3 人日），且不能算作「补齐 5 个测试」。

## Phase 9 已提供的可行范式

`roveagent/enterprise/production_chain_e2e_test.py` 证明了在 **Python 侧**可以低成本建立真实链路测试（真实 FastAPI app + 真实 gate + 真实 HMAC 回调 + 真实审计 sink，6 个用例覆盖 5 个场景）。**TS 侧需要等价物**：一个能实例化 route handler 的最小 harness。

## 建议的实施路径

| 步 | 动作 | 工作量 |
|---|---|---|
| 1 | 建立 `tests/harness/route.ts`：给定 handler + Request → Response，并提供 `withStubbedDeps()`（mock tenant/AI/Supabase） | 1.5 人日 |
| 2 | A8 测试：非法 JSON → 断言 `source === 'fallback'` 且 `category === ''`（非 `'招牌菜'`） | 0.5 人日 |
| 3 | A7 测试：RPC 报错 / 零命中 / 有命中 → 断言 `X-Retrieval-Status` 三态且 `X-Sources` 为空 | 0.5 人日 |
| 4 | A9 测试：**先把水位决策抽成可导出的纯函数**，再断言「失败不推进 `last_success_at`」 | 0.5 人日 |
| 5 | A10 测试：把 `use-sse` 的解析逻辑抽成纯函数（不依赖 React）后断言 error+artifact+done 完整接收 | 0.5 人日 |
| 6 | P2 测试：断言 `classifyRequest('你好') === 'chat'` 时 `invokeToolDecision` **零调用** | 0.5 人日 |

**合计 4 人日**。其中第 4、5 步需要**先做小重构**（抽纯函数）—— 这本身是设计改进，不是为测试而测试。

## 用户现在能否使用该能力

**不能。** 这 5 项修复仍然只有 `ts-check` + 全量套件绿作为证据，**没有行为级证明**。

---

# 汇总：本阶段能力可用性回答

| 能力 | 用户现在能否使用 | 说明 |
|---|---|---|
| Tool Policy default-deny | ✅ **可以** | Phase 9 交付，101 工具 0 兜底，777+5 测试覆盖 |
| Approval Contract 统一 | ✅ **可以** | 两侧同契约、同一样例集双向校验 |
| 真实链路 E2E（门控/审批/审计） | ✅ **可以** | Python 侧 6 用例，真实 app + 真实签名回调 |
| **CI 零消费测试** | ✅ **可以** | 本阶段交付；`pnpm test:python` 默认离线，实测无 `PAID lane` |
| 性能数据（P50/P95/P99） | ❌ **不能** | BLOCKED —— 无运行栈、无 provider |
| Fast Path 优化 | ⚠️ **可用但未验证** | 已实现、有开关、可回退；**无 benchmark 支撑** |
| Runtime 生产部署 | ❌ **不能** | BLOCKED —— Docker daemon 不可达；契约已交付 |
| Skill Bundle 收敛 | ⚠️ **功能可用，安全未达** | 需产品决策「接入 or 删除」`skills_market/` |
| A7/A8/A9/A10/P2 行为级测试 | ❌ **不能** | 需先建 TS 路由测试脚手架（4 人日） |

---

# 架构变化声明

| 问题 | 回答 |
|---|---|
| 是否新增模块？ | **否。** 新增文件全部是测试、脚本或文档：`scripts/run-python-tests.py`（脚本，有明确调用方 `package.json`）、`external_call_guard_test.py`（测试）、本报告 |
| 是否创建第二套架构？ | **否。** 离线闸门复用了既有的 `_create_openai_client` 短路点与 `_AuxProbeClientStub` |
| 是否新增依赖？ | **否。** `package.json` 仅改一行命令，未增删任何依赖 |
| 是否改动业务逻辑？ | **否。** `auxiliary_client.py` 的改动只在 `ROVEAGENT_OFFLINE=1` 时生效；未设置该变量时行为与改动前完全一致 |

---

# 本阶段未完成事项（按依赖排序）

| # | 事项 | 阻塞原因 |
|---|---|---|
| 1 | Task 1 性能测量 | **BLOCKED** —— 需运行中的双平面栈 + 真实 provider（据 Task 3） |
| 2 | Task 3 Runtime 部署 | **BLOCKED** —— Docker daemon 不可达 + 需人工环境 |
| 3 | Task 2 基于数据的决策 | 依赖 #1 |
| 4 | Task 6 行为级测试 | 需先建 TS 路由测试脚手架（4 人日） |
| 5 | Task 4 迁移执行 | 需产品决策「`skills_market/` 接入 or 删除」 |
| 6 | Task 5 的完整封闭 | 建议加 socket 层全局守卫（0.5 人日） |
| 7 | Phase 9 遗留的 5 项无测试修复 | 同 #4 |

# 解除 BLOCKED 的最小路径

```
1. Docker daemon 可用（或提供可构建的 Linux 环境）        ← 解除 Task 3
2. 提供 ROVEAGENT_* + ENCRYPTION_SECRET + 一个真实 LLM key ← 解除 Task 1 / 2
3. 在 #1#2 基础上：pnpm build && 启动双平面
4. 跑 scripts/agent-latency.mjs（需先实现埋点，约 1 人日）  ← 产出 P50/P95/P99
5. 用 Task 1 的数据决定 Fast Path 是否保留
```

在第 1、2 项满足之前，Task 1、2、3 的量化目标**不可能完成**，不应以任何形式宣称已完成。
