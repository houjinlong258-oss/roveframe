# Phase 8.1.7 Complete — Capability Runtime Bootstrap

**日期**：2026-09-12
**性质**：**接线**。R49 闭合。
**约束遵守**：未修改 `EnterpriseToolGate` 核心逻辑；未新增 Agent 系统；**未引入 Redis**。
**前置**：`docs/phase8.1.6-capability-governance-report.md`

---

## 修改文件

| # | 文件 | 动作 |
|---|---|---|
| 1 | `roveagent/api/capability_providers.py` | **改** —— `ProviderTier` / `ProviderUnavailable` / `preflight()`；`CoreToolsProvider`；`bootstrap_capabilities()`；`CapabilitySnapshot` 接口；`capability_health()`；`ensure_capability_bootstrap()` |
| 2 | `roveagent/api/app.py` | **改** —— `create_app()` 内同步调用 bootstrap；新增 `/api/capabilities/health` 与 `/api/capabilities/rebuild` |
| 3 | `roveagent/api/capability_bootstrap_test.py` | **新建** —— 39 测试 / 5 subtests |

**未修改**：`tools/framework.py`、`AGENT_CAPABILITIES`、`capability_registry.py` 的判定语义、`clisupport/*`。
**未新增依赖**：仅标准库（`enum` / `abc` / `json` / `threading` / `time` / `uuid`）。

---

## 真实调用链

```
uvicorn → create_app()                         api/app.py:306
              │
              ▼
    ensure_capability_bootstrap()              ← 同步执行，首个请求前已完成
              │
              ▼
    bootstrap_capabilities()
              │
       ┌──────┴───────┐
       │ 1. preflight │  每个 provider 先全部预检
       └──────┬───────┘
              │  critical 失败 → raise ProviderUnavailable（应用起不来）
              │  optional 失败 → 记录 degraded，继续
              ▼
       ┌──────────────┐
       │ 2. build()   │  ProviderRegistry → CapabilityRegistry（reset=True）
       └──────┬───────┘
              │  critical 列举失败 → 同样 raise（见「修掉的缺陷 2」）
              ▼
       ┌──────────────┐
       │ 3. snapshot  │  CapabilitySnapshot.publish()（失败不阻断启动）
       └──────┬───────┘
              ▼
        status: ready | degraded
              │
              ▼
   GET /api/capabilities/health     ← 报告**实际已加载**的内容
   POST /api/capabilities/rebuild   ← 走同一条 bootstrap 路径
```

**实测**：

```
create_app: 5.35s
capability routes: ['/api/capabilities/health', '/api/capabilities/rebuild']
caps BEFORE any request: 73
health: status=ready ready=True caps=73
  builtin:core       tier=critical  published=0
  media:registry     tier=optional  published=0
  search:web         tier=optional  published=0
  skill:bundle       tier=optional  published=73
snapshot: {'kind': 'InMemoryCapabilitySnapshot', 'worker_id': '43948-2b62f7', 'workers': 1}
```

---

## 任务完成情况

| 任务 | 状态 | 说明 |
|---|---|---|
| **1. Startup Bootstrap** | 完成 | `create_app()` 内**同步**构建。**刻意不做惰性初始化** —— 那会把构建成本与任何关键失败塞进用户的第一个请求，用户看到的是超时或空工具集而非启动错误 |
| **2. Provider 失败隔离** | 完成 | `CRITICAL`（`builtin:core`、`plugin:*`）失败 → raise；`OPTIONAL`（media / search / skill / social / mcp）失败 → degraded，照常启动。**默认 OPTIONAL**，成为致命项需显式声明，新 provider 不会因遗漏而变成启动阻断 |
| **3. Capability Health API** | 完成 | `GET /api/capabilities/health`：provider 状态与分级、能力数量、ready / degraded、按 kind 分布、snapshot 描述 |
| **4. Capability Snapshot 接口** | 完成 | `CapabilitySnapshot` 抽象（`publish` / `read_all`）+ `InMemoryCapabilitySnapshot` 默认实现。**接口 only，无传输、无 Redis** |

### 设计要点

**失败分级为什么是这条线**：一个因为 media backend 未配置就拒绝启动的运行时不可用；而一个核心能力层坏掉却照常启动的运行时更糟 —— 它会以「无工具、无报错」的方式服务每个请求。`CoreToolsProvider` 因此**不发布能力**（核心工具本就经基础 toolset 可达，发布它们会被反遮蔽守卫拒绝），它的贡献是**启动断言**。

**为什么两次检查而不是一次**：`preflight()` 在**任何东西被发布之前**对全部 provider 跑完，所以关键失败不会留下半建成的注册中心 —— 运行时要么拥有完整能力层，要么不启动。

---

## 测试结果（全部实测，2026-09-12）

```
$ python -m pytest roveagent/api/capability_bootstrap_test.py -q
39 passed, 5 subtests passed

$ python -m pytest roveagent -q --ignore=roveagent/skills_library
775 passed, 412 subtests passed, 1 failed in 110.23s
  （Phase 8.1.6 后为 736 passed；本阶段 +39）

$ pnpm exec tsc -p tsconfig.json --noEmit
exit 0

$ pnpm exec tsx --test tests/{roveagent-stream-contract,...}.test.ts
tests 73  pass 73  fail 0

$ 遗留沙箱进程
0
```

唯一失败为既有（`roveagent-achievements` 读不存在的构建产物）。

### 你要求的 6 项验证

| # | 要求 | 结果 | 证据 |
|---|---|---|---|
| 1 | **启动自动 build** | **通过** | `create_app()` 后注册中心 0 → 73；无任何请求发生 |
| 2 | **首次请求前 registry 已存在** | **通过** | 断言 `CAPABILITIES.all()` 非空**在 create_app 之后、任何请求之前**；`ensure_capability_bootstrap` 非 force 时返回同一对象（不惰性） |
| 3 | **optional provider 失败系统正常启动** | **通过** | media preflight 失败 → `status=degraded`、`ready=False`、写入 `degraded` 列表；**健康的 provider 照常发布** |
| 4 | **critical provider 失败启动失败** | **通过** | preflight 失败 → raise 且消息含 provider 与 "critical"；**列举失败同样 raise**；**失败后注册中心为空**（无半成品） |
| 5 | **health 接口正确** | **通过** | 未构建时报 `unbuilt` 而非健康；总数与注册中心一致；**critical provider 的分级正确显示为 `critical`**（见缺陷 1）；degraded 如实上报；JSON 安全 |
| 6 | **bundled plugins 回归** | **通过** | >40 插件、>10 enabled；bootstrap 前后不变；**不饿死任何 agent**（每 agent ≥1 工具）；`AGENT_CAPABILITIES` 快照不变 |

**另覆盖**：`preflight` 默认 no-op；`CoreToolsProvider` 不发布能力、分级为 critical、三种失败条件各自触发；`MINIMUM_TOTAL_BASE_TOOLS` 下限生效；快照 publish 覆盖而非追加；**快照失败不阻断启动**；**源码级断言无 redis 依赖**。

---

## 本阶段修掉的 4 个缺陷

| # | 缺陷 | 严重性 | 说明 |
|---|---|---|---|
| **1** | **health 把 CRITICAL provider 误报为 OPTIONAL** | **中** | `describe()` 未输出 `tier`，读取端只能落到默认值 → health 会**低估哪些失败原本会阻断启动**。修法：`describe()` 输出真实分级 |
| **2** | **CRITICAL provider 的「列举失败」不致命** | **中** | 只有 `preflight()` 被分级；`build()` 把逐 provider 异常**记录为 error 而不抛** → 一个关键 provider 可以**悄无声息地失败**，运行时报 ready 而能力缺失。修法：bootstrap 检查 `build()` 结果的 error 并按 tier 抛错 |
| **3** | **直接调用 `bootstrap_capabilities()` 会让 health 变陈旧** | **中** | `_LAST_BOOTSTRAP` 只在 `ensure_capability_bootstrap()` 里写 → rebuild 路由若直接调原语，health 会报告上一次的旧状态。修法：改在原语内部记录 |
| **4** | **我的预检阈值会在健康系统上误报** | **中** | 首版 `MINIMUM_TOOLS = 5`，在 `devops` 上触发 —— 而 `devops=3` **是正确的**：它的 `docker_read`/`monitoring` 是**纯组合 toolset**（只 `include: terminal`），不新增工具。**一个在健康系统上误报的阈值，会让运维学会忽略它，比没有阈值更糟。** 改为「每 agent ≥1」+「基础工具总数 ≥10」（实测 30，宽裕） |

第 4 条值得强调：它是我在实现过程中**自己的检查误报了健康系统**，而不是被测代码有问题。阈值必须只对真正的损坏触发。

---

## 剩余风险

| # | 风险 | 状态 | 说明 |
|---|---|---|---|
| **R49** | bootstrap 无生产调用点 | **已闭合** | `create_app()` 内同步调用；health 与 rebuild 路由已注册 |
| **新增 R52** | **`create_app()` 增加约 5.3 秒启动成本** | 新 | bootstrap 是同步的（你的要求：不做惰性初始化）。5.3s 主要来自 `search:web` 的 `_ensure_web_plugins_loaded()`（触发插件发现）。**这是可接受的启动成本，但它是一个真实的启动延迟**，多 worker 部署下每个 worker 都付 |
| **新增 R53** | **`/api/capabilities/*` 只有 `auth`（服务密钥）鉴权** | 新 | 与其他 `/api/plugins/*` 一致，但 health 暴露 provider 拓扑与工具计数。若前端需要展示，应加角色级鉴权 |
| **新增 R54** | **Snapshot 接口未接任何传输** | 新（设计如此） | 按你的要求「只设计 interface」。多 worker 一致**未实现**，`read_all()` 只返回本进程 |
| **R44 残留** | disable 有 API 无 HTTP 路由 | 未变 | 生命周期管理器实现并测试，仍无路由入口 |
| **R50** | Skill 的 73 项能力受众全 deny | 未变 | `skills/marketplace.py` 无受众声明机制 → Phase 8.2 需设计 |
| **R51** | `media_hub.py` facade 无调用方 | 未变 | 刻意不面向 agent；应删除或标注预留 |
| **R42** | trust 字段未进 `PluginManifest` | 缓解未消除 | 未变 |
| **R19** | 真实第三方插件数仍为 0 | 未变 | 全部验证使用合成插件 |
| **R37/R38/R40** | 容器未验证 / 进程隔离无文件系统与网络约束 / 无权限授予 UI | 未变 | — |
| R31–R36 | 见 Phase 7 报告 | 未变 | — |

---

## Confidence & gaps

**高置信（本机实测，可复现）**
- 39 passed / 5 subtests；全量 775 passed / 412 subtests
- `create_app()` 后注册中心 0 → 73，**在任何请求之前**
- critical 失败 → raise 且注册中心为空；optional 失败 → degraded 且健康 provider 照常发布
- health 正确显示 critical/optional 分级、`unbuilt` 状态、degraded 列表
- 快照 publish 覆盖式；快照失败不影响启动；**无 redis 依赖**（源码级断言）
- bundled 回归：>40 插件、不饿死 agent、基础表不变
- `tsc` exit 0；TS 73/73；0 遗留进程

**中置信**
- 5.3 秒启动成本以一次测量为准，未做多次取样或多 worker 场景测量
- `CoreToolsProvider` 的三种失败条件经 mock 验证；未在真实「工具集声明缺失」场景下端到端触发

**未验证（明确缺口）**
- **多 worker 一致性**：Snapshot 只有接口与进程内实现（R54，按你的要求）
- **`/api/capabilities/rebuild` 的真实 HTTP 调用**：路由已注册、逻辑与启动同路径，但未发真实请求验证（需服务运行 + 密钥）
- **`create_app()` 在真实 uvicorn 启动路径下**的行为：验证方式是直接调用 `create_app()`，未验证 uvicorn 的 worker 生命周期
- **前端消费 health**：无 UI
- **容器与 Linux 行为**：未验证
