# Phase 8.1.5 Complete — Unified Capability Closure Layer

**日期**：2026-09-12
**性质**：**接线**。建立统一能力闭环，消除「模块存在但 Agent 不可达」。
**约束遵守**：`AGENT_CAPABILITIES` **一行未改**；未新增第二套 Agent 系统。
**前置**：`docs/phase8.1-plugin-execution-closure-report.md`

---

## 修改文件

| # | 文件 | 动作 |
|---|---|---|
| 1 | `roveagent/api/capability_registry.py` | **新建** —— 统一能力注册中心（任务 1） |
| 2 | `roveagent/api/capability_router.py` | **改（追加）** —— `AgentCapabilitySet`、`dynamic_toolsets`、`merged_toolsets`、`resolve_agent_capabilities`（任务 2）；补 `logger` |
| 3 | `roveagent/api/toolsets.py` | **改（真实接缝）** —— `resolve_toolsets_for_request` 并入动态 toolset；补 `logger` |
| 4 | `roveagent/api/plugin_tools.py` | **改** —— 能力发布（任务 3）；`disable()` 生命周期（任务 4）;**既有 consent 层接入** |
| 5 | `roveagent/api/capability_closure_test.py` | **新建** —— 62 测试 / 10 subtests |

**未修改**：`tools/framework.py`（gate 本体与 `DEFAULT_POLICIES`）、`AGENT_CAPABILITIES`、`PluginContext`、54 个 bundled 插件、`clisupport/plugin_capabilities.py`（既有 consent 层，**只调用不改**）。
**未新增依赖**：仅标准库（含 `threading`、`ast`）。

---

## 真实调用链

```
Agent (agent_key)
   │
   ▼
resolve_toolsets_for_request(agent_key)          api/toolsets.py            ← 真实接缝（app.py:444/492）
   │  requested = resolve_toolsets(agent_key)       静态表（未改）
   │  requested += capability_router.dynamic_toolsets(agent_key)   ← 本轮新增
   ▼
capability_router.merged_toolsets / resolve_agent_capabilities
   │
   ▼
capability_registry.CAPABILITIES                 api/capability_registry.py ← 本轮新建
   │  for_agent(agent_key) → allowed_agents 过滤
   ▼
capability_router.resolved_available_tools       工具级解析（既有）
   │
   ▼
tool registry（plugin__<plugin>__<tool> 等）
   │
   ▼
EnterpriseToolGate                               策略行（Phase 8.1 已接）
   │
   ▼
Approval → Execution → Sandbox → Audit
```

**生产调用点（实测确认）**：`api/app.py:444`（chat）、`api/app.py:492`（tools）→ `api/toolsets.resolve_toolsets_for_request` → `api/capability_router` → `api/capability_registry`。

**实测链路证据**：

```
加载前： resolve_agent_capabilities("developer").dynamic_toolsets == ()
加载后： toolsets 含 "plugin"，available_tools 含 "plugin__acme__greet"
接缝：   resolve_toolsets_for_request("developer") 返回含 "plugin"
gate：   policy_for("plugin__acme__greet") → 具名行，approval=manager
执行：   dispatch → {"greeting": "hello closure"}
disable：工具、能力、策略三者同时消失；toolset 从 agent 集合中移除
```

---

## 任务完成情况

| 任务 | 状态 | 说明 |
|---|---|---|
| **1. Capability Registry** | 完成 | 字段 `name` / `provider` / `kind` / `toolset` / `permissions` / `allowed_agents` / `risk_level` / `description` / `source`；支持 plugin / skill / media / search / builtin 五类 |
| **2. Agent Capability Resolver** | 完成 | base ∪ dynamic；`AgentCapabilitySet`；`AGENT_CAPABILITIES` 一行未改，动态能力经注册中心进入 |
| **3. Plugin Capability 接入** | 完成 | 沙箱加载成功 → 发布能力 → agent 可发现 → 可调用 → 经 gate → 审计。**端到端实测** |
| **4. Plugin 生命周期** | 完成 | R43 显式加固；R44 `disable()`：撤回策略 → 撤回能力 → 注销工具 → 停沙箱 → 审计 |

### 两条强制不变量（实现并测试，非仅文档）

1. **动态能力不能遮蔽基础工具。** 注册一个「任何 agent 现已可达」的名字会被拒。否则插件可以把自己注册成 `terminal`，继承该名字的审计与审批，却运行完全不同的代码。
   - 语义比预期更严格：`_base_tool_names()` 按**当前 registry** 解析基础 toolset，因此「注册进基础 toolset 的工具」也算基础工具。这是更正确的一读——任意两个能力都不能占用同一个名字。
2. **动态能力不授予权限。** `permissions` 是解析器的**过滤**信息，不是授权。gate 仍按策略行检查 `ToolContext.permissions`。已用 `permissions=frozenset()` 的 owner/staff 上下文测试：能力可见但调用被拒。

---

## 测试结果（全部实测，2026-09-12）

```
$ python -m pytest roveagent/api/capability_closure_test.py -q
62 passed, 10 subtests passed

$ python -m pytest roveagent -q --ignore=roveagent/skills_library
674 passed, 378 subtests passed, 1 failed
  （Phase 8.1 后为 612 passed；本阶段 +62）

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
| 1 | **Agent 能发现 plugin tool** | **通过** | `resolve_agent_capabilities("developer").available_tools` 含 `plugin__acme__greet`；**真实接缝** `resolve_toolsets_for_request` 返回含 `plugin` |
| 2 | **plugin tool 经过 Gate** | **通过** | `policy_for` 命中具名行（非 `*`）、`approval=manager`；无权限上下文被拒 |
| 3 | **disabled plugin 不可发现** | **通过** | `error="disabled via config"` 的插件候选数为 0；**且**用 `_disabled_keys` 显式加固（不依赖 PluginManager 的顺序巧合）；大小写不敏感 |
| 4 | **disable 后资源清理** | **通过** | 工具从 registry 消失、能力从注册中心消失、gate 策略为 0 行、沙箱进程停止、审计写入 `plugin_sandbox_disabled`；幂等；**禁用一个不影响另一个** |
| 5 | **plugin crash 不影响其他能力** | **通过** | `os._exit(12)` 后能力仍在、toolset 仍在 agent 集合中；其他插件不受影响 |
| 6 | **54 bundled 插件回归** | **通过** | 真实 `PluginManager`：48 enabled、>40 总数；**且断言 bundled 插件未泄漏进动态能力注册中心** |

**另覆盖**：capability 模型的 provider 格式与 kind 一致性校验、空名/空 provider 拒绝、受限能力的可见性（含**未知 agent 只看不受限能力**）、注册幂等与冲突、按 provider 批量撤回、generation、能力无工具时被正确过滤（不向 agent 提供空 toolset）、注册表损坏时只损失动态半边、**`AGENT_CAPABILITIES` 未被修改**、基础工具未被移除。

---

## 本阶段修掉的 4 个缺陷

| # | 缺陷 | 严重性 | 说明 |
|---|---|---|---|
| **1** | **沙箱路径绕过既有 consent 层** | **高** | 发现 `clisupport/plugin_capabilities.py`（既有，14.7KB，含 `plugin_capability_granted` / `record_consent`）。我的加载器**完全不检查它** —— 一个声明 `roveagent.tools.override`（可替换内建工具）却未获同意的社区插件，会被沙箱加载并**对 agent 可见**。**沙箱限制了插件能碰到什么，但不等于同意可以省略。** 已接入（不可用时 fail-closed） |
| **2** | **`logger` 未定义 —— 第三次同类 bug** | 中 | `capability_router.py` 用了 `logger` 但模块没定义。`NameError` 会被我自己的 `except Exception` 吞掉 → 动态合并**静默永不生效**。前两次：`plugin_tools` 缺 `Path`（21 个测试以误导性症状失败）、`toolsets` 缺 `logger`（读代码时发现） |
| **3** | `toolsets.py` 缺 `logger` | 中 | 同上，自查发现 |
| **4** | 我的测试不真实 | 低 | 只注册 capability 未注册真实工具 → 被 `filter_unavailable` 正确过滤掉（**这正是它该做的**）。修测试以反映真实加载器的两半 |

### 针对第 2 项的**系统性修复**

同一类 bug 发生三次，都是「新增代码引用了模块未绑定的名字，且被自己的兜底 `except` 吞掉」。因此新增两项守卫：

1. **`test_the_merge_is_not_silently_disabled_by_a_swallowed_error`** —— 把 seam 的 logger 换成「任何访问都抛错」的对象。若有 wiring 错误被吞掉，该测试失败。**它当场抓出了第 2 个缺陷。**
2. **`UndefinedNameGuardTest`** —— 用 `ast` 静态扫描 `api/` 下每个模块：若引用 `logger.` 但从未绑定 `logger` 即失败。动态测试只能覆盖恰好执行到的那条分支，静态检查覆盖全部。

---

## 剩余风险

| # | 风险 | 状态 | 说明 |
|---|---|---|---|
| **R45** | 插件工具未进任何 agent 能力画像 | **已闭合** | 能力注册中心 + `resolve_toolsets_for_request` 合并已接；实测 agent 可发现 |
| **R43** | `plugins.enabled` 未参与沙箱加载 | **已闭合** | 加载器显式检查 disabled 列表（不依赖 PluginManager 顺序） |
| **R44** | 无卸载入口 | **机制已闭合，调用点仍缺** | `disable()` 完整实现并测试（5 步 + 审计）；但**生产链路上仍无调用方** —— 插件卸载/禁用流程尚未调用它。这是本轮同类问题的残留，我明说 |
| **新增 R46** | **媒体/搜索/技能三类能力未接入注册中心** | 新 | 本轮只接了 plugin 一类。`CapabilityKind` 已备 MEDIA/SEARCH/SKILL，注册中心与解析器对来源无感知，因此接入是**数据注册**而非改代码 —— 但确实**尚未做** |
| **新增 R47** | **`allowed_agents` 无配置入口** | 新 | 插件能力默认对所有 agent 可见（`allowed_agents=()`）。限制受众需要部署侧配置，目前只能改代码 |
| **新增 R48** | **能力注册中心无持久化/无跨进程共享** | 新（设计如此） | 进程内单例：它描述的是本进程注册的工具，持久化会描述重启后不存在的状态。多 worker 部署下每个 worker 需各自加载插件 |
| **R42** | trust 字段未进 `PluginManifest` | 缓解未消除 | 未变 |
| **R19** | 真实第三方插件数仍为 0 | 未变 | 全部验证使用合成插件 |
| **R37/R38/R40** | 容器未验证 / 进程隔离无文件系统与网络约束 / 无权限授予 UI | 未变 | — |
| R31–R36 | 见 Phase 7 报告 | 未变 | — |

---

## Confidence & gaps

**高置信（本机实测，可复现）**
- 62 passed / 10 subtests；全量 674 passed / 378 subtests
- 端到端：加载 → 能力 → **真实接缝** → gate 具名行 → 沙箱执行 → 结果
- disable 五步全部生效且幂等；禁用一个不影响另一个
- bundled 54 插件回归（48 enabled）且**未泄漏进动态能力注册中心**
- `AGENT_CAPABILITIES` 未被修改（有测试断言快照不变）
- 新增的两项守卫（吞错检测 + 静态未定义名扫描）各自**当场抓到过真实缺陷**
- `tsc` exit 0；TS 73/73；0 遗留进程

**中置信**
- consent 接入经 mock 验证（授予/未授予/层不可用三种），但**未在真实第三方插件上跑过同意流程**（无真实插件、无 consent UI 交互）
- 静态扫描只查 `logger`；同一类问题（引用未绑定名）在其他名字上仍可能出现 —— 覆盖面有限，但堵住了已发生三次的那个

**未验证（明确缺口）**
- **媒体 / 搜索 / 技能能力接入**：零（R46）。注册中心与解析器对来源无感知，接入是注册数据，但未做
- **`disable()` 的生产调用点**：零（R44 残留）
- **真实第三方插件的完整流程**：安装 → 同意 → 沙箱加载 → agent 调用 → 禁用（R19）
- **多 worker 部署**：进程内单例，未验证多进程一致性（R48）
- **`allowed_agents` 的受众限制**：仅单元测试验证，无部署配置入口（R47）
- **容器与 Linux 行为**：未验证（无引擎；本机 Windows）
