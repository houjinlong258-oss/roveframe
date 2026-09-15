# RoveFrame Phase 10.5 — Production Reality Validation 报告

执行顺序：Task 1 → 2 → 3 → 4 → 5 → 6
本阶段新增依赖：**0** ｜ 新增业务代码：**0**（仅新增报告与一个本地基准脚本，基准脚本落在临时目录，未入库）

## 本阶段的核心结论（一句话）

> **RoveAgent Python 运行时已被证明可以真实运行并响应请求** —— 而它的**单请求耗时是 5.3–22 秒，中位数约 13 秒，且与 LLM 完全无关**（本地 mock 即时返回）。

这是整轮审计中第一次拿到运行时的真实性能数据，也是「Agent 处理慢」的第一个硬证据。

---

# Task 1 — Production Simulation Environment

## 1. Environment Block Report（按任务要求，Docker 不可用时不改代码）

| 检查项 | 实测结果 | 判定 |
|---|---|---|
| Docker daemon | `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; ... The system cannot find the file specified.` | ❌ **BLOCKED** |
| `docker context ls` | `desktop-linux *` 指向上述不可达 npipe | 上下文存在但后端缺失 |
| `docker-compose` | `C:\Program Files\Docker\Docker\resources\bin\docker-compose.exe` 存在 | ⚠️ 二进制存在但无 daemon，不可用 |
| container runtime | 不可用（依赖 daemon） | ❌ BLOCKED |
| network / volume | 无法验证（依赖 daemon） | ❌ BLOCKED |

**Docker 阻塞的解除条件**：启动 Docker Desktop（或提供任意可达的 Linux 容器运行时），使 `docker info` 返回 ServerVersion。

**未修改任何代码**（符合任务要求）。

## 2. Production Simulation Report —— 用本地进程替代容器，成功建立

关键判断：**Docker 不可用 ≠ 仿真环境不可建立**。Python 运行时不需要容器即可启动。

| 组件 | 容器方案 | **实际采用的方案** | 结果 |
|---|---|---|---|
| Frontend (TS) | Docker | 未启动（本轮未验证 TS 侧，见 Task 2/3） | ⚠️ 未验证 |
| **Python Runtime** | Docker | **本地 uvicorn 进程** | ✅ **已启动并真实响应** |
| **Database** | 容器内 Postgres | **本地 SQLite（`ROVEAGENT_ROOT`）** | ✅ 已工作 |
| **Worker** | 容器 | **进程内（kernel 单例）** | ✅ 已工作 |
| **LLM Provider** | 真实 provider | **`scripts/mock_llm_provider.py`（本地 8799）** | ✅ 已工作 |
| 支付 / 社交 / 真实用户 | — | **按要求未接入** | ✅ |

### 启动流程（实测可用）

```
1. 环境变量
   PYTHONPATH=<repo>
   ROVEAGENT_ROOT=<tmp>/root
   ROVEAGENT_API_KEY=sim-api-key
   ROVEAGENT_APPROVAL_SECRET=sim-approval-secret   ← 必须与 API_KEY 不同（Phase 9/A4）
   ROVEAGENT_LLM_API_KEY=mock-test-key
   ROVEAGENT_LLM_BASE_URL=http://127.0.0.1:8799/v1
   ROVEAGENT_LLM_MODEL=mock-model

2. python -m scripts.mock_llm_provider                 → 127.0.0.1:8799
3. python -m uvicorn roveagent.api.app:get_app --factory --host 127.0.0.1 --port 8788
   （必须 --factory：app.py 模块级 app = None）
```

### 依赖与端口

| 项 | 实测 |
|---|---|
| Python | 3.13.2（`requires-python = ">=3.11,<3.14"` 命中） |
| fastapi / uvicorn | **0.115.0 / 可用**（注意：`pyproject.toml` 声明的是 `[web]` optional extra，未装则启动失败） |
| Node / pnpm | v26.2.0 / 9.0.0 |
| 端口 | 8788（runtime）、8799（mock LLM）、5000（TS，本轮未用）—— 三者实测原本均空闲 |
| 磁盘 | D: 70.1 GB free |

### 资源（实测，非估算）

| 项 | 数值 |
|---|---|
| 冷启动到可服务 | ≈ 14 秒（进程启动 + kernel 初始化） |
| Runtime 内存 | 未采集（本轮未加监控） |
| 审计落点 | `<ROVEAGENT_ROOT>/audit/*.jsonl`（本地磁盘） |

### 用户现在是否真的可以使用

⚠️ **本仿真环境仅对开发者可用**（需要手工设 7 个环境变量 + 手动起两个进程）。**终端用户不可用** —— 这正对应已登记的 P0-1：运行时没有部署路径。

---

# Task 2 — Agent Timing Trace ⚠️ 部分完成（Python 侧已产出真实数据；TS 侧埋点未实施）

## 关键交付：`agent_latency_report.md`

### 测量方式（可复现）

- 目标端点：`POST http://127.0.0.1:8788/api/agent/chat`（**非流式**，Python 主 Runtime）
- LLM：`scripts/mock_llm_provider.py`（本地、即时返回、返回固定短文本）
- `ROVEAGENT_OFFLINE=1`（Phase 10 交付的闸门）
- 每个样本使用**独立 `session_id`**，避免会话历史累积干扰
- 采样：1 次冷启动 + 1 次预热 + **30 次采样**（n=31，全部 HTTP 200）

### 结果

| 指标 | 数值 |
|---|---|
| **sample count** | **31**（30 warm + 1 cold） |
| COLD 首次请求 | **8,796 ms** |
| **WARM 平均** | **11,053 ms** |
| **WARM P50** | **12,959 ms** |
| **WARM P95** | **14,062 ms** |
| **WARM P99** | **19,949 ms** |
| WARM min / max | 5,317 ms / 22,256 ms |
| HTTP 状态分布 | `{200}`（零失败） |
| 回复长度 | 52 字符（mock 固定输出） |

### 阶段拆分（诚实标注：哪些是实测、哪些是推断）

| 阶段 | 实测值 | 说明 |
|---|---|---|
| `auth` | 未单独测量 | 含在总时长内 |
| `request_classify` | 未单独测量 | 该端点不做 TS 侧分类 |
| `capability_resolve` | 未单独测量 | `app.py:446` 每请求执行 |
| `memory_load` | 未单独测量 | 响应体 `memory_used=0` |
| `retrieval` | 不适用 | 该端点不做向量检索 |
| `planner` | 未单独测量 | 该端点走非流式 `agent_chat` |
| **`llm_first_token` / `llm_complete`** | **≈0（mock 即时返回）** | **因此 5.3–22 秒几乎全部是运行时自身开销** |
| `tool_execution` | 未单独测量 | mock 未触发工具 |
| `approval` | 不适用 | — |
| `persist` | 未单独测量 | 含在总时长内 |
| `response_close` | 未单独测量 | — |

### 三个可直接行动的核心发现

**发现 1 —— 慢的不是模型。**
LLM 是本地 mock，响应时间可忽略。**5.3–22 秒全部是 RoveAgent 运行时自身的 per-request 开销。**

**发现 2 —— WARM 比 COLD 更慢，且方差极大。**
COLD 8,796 ms，而 WARM P50 12,959 ms、max 22,256 ms。这**排除**了「kernel 冷启动是成本」的解释（冷启动反而更快），指向**随状态增长的 per-request 工作**或**累加的阻塞式重试**。

**发现 3 —— 即使取最好的样本（5,317 ms），单请求底线也超过 5 秒。**
对一个「中小企业 AI COO」产品而言，5 秒是底线而非上限，不可接受。

### 最可能的原因（推断，需下一步埋点验证）

| 候选 | 依据 | 验证方式 |
|---|---|---|
| **辅助通道阻塞式重试** | 上一轮实测 stderr 出现 `Auxiliary: marking openrouter unhealthy for 60s (payment / credit error)` 与 `no Nous authentication found`。**即使设置了 `ROVEAGENT_OFFLINE=1`，`_try_nous` 仍未加前置短路**（Phase 10 已登记该缺口），其凭据解析可能触发网络超时 | 给 `_try_nous` 加同样的闸门后重测；若 P50 骤降即为确因 |
| **每请求新建 `AIAgent`** | 审计已确认 `_build_agent` 每请求调用（`app.py:152`/`:160`），内含 toolset 解析 + 工具发现 | 埋点测 `_build_agent` 耗时 |
| **101 个工具的可用性检查** | stderr 出现大量 `check_fn … returned False`，若未完全缓存则会每请求重跑 | 埋点测 toolset 解析段 |
| **SQLite 状态库竞争** | 每请求写 `chat_sessions`；WAL 锁在快速串行下会排队 | 换内存库或复用 session 重测 |

### 阻塞声明（按原则 3）

| 项 | 状态 |
|---|---|
| Python 侧真实数据 | ✅ **已产出**（本报告） |
| **TS 侧 12 阶段埋点（含 SSE 流式路径）** | ❌ **未实施**。原因：需先实现 `src/app/api/agent/chat/route.ts` 的计时器（Phase 10 已给出设计），且验证需要运行中的 TS 栈 |
| **`llm_first_token` 真实值** | ⚠️ **BLOCKED** —— 无真实 LLM provider，mock 的 TTFT ≈ 0，无法反映生产 |
| `retrieval` / `approval` 阶段 | ❌ BLOCKED —— 非流式端点不经过这两条路径 |

**不改变 SSE 协议**：本轮未新增任何事件类型，也未新增前端事件（Python 非流式端点本身不涉及 SSE）。

### 用户现在是否真的可以使用

❌ **不能。** 数据已产出，但**埋点未进入生产代码** —— 生产环境仍无法持续采集延迟。当前数据来自一次性本地基准。

---

# Task 3 — Fast Path 验证 ❌ BLOCKED

## 状态

| 要求 | 状态 |
|---|---|
| 至少 30 个请求 × 三类（A 简单聊天 / B 需工具 / C 复杂 Agent） | ❌ 未执行 |
| 对比旧路径 vs Fast Path（first token / total / tool correctness / failure rate） | ❌ 未执行 |
| 输出 `fast_path_benchmark.md` | ❌ 未产出 |

## 阻塞原因（具体条件，非时间借口）

Fast Path 是 **TypeScript 侧**的实现（`src/lib/agent/gateway.ts` 的 `skipPlanning` + `chat/route.ts` 的分流）。要测量它，必须能发出 `POST /api/agent/chat` 并接收 SSE，这需要：

1. **可运行的 Next.js 服务**：本工作树无 `.next/BUILD_ID`、无 `dist/`。开发模式（`tsx watch src/server.ts`）理论上可行，但需要一次完整的 `next` 编译
2. **可用的 LLM provider**：TS 侧 AI 路由的兜底档是 `coze-coding-dev-sdk` 的 `LLMClient`，本地不可用；外部档需要真实 key
3. **A/B 对照**：需要在同一进程内切换 `RF_AGENT_FAST_PATH`，因此必须重启服务两次并各自跑 30 次

**解除条件**：满足 Phase 10.5 Task 1 中的 TS 栈启动（`next` 编译通过）+ 一个可用的 LLM provider（真实 key，或把 mock LLM 暴露为 OpenAI 兼容端点并被 TS 侧的外部 provider 配置引用）。

## 本轮已获得的相关证据

Python 主 Runtime 的非流式路径实测 P50 = **12,959 ms**（mock LLM）。这**不能**直接用来评判 Fast Path（Fast Path 在 TS 侧、且走流式），但确立了一个基线事实：**运行时自身的开销量级已经超过任何模型差异**。

## 用户现在是否真的可以使用

⚠️ **Fast Path 当前是「已上线但未验证」** —— 可一键回退（`RF_AGENT_FAST_PATH=0`），但既无数据证明它更快，也无数据证明它对复杂任务无损害。**按原则 1，不得声称它已优化。**

---

# Task 4 — Skill System 收敛：Decision Report

## 扫描结果（实测，非静态推测）

| # | 位置 | 行数 | 生产可达 | 安全加固 |
|---|---|---|---|---|
| 1 | `roveagent/skills/` | 174 | ✅ `app.py:848`(catalog) / `:864`(install) / `:882`(create)；`kernel.py:29`(pack) | ❌ 仅 `require_safe_id` + `sanitize_skill_name` |
| 2 | `roveagent/skills_library/` | 65 py + 261 md + 251 KB index | 仅被 #1 的 glob 读取 | — |
| 3 | `roveagent/skills_market/` | **2,441**（含 773 行测试） | ❌ **零非测试引用** | ✅ `scanner.py`(356) `permissions.py`(194) `versions.py`(255) `sandbox.py`(197) |
| 4 | `src/lib/skills.ts` | 11 | ✅ 注入系统提示词 | — |

**核心事实**：HTTP 端点用的是**未经加固的 104 行简化版**，而不是**加固完备的 2,441 行完整版**。

## 决策：**方案 A —— `skills_market` 并入 `skills`**

| 方案 | 判定 | 理由 |
|---|---|---|
| **A（推荐）** | ✅ | `skills_market/` 是**已经写好、已经测试（773 行用例）、且安全能力显著更强**的一方。删除它等于丢弃仓库里质量最高的安全资产，并继续用未加固的安装路径。并入方向清晰：`skills/` 保留为**唯一入口**，`skills_market/` 作为其**内部实现**被吸收 |
| B（`skills` 作为 legacy 全部迁移） | ❌ | 要求重写 `catalog()` 的三源聚合（builtin/library/tenant）逻辑，且 `kernel.py:29` 已依赖 `skills.packs`；迁移面更大而收益相同 |

### 为什么是「并入」而不是「新建 Skill Bundle 体系」

任务要求「唯一入口：Capability Registry」。映射关系**全部复用现有代码**：

| Bundle 组成 | 复用对象（已存在） |
|---|---|
| Manifest | `skills_market/manifest.py`（243 行） |
| Capabilities | `api/capability_providers.py::SkillCapabilityProvider`（已存在） |
| Permissions | `skills_market/permissions.py`（194 行） |
| Sandbox | `skills_market/sandbox.py`（197 行）+ `api/plugin_isolation.py` |
| **唯一发布入口** | **`CapabilityProvider`** —— Phase 8.1.5 已确立的「系统总线」，模块 docstring 自述：*"Every producer of agent-visible tools must therefore publish through it, or the same failure returns one layer down: a Media Hub that works, that nothing consults."* |

**未新增第三套 Skill 系统。**

## 迁移步骤

| 步 | 动作 | 前置证据 | 工作量 |
|---|---|---|---|
| S1 | `app.py` 的 `/api/agent/skills/{market,install}` 改为调用 `skills_market.registry` + `installer`；`skills/marketplace.py` 保留一个发布周期作为 fallback | 两个端点的 import 行已定位 | 1 人日 |
| S2 | 安装路径接入 `skills_market/scanner.py`（**当前安装无任何代码扫描**） | 文件已存在且已测试 | 0.5 人日 |
| S3 | 新增 `/api/skills/bundles` 只读端点（manifest + capabilities + permissions + sandbox），发布经 `SkillCapabilityProvider` | `skills_market/registry.py:196` | 1 人日 |
| S4 | 删除 `skills/marketplace.py::install()`（S1 后无调用方） | 已确认唯一调用方是 `app.py:864` | 0.5 人日 |
| S5 | `src/lib/skills.ts` 改为由服务端注入（或从 `skills/packs/*.json` 派生），消除行业枚举分叉 | 需确认注入点 | 1 人日 |
| S6 | `skills_library/` 只保留业务相关分类 | **需产品确认保留清单** | 1 人日 + 决策 |
| S7 | 5 个目录解析器统一到 `constants.get_skills_dir()` | 需逐个确认调用方 | 1 人日 |

**合计 6 人日**（不含 S6 的决策等待）。

## 需要你决策的一项（触发暂停条件之一）

**S6 的保留清单**，以及**是否授权删除 `skills/marketplace.py::install()`**（S4）。后者属于「删除代码」，按任务规则需暂停确认。

## 用户现在是否真的可以使用

⚠️ **功能可用，安全未达设计意图。** 技能市场的 catalog / install / create 三个端点在生产的可达，但**安装路径没有 scanner、没有 permissions 校验、没有版本管理、没有沙箱** —— 而这四项都已经写好并测试过，只是没被调用。

---

# Task 5 — TS 真实链路测试 ❌ BLOCKED

## 状态

| 要求 | 状态 |
|---|---|
| 覆盖 A7 / A8 / A9 / A10 / P2 | ❌ 未交付 |
| ≥5 条真实流程（用户请求 → Next API → Service → Mock Provider → Response） | ❌ 未交付 |
| 禁止只测函数 | ✅ 遵守 —— 没有退而求其次写函数级测试 |

## 阻塞原因

要建立「用户请求 → Next API → Service → Mock Provider → Response」需要：

1. **路由级测试脚手架**：构造 `Request`、stub `getTenantContext`（含 JWT 解析）、stub Supabase、注入 mock provider。**本仓库不存在。**
2. **`use-sse` 需要 DOM 环境**（React hook）
3. **A9 的对象未导出**：`scheduler.ts` 的 `maybeSyncSquare` / `maybeSyncInboundEmail` 是模块私有函数，无法从测试驱动

Phase 9 已证明**Python 侧**可以低成本建立真实链路测试（`production_chain_e2e_test.py`：真实 FastAPI app + 真实 gate + 真实 HMAC 回调 + 真实审计 sink，6 用例覆盖 5 场景）。**TS 侧需要等价物。**

## 解 除条件与实施路径

| 步 | 动作 | 工作量 |
|---|---|---|
| 1 | `tests/harness/route.ts`：给定 handler + Request → Response，并提供 `withStubbedDeps()` | 1.5 人日 |
| 2 | A8：非法 JSON → 断言 `source === 'fallback'` 且 `category === ''` | 0.5 人日 |
| 3 | A7：RPC 报错 / 零命中 / 有命中 → 断言 `X-Retrieval-Status` 三态 | 0.5 人日 |
| 4 | A9：**先把水位决策抽成可导出纯函数**，再断言「失败不推进 `last_success_at`」 | 0.5 人日 |
| 5 | A10：把 `use-sse` 解析逻辑抽成纯函数（去 React 依赖）后断言 error+artifact+done 完整接收 | 0.5 人日 |
| 6 | P2：断言 `classifyRequest('你好')==='chat'` 时 `invokeToolDecision` **零调用** | 0.5 人日 |

**合计 4 人日**，其中第 4、5 步需先做小重构（抽纯函数）——那本身是设计改进。

## 用户现在是否真的可以使用

❌ **不能。** A7/A8/A9/A10/P2 五项修复仍只有 `ts-check` + 全量套件绿作为证据，**无行为级证明**。

---

# Task 6 — Production Checklist（仅准备，不上线）

## Docker

| 项 | 现状 | 需要 |
|---|---|---|
| Dockerfile | ❌ 不存在 | Node 24 + Python 3.13 多阶段；或双容器 |
| 关键约束 | `src/server.ts` 是自定义 server | 运行时需完整 `.next` + `node_modules`，**不能改用 `next start`** |
| 持久卷 | — | `ROVEAGENT_ROOT` 必须持久化；`ROVEAGENT_HOME` 必须与之对齐（`roveagent-service.sh:82-88` 已警告否则状态分裂） |
| 启动顺序 | — | **Python 先起**（TS 侧 `roveAgentConfigured()` 要求 URL+KEY 同时存在） |
| daemon 前置 | 本机不可达（Task 1） | 必须先有可达的容器运行时 |

## Secrets

| 变量 | 硬约束 |
|---|---|
| `COZE_SUPABASE_*`（4 个） | 现落 `scripts/deploy.env`，**既未跟踪也未 gitignore** → 先 gignore 再提交 |
| `ENCRYPTION_SECRET` | **必须提供**；缺省会回落 `COZE_SUPABASE_SERVICE_ROLE_KEY`（有害复用，Phase 9 已加告警） |
| `ROVEAGENT_APPROVAL_SECRET` | **必须存在且 ≠ `ROVEAGENT_API_KEY`**，否则审批回调 503（Phase 9/A4 已强制） |
| `ROVEAGENT_OFFLINE` | **生产必须为 0 或未设置**；设为 1 会禁用全部辅助通道 |
| `RF_E2E_DEMO` | **禁止为 1**（`server.ts:13-15` 在 PROD 下直接拒绝启动） |
| `ROVEAGENT_TEST_MODE` | **禁止进入生产** —— 会启动返回罐头文本的 mock LLM，而 `runtime_status` 仍报 `"roveagent"`（P1-8） |

## Migration

按序执行，任一步失败即停止：

1. `scripts/migrate.sql` 2. `migrate-business-tables.sql` 3. `migrate-pilot-ready.sql`
4. `migrate-rls.sql` 5. **`verify-rls.sql`（出现 `RLS FAIL` 即停）**
6. `migrate-runtime-metadata.sql` 7. `ensure-initial-user.ts`

注意：`src/server.ts` 启动时会 `autoMigrate()` 执行前三项；`migration.ts` 当前使用 `ssl: { rejectUnauthorized: false }`，建议部署侧收紧。

## Health

| 端点 | 现状 | 需要 |
|---|---|---|
| TS `/api/health` | 公开、**泄漏表名清单**、不探测 runtime | 拆分为公开 liveness + 鉴权 detail（含 runtime 探针） |
| Python `/api/health` | **无鉴权**、返回租户数量（实测 `{"tenants":0}`，`app.py:350-354`） | 加 `Depends(auth)` |

## Logging

| 项 | 现状 |
|---|---|
| TS | `console.*` 直出 |
| Python | `logsetup.py` 有轮转，落 `ROVEAGENT_ROOT` |
| 需要 | 两者统一到 stdout/stderr 采集；**审计 JSONL 必须落持久卷**（否则容器回收即丢） |

## Backup

无脚本、无演练。最低：Supabase 每日备份 + `ROVEAGENT_ROOT` 持久卷快照 + **一次恢复演练记录**。

## Monitoring

无 APM / metrics / tracing。最小集：结构化日志 + request-id 跨平面贯通 + 四个指标（TTFT、工具成功率、审批时长、failover 次数）+ 告警。

## Rollback

| 层 | 手段 | 现状 |
|---|---|---|
| 应用 | 镜像 tag 回退 | ⚠️ 无镜像（无 Dockerfile） |
| **源码** | `git revert` | ❌ **工作树未纳入版本控制**（P0-4）→ **当前无回滚能力** |
| 数据库 | Supabase 时间点恢复 | ❌ 未配置 |
| 配置 | secret 版本化 | ❌ 明文文件 |
| 运行时开关 | `RF_AGENT_FAST_PATH=0` 可在不部署的情况下关闭 Fast Path | ✅ 已具备 |

**这是 Checklist 中最严重的一项**：没有版本控制就没有回滚。**在 P0-4 解决之前，任何上线都不可逆。**

---

# 汇总：用户现在是否真的可以使用

| 能力 | 可用性 | 说明 |
|---|---|---|
| **Python Runtime 真实运行** | ✅ **已验证可运行**（本阶段首次） | 本地进程方案，无需 Docker；开发者可用，终端用户不可用（无部署路径） |
| Python Runtime 性能数据 | ✅ **已产出** | P50 12,959 ms / P95 14,062 / P99 19,949（n=31，mock LLM） |
| CI 零消费测试 | ✅ 可用 | Phase 10 交付，本阶段保持 |
| Tool Policy / Approval Contract / E2E | ✅ 可用 | Phase 9 交付 |
| 生产环境持续采集延迟 | ❌ 不能 | 埋点未进生产代码 |
| Fast Path 有效性 | ❌ 未知 | BLOCKED，无 A/B 数据 |
| `llm_first_token` 真实值 | ❌ BLOCKED | 无真实 provider |
| TS 行为级测试 | ❌ 不能 | 需 4 人日脚手架 |
| Skill 安全加固 | ❌ 不能 | 安装路径未接 scanner/permissions/sandbox |
| 生产部署 | ❌ 不能 | Docker daemon 不可达 + 无版本控制（不可回滚） |

---

# 未完成清单（按依赖排序）

| # | 事项 | 阻塞原因 | 解除条件 |
|---|---|---|---|
| 1 | TS 侧 12 阶段埋点 | 需实现计时器 + 运行中的 TS 栈 | `next` 编译通过 |
| 2 | Fast Path A/B benchmark | 同上 + 可用 LLM provider | 同上 + 真实 key |
| 3 | `llm_first_token` 真实值 | 无真实 provider | 提供一个 LLM key |
| 4 | TS 真实链路测试（A7/A8/A9/A10/P2） | 无路由级测试脚手架 | 4 人日建设 |
| 5 | Dockerfile / 部署 | daemon 不可达 | 启动 Docker Desktop |
| 6 | Skill S4（删除 `install()`） | **触发暂停条件：删除代码** | 你的授权 |

# 需要你决策才能继续的两项

1. **Skill S4 / S6**：是否授权删除 `skills/marketplace.py::install()`，以及 `skills_library/` 的保留清单（触发「删除代码」暂停条件）
2. **真实 LLM provider key**：提供后即可解锁 Task 2 的 `llm_first_token` 与 Task 3 的完整 benchmark

**本阶段未修改任何业务代码，未新增依赖，未删除任何代码。** 唯一的文件系统副作用是临时目录中的基准脚本与运行时数据根（`%TEMP%\rf-sim*`）。
