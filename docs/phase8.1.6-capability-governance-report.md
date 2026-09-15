# Phase 8.1.6 Complete — Capability Governance

**日期**：2026-09-12
**性质**：**接线与治理**。R46 / R47 / R44 / R48。
**约束遵守**：未修改 `EnterpriseToolGate` 核心逻辑；未新增 Agent 系统。
**前置**：`docs/phase8.1.5-capability-closure-report.md`

---

## 修改文件

| # | 文件 | 动作 |
|---|---|---|
| 1 | `roveagent/api/capability_providers.py` | **新建** —— `CapabilityProvider` 接口 + 6 个 Provider + `ProviderRegistry` + `rebuild_capabilities()` |
| 2 | `roveagent/api/capability_registry.py` | **改** —— `allowed_agents` 改 **deny-by-default**；新增 `SOCIAL`/`MCP` kind；base-tool 解析重写（性能 + 正确性） |
| 3 | `roveagent/api/plugin_trust.py` | **改** —— 新增 `capability:` 块解析（`CapabilityDeclaration`） |
| 4 | `roveagent/api/plugin_tools.py` | **改** —— 能力发布按声明受众；`PluginLifecycleManager`（权限检查 + disable）；`ensure_capabilities_built()` |
| 5 | `roveagent/api/capability_governance_test.py` | **新建** —— 60 测试 / 29 subtests |
| 6 | `roveagent/api/capability_closure_test.py` | **改** —— 对齐新语义（空受众改为 deny） |

**未修改**：`tools/framework.py`、`AGENT_CAPABILITIES`、`PluginContext`、`clisupport/plugin_capabilities.py`（既有 consent 层，只调用）。
**未新增依赖**：仅标准库。

---

## 真实调用链

```
Agent (agent_key)
   │
   ▼
resolve_toolsets_for_request                 api/toolsets.py          ← 真实接缝（app.py:444/492）
   │  + dynamic_toolsets(agent_key)
   ▼
capability_router → capability_registry      CAPABILITIES
   ▲                    │
   │                    │ visible_to(agent)  ← deny-by-default
   │                    ▲
   │        ┌───────────┴────────────────────────────┐
   │        │            ProviderRegistry            │
   │        │  search:web   media:registry           │
   │        │  skill:bundle plugin:<name>            │
   │        │  social:gateway  mcp:servers           │
   │        └───────────┬────────────────────────────┘
   │                    │ rebuild_capabilities()
   │                    │   ▲ ensure_capabilities_built()   ← 启动重建（R48）
   │                    │
   │        PluginLifecycleManager.disable(role=…)  ← 权限检查（R44）
   │                    │
   ▼                    ▼
tool registry → EnterpriseToolGate → Approval → Sandbox → Audit
```

**实测的启动重建输出**：

```
providers: 3 | capabilities: 73
  media:registry     published=0   already_base=3   audience=ceo,operations,marketing
  search:web         published=0   already_base=2   audience=*
  skill:bundle       published=73  already_base=0   audience=(deny)
```

---

## 任务完成情况

| 任务 | 状态 | 说明 |
|---|---|---|
| **1. Capability Provider Interface** | 完成 | 6 个 Provider：Plugin / Skill / Media / Search / Social / MCP。既有注册表被**适配**而非复制 |
| **2. Capability Manifest** | 完成 | `capability: {tools, allowed_agents, risk_level}`；**默认 deny**；`["*"]` 为显式通配 |
| **3. Plugin Lifecycle Manager** | 完成 | 权限检查 → 撤回策略 → 撤回能力 → 注销工具 → 停沙箱 → 审计；拒绝也审计 |
| **4. Startup Capability Rebuild** | 完成 | `ensure_capabilities_built()`；`reset=True` 先清空，重建结果**只反映来源、不继承残留** |

### R46 的**修正结论**（重要）

实测发现：`image_generate` / `video_generate` / `text_to_speech` / `web_search` / `web_extract` **本来就在基础能力表里**，agent 已可达（经 `safe`/`media`/`search` toolset）。我的反遮蔽守卫正确地拒绝了它们。

因此 **R46 的原判断需要修正**：
- **Media/Search 的「工具」never was a gap** —— 它们早已可达。
- Phase 4 里「Media Hub 没人调用」指的是 **facade（`media_hub.py`）** —— 那是**刻意不面向 agent 的服务层接口**。两件事。

Provider 接口因此把「已被基础表提供」识别为 **`already_base_provided`**（预期且良性），与真正冲突区分开 —— 而不是反复尝试注册并报冲突。

### R47 的语义变更（**收紧**，不触发暂停条件）

`allowed_agents=()` 从「所有人」改为「**无人**」。空 = deny，`["*"]` = 显式通配。

理由正如你所述：财务插件不该给 marketing agent。这个变更**打破了 16 个 Phase 8.1.5 测试** —— 那正是变更在生效（旧测试假设空=全部）。已对齐，并在 governance 测试中完整锁定新语义。

---

## 测试结果（全部实测，2026-09-12）

```
$ python -m pytest roveagent/api/capability_governance_test.py -q
60 passed, 29 subtests passed

$ python -m pytest roveagent/api/capability_closure_test.py \
                   roveagent/api/capability_governance_test.py -q
124 passed, 39 subtests passed

$ python -m pytest roveagent -q --ignore=roveagent/skills_library
736 passed, 407 subtests passed, 1 failed in 187.44s
  （Phase 8.1.5 后为 674 passed；本阶段 +62）

$ pnpm exec tsc -p tsconfig.json --noEmit
exit 0

$ pnpm exec tsx --test tests/{roveagent-stream-contract,...}.test.ts
tests 73  pass 73  fail 0
```

唯一失败为既有（`roveagent-achievements` 读不存在的构建产物）。

### 你要求的 6 项验证

| # | 要求 | 结果 | 证据 |
|---|---|---|---|
| 1 | **plugin capability 只给指定 agent** | **通过** | `allowed_agents: ["developer"]` → developer 的 toolset 含 `plugin`；`["developer","marketing"]` → 两者都含；`["*"]` → 全员含 |
| 2 | **未授权 agent 不可发现** | **通过** | marketing/ceo/operations/devops 的 toolset **均不含** `plugin`；**无受众声明时对所有人不可见**（含 developer） |
| 3 | **disable 后能力消失** | **通过** | 工具从 registry 消失、能力从注册中心消失、gate 策略归零；**且所有 agent 的 toolset 中 `plugin` 一并消失** |
| 4 | **sandbox 回收** | **通过** | 预热进程后 disable → 进程停止；`sandbox_stopped=True` |
| 5 | **restart 后 registry 恢复** | **通过** | 清空注册中心 → `ensure_capabilities_built(force=True)` → 数量与清空前一致；无 force 时只建一次 |
| 6 | **bundled plugin 保持** | **通过** | 真实 `PluginManager`：>40 总数、>10 enabled；**bundled 插件未成为动态能力**；重建**不移除** developer 的 `read_file`/`write_file`/`terminal`；`AGENT_CAPABILITIES` 快照不变 |

**另覆盖**：Provider 契约（发布/撤回/只撤自己的/一个 Provider 抛错不影响其他/重复 id 被拒/无 id 被拒）、重建是重置而非累积、`already_base_provided` 与 `published` 分离、6 个真实 Provider 各自的行为（含 MCP 空注册、Social deny、Skill deny）、生命周期权限阶梯（owner/admin 可、manager 及以下不可）、**未授权 disable 不改动任何状态**、被拒 disable 写入审计、`can_disable` 边界。

---

## 本阶段修掉的 7 个缺陷

| # | 缺陷 | 严重性 | 说明 |
|---|---|---|---|
| **1** | **为修性能而静默关掉了安全守卫** | **高** | 我重写 base-tool 解析为 O(1) 时读了**不存在的属性** `registry._entries` → 返回空集 → **`read_file` 这类真实基础工具被当作新能力接受**。这是反遮蔽守卫**静默失效**的安全回归，且没有任何异常。**是我主动验证（而非相信「0.107s」这个数字）才抓到的。** 已修并重新验证：6/6 真实基础工具被拒 |
| **2** | **我对 base tool 来源的模型本身就是错的** | **高** | 实测：`read_file` **根本不在 registry 里** —— 基础工具主要来自 **`TOOLSETS` 静态声明**。只走 registry 必然漏掉大部分。正确实现：**声明部分（静态、缓存一次）∪ registry 自有部分** |
| **3** | **Provider 重建耗时 94.6 秒** | **中** | `CapabilityRegistry.register()` 对**每个** capability 重算一次 base 集（5 agent × 多 toolset 实时解析）。修法：① Provider 每批只算一次；② 静态部分永久缓存。**3.0–6.7s → 0.017s**（约 200–400 倍），重建 94.6s → 4.5s，二次重建 0.02s |
| **4** | **`can_disable` 规则定错** | **中** | `REQUIRED_ROLE="owner"` 加上 gate 的「必须严格高一级」语义 → **只有 admin 能禁用**，租户 owner **装得下拆不掉**。改为 `manager`：owner/admin 可，manager 及以下不可 |
| **5** | **R47 语义变更打破 16 个旧测试** | 预期 | 这正是变更在生效。已对齐，并在 governance 测试中锁定新语义 |
| **6** | `CapabilityKind` 缺 `SOCIAL`/`MCP` | 低 | 我最初写了 `hasattr` 兜底，改为正式的枚举成员 |
| **7** | 两处测试 fixture bug | 低 | YAML 里未加引号的 `[*]` 是**别名语法**而非字符串列表；`["a,b"]` 是**一个**名为 "a,b" 的 agent 而非两个 —— 两者都静默降级为 deny，看起来像治理失效但其实是夹具问题 |

---

## 剩余风险

| # | 风险 | 状态 | 说明 |
|---|---|---|---|
| **R46** | Media/Search/Skill 未接入 | **已闭合（结论修正）** | 三个 Provider 已建并接入。**Media/Search 的工具本就可达**（`already_base_provided`）；Skill 的 73 项已注册但因无受众声明而不可见 —— **这正是应有的状态** |
| **R47** | `allowed_agents` 无入口 | **已闭合** | `capability:` manifest 块 + 默认 deny |
| **R44** | disable 无调用点 | **已闭合** | `PluginLifecycleManager.disable(role=…)` 含权限检查。**但仍无 HTTP/UI 入口** —— 有调用 API，没有路由 |
| **R48** | 多 worker | **已闭合（按你的判断）** | 进程内注册中心保留；新增 `ensure_capabilities_built()` 启动重建，**不依赖运行时残留** |
| **新增 R49** | **`ensure_capabilities_built()` 无生产调用点** | 新 | 函数实现并测试，但**尚无 app 启动钩子调用它**。这是本轮同类问题的又一次残留，我明说 |
| **新增 R50** | **Skill Provider 发布 73 个能力但全部不可见** | 新（设计如此） | `skills/marketplace.py` 的 SKILL.md 没有受众声明机制 → 全部 deny。Skill 收敛（Phase 8.2）需为它设计受众声明 |
| **新增 R51** | **`media_hub.py` facade 仍无调用方** | 新（既有） | Phase 4 的 facade 依旧不可达。它**刻意不面向 agent**；若确认不需要，应删除或标注为预留 |
| **R42** | trust 字段未进 `PluginManifest` | 缓解未消除 | 未变 |
| **R19** | 真实第三方插件数仍为 0 | 未变 | 全部验证使用合成插件 |
| **R37/R38/R40** | 容器未验证 / 进程隔离无文件系统与网络约束 / 无权限授予 UI | 未变 | — |
| R31–R36 | 见 Phase 7 报告 | 未变 | — |

---

## Confidence & gaps

**高置信（本机实测，可复现）**
- 60 passed / 29 subtests；两套能力测试 124 passed；全量 736 passed / 407 subtests
- 端到端受众控制：指定 agent 可见、未指定 agent 不可见、无声明对所有人不可见
- disable 五步全生效（含所有 agent 的 toolset 中 `plugin` 消失）+ 沙箱进程回收 + 审计
- 启动重建：清空后可完整恢复；无 force 只建一次；不继承残留
- bundled 回归：>40 插件、>10 enabled、未成为动态能力、base 工具未被移除、`AGENT_CAPABILITIES` 不变
- **反遮蔽守卫拒绝 6/6 真实基础工具**（含 `read_file`）—— 这是我修坏了又修好并**重新验证**的那条
- base-tool 解析 **0.017s**（原 3.0–6.7s）；`tsc` exit 0；TS 73/73

**中置信**
- 6 个 Provider 中，Search/Media/Skill 对**真实注册表**验证；Social/MCP 只有单元测试（无真实服务器/网关）
- 重建耗时 4.5s 主要花在 Search Provider 的 `_ensure_web_plugins_loaded()`（触发插件发现）。未做进一步优化，因为它只在启动发生一次

**未验证（明确缺口）**
- **`ensure_capabilities_built()` 的生产调用点**：零（R49）
- **HTTP/UI 入口**：disable 与受众配置均无路由（R44 残留）
- **真实第三方插件的完整流程**：安装 → 同意 → 受众声明 → 沙箱加载 → agent 调用 → 禁用（R19）
- **多 worker 一致性**：启动重建已实现，但未在多进程部署下验证
- **Skill 受众声明机制**：不存在（R50），Phase 8.2 需设计
- **容器与 Linux 行为**：未验证
