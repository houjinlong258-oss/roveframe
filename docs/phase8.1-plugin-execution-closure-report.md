# Phase 8.1 Complete — Plugin Execution Closure

**日期**：2026-09-12
**性质**：**接线**，非新增能力。R39 + R41 闭合。
**约束遵守**：未修改 `EnterpriseToolGate` 核心逻辑、未重构 `PluginManager`、未新增平行模块。
**前置**：`docs/phase3.5-plugin-trust-report.md`

---

## 修改文件

| # | 文件 | 动作 |
|---|---|---|
| 1 | `roveagent/api/plugin_tools.py` | **改** —— 新增 `GatePolicyRegistry`（+ `PLUGIN_GATE_POLICIES` 单例）、`SandboxPluginLoader`、`resolve_plugin_manifest`；修正 `Path` 缺失导入、策略排序、bridge 引用保留 |
| 2 | `roveagent/enterprise/gate_hook.py` | **改（2 处）** —— `get_gate()` 与 `install_enterprise_gate()` 前置插件策略包 |
| 3 | `roveagent/clisupport/plugins.py` | **改（1 处调用 + 1 个包装）** —— `_ensure_plugins_discovered()` 后调用沙箱加载 |
| 4 | `roveagent/api/plugin_isolation.py` | **改** —— 新增 `_invalidate()`，在三条崩溃路径上确定性失效句柄 |
| 5 | `roveagent/api/plugin_trust.py` | **改** —— 导出共享常量 `TRUST_REFUSAL_PREFIX` |
| 6 | `roveagent/api/plugin_integration_test.py` | **新建** —— 31 测试 / 3 subtests |
| 7 | `roveagent/api/plugin_isolation_test.py` | **改** —— 两处断言对齐修正后的崩溃语义 |

**未修改**：`tools/framework.py`（`EnterpriseToolGate` 本体与 `DEFAULT_POLICIES`）、`PluginContext`、`PluginManifest` 定义、54 个 bundled 插件。
**未新增依赖**：仅标准库。

---

## 真实调用链

```
Community Plugin (plugin.yaml)
        │
        ▼
PluginManager.discover_and_load()
        │  ├─ official  → import 进主进程（与 Phase 3.5 前完全一致）
        │  └─ community → 记录 "refused in-process load: ..."  ← Phase 3.5
        ▼
_ensure_plugins_discovered()                        clisupport/plugins.py:7108   ← 本轮新增
        │
        ▼
_load_community_plugins_into_sandbox(manager)       clisupport/plugins.py:7112   ← 本轮新增
        │
        ▼
SandboxPluginLoader.load_all(manager)               api/plugin_tools.py:506      ← 本轮新增
        │  · 从「拒绝记录」反查候选（TRUST_REFUSAL_PREFIX）
        │  · assess_trust(合并盘上 manifest 与对象)
        ▼
register_plugin_tools()  ──┬──► Tool Registry        (toolset "plugin")
        │                  │
        │                  └──► GatePolicyRegistry.publish()   api/plugin_tools.py:478  ← R39
        ▼
PluginToolBridge  →  PluginSandboxProcess  →  MCP Boundary (JSON-RPC/stdio)  →  子进程
                                                    ▲
EnterpriseToolGate.policy_for("plugin__acme__greet") │   enterprise/gate_hook.py:62  ← R39
        │  策略行：comms 级 manager/owner，按 sandbox policy 升级
        ▼
Approval  →  Execution  →  Audit
```

**实测的链路证据**（真实子进程 + 真实 gate）：

```
rows before load: 26 | plugin rows: 0
loader result   : {'candidates': 1, 'loaded': 1, 'failed': 0}
rows after load : 27 | plugin rows: 1
plugin row matched: plugin__acme__greet | approval: manager | risk: 1
dispatch        : {"g": "closure"}
```

**主进程隔离实测**：加载后 `sys.modules` 中不出现任何插件模块（测试直接断言）。

---

## 测试结果（全部实测，2026-09-12）

```
$ python -m pytest roveagent/api/plugin_integration_test.py -q
31 passed, 3 subtests passed

$ python -m pytest roveagent/api/plugin_isolation_test.py \
                   roveagent/api/plugin_trust_test.py \
                   roveagent/api/plugin_integration_test.py -q
175 passed, 11 subtests passed

$ python -m pytest roveagent -q --ignore=roveagent/skills_library
612 passed, 368 subtests passed, 1 failed
  （Phase 3.5 后为 580 passed；本阶段 +32）

$ pnpm exec tsc -p tsconfig.json --noEmit
exit 0

$ pnpm exec tsx --test tests/{roveagent-stream-contract,...}.test.ts
tests 73  pass 73  fail 0

$ 遗留沙箱进程
0
```

唯一失败 `roveagent-achievements/.../test_dashboard_card_hover_...` 为既有（读不存在的构建产物 `dashboard/dist/style.css`）。

### 你要求的 4 项验证

| # | 要求 | 结果 | 证据 |
|---|---|---|---|
| 1 | **community plugin 执行成功** | **通过** | 真实子进程：`dispatch('plugin__acme__greet', {'name':'RoveFrame'})` → `{"greeting":"hello RoveFrame"}`；重复调用复用同一进程 |
| 2 | **plugin tool 经过 Gate** | **通过** | `get_gate()` 命中具名行 `plugin__acme__greet`（`pattern != "*"`）；未加载时该工具解析到 `*`/`none`，加载后不再是 —— **R39 的失败模式有反向测试** |
| 3 | **approval 生效** | **通过** | `staff` → `requires_approval=True`；`owner` → 允许；声明 `network: true` 的插件对 `manager` 也要求 **owner**；无权限时在审批前即被拒；审批决策写入审计 sink |
| 4 | **sandbox crash 不影响 Runtime** | **通过** | 插件 `os._exit(11)` → 结构化 JSON 错误；注册表仍持有该工具；**随后同一插件的正常工具调用成功**（恢复是确定性的） |

**另覆盖**：`official` 插件不被沙箱加载器接管（保持原路径）；一个坏插件不阻断其它插件；无可信工具的插件记录为已加载；不可满足的策略被拒；策略行按 pattern 全局排序（优先级不依赖加载顺序）；无工具时 `register_plugin_tools` 拒绝；调用方策略包不挤掉插件行；`plugin_tools` 模块损坏时 gate 仍能构造、发现仍能完成（bundled 照常加载）；`_ensure_plugins_discovered` 调用沙箱加载器（调用断言）。

---

## 本阶段修掉的 6 个缺陷

| # | 缺陷 | 严重性 | 说明 |
|---|---|---|---|
| **1** | **崩溃恢复是竞态，且会永久毒化 bridge** | **高** | 插件 `os._exit` 后，Windows 上 `poll()` 仍可能返回 `None` → `running` 读作 True → 下一次调用复用**已死句柄**写入断管（`OSError [Errno 22]`）→ 该插件此后永久不可用。我在 Phase 3 的测试里**已经发现回收是异步的**（当时加了有界等待），但**没把结论用到 bridge 上**。修法：三条崩溃路径上调用 `_invalidate()` 确定性失效，不再依赖 OS 回收时机 |
| **2** | **R42 实际发作：插件自己的 `sandbox:` 块被完全忽略** | **高** | `PluginManifest` 数据类**没有 `sandbox` 字段**，而加载器把该对象传给 `register_plugin_tools` → 只读对象属性 → 盘上 `plugin.yaml` 的 `sandbox:` 从未生效。声明 `network: true` 的插件会按「什么都没要求」注册；`filesystem: whatever` 也不会被拒。修法：`resolve_plugin_manifest()` 合并盘上映射（对象已规范化的 `name`/`source` 优先） |
| **3** | **沙箱进程无法停止** | **中** | `SandboxPluginLoader` 创建 bridge 后不保留引用 → 丢失唯一子进程句柄 → 进程持续运行（Windows 上锁住插件目录，临时目录无法删除）。修法：保留 `self._bridges`，`shutdown()` 逐个停止并撤回策略 |
| **4** | **`Path` 未导入** | **中** | 我新写的加载代码用了 `Path` 但模块没导入 → `NameError` 被 `load_one` 的兜底 `except` 记成 "load failed"，21 个测试同时失败、症状是「Unknown tool」——**异常被自己的容错机制掩盖**。修法：补导入 |
| **5** | 策略行排序不足 | 低 | `policies()` 只按插件名排序，插件内工具行仍按注册顺序 → 优先级隐含依赖注册顺序。修法：按 pattern 全局排序（行都是精确工具名，排序不会造成遮蔽） |
| **6** | 我的测试断言错了层级 | 低 | 在 `PluginSandboxProcess`（单进程句柄）上断言"崩溃后自动重启"——那是 bridge 的职责，已由 Phase 8.1 端到端测试覆盖。改为断言进程层真正的性质：失效后**拒绝**而非写入断管 |

---

## 剩余风险

| # | 风险 | 状态变化 | 说明 |
|---|---|---|---|
| **R39** | 插件工具未进 Gate | **已闭合** | `get_gate()` 与 `install_enterprise_gate()` 均前置插件策略包；有反向测试断言未加载时落到兜底、加载后不再 |
| **R41** | 社区插件只能拒绝 | **已闭合** | 拒绝记录本身即为沙箱加载器的候选来源；`_ensure_plugins_discovered` 调用它 |
| **R42** | trust 字段未进 `PluginManifest` | **已缓解，未消除** | 运行时不再受影响（`resolve_plugin_manifest` 合并盘上声明）。但 `manifest.trust_level` 属性访问仍会失败 —— 要做进数据类需改 307KB 的 `plugins.py`，属被禁止的重构 |
| **R19** | 第三方插件机制未经实战 | **降低** | 闭环已用真实子进程与真实 gate 端到端验证。**但生产环境真实第三方插件数仍为 0** |
| **新增 R43** | **`plugins.enabled` 白名单未参与沙箱加载** | 新 | 沙箱加载器从「被拒绝的记录」取候选，未检查 `plugins.enabled`。当前无第三方插件，故无实际影响；但若部署启用了白名单，沙箱加载器应同样尊重它 |
| **新增 R44** | **沙箱加载器无卸载入口接入** | 新 | `SandboxPluginLoader.shutdown()` 存在且被测试调用，但**没有生产调用点**（插件卸载/禁用时无人调用它）。这是本轮同类问题的残留 —— 我明说，不再掩盖 |
| **新增 R45** | **插件工具未进任何 agent 能力画像** | 新 | 工具注册在 toolset `plugin`，但 `AGENT_CAPABILITIES` 未授予任何 agent → **agent 目前拿不到这些工具**。链路已通到 registry 与 gate，还差最后一段 |
| **R37/R38/R40** | 容器未验证 / 进程隔离无文件系统与网络约束 / 无权限授予 UI | 未变 | — |
| R31–R36 | 见 Phase 7 报告 | 未变 | — |

**R43/R44/R45 是我主动登记的**：三处都是「本轮同类的接线缺口」——机制已建、有测试，但生产链路上还差一段。其中 **R45 最直接**（agent 拿不到工具），应并入 Phase 8.4 的「Media / Search 接线」一起做，因为那是同一类问题：**能力可达性**。

---

## Confidence & gaps

**高置信（本机实测，可复现）**
- 31 passed / 3 subtests；插件三套件 175 passed / 11 subtests；全量 612 passed / 368 subtests
- 真实子进程 + 真实 gate 的端到端闭环：26 行 → 27 行、命中具名 manager 级行、dispatch 返回真实结果
- 主进程隔离：`sys.modules` 无插件模块
- 崩溃后同一插件恢复正常调用（确定性，非竞态）
- `EnterpriseToolGate` 与 `DEFAULT_POLICIES` 未被修改
- `tsc` exit 0；TS 73/73；0 遗留进程

**中置信**
- 「加载器失败不影响宿主启动」经 mock 与真实 bundled 发现验证（48 enabled 不受影响），但未在真实「第三方插件损坏」场景下验证
- 容器与 Linux 行为仍未验证（无引擎；本机为 Windows）

**未验证（明确缺口）**
- **真实第三方插件安装**：仍为 0。全部验证使用合成的社区插件目录与清单
- **卸载 / 禁用的沙箱清理**：`shutdown()` 已实现并测试，但无生产调用点（R44）
- **agent 实际取得插件工具**：未接（R45）
- **同一插件的并发调用**：`PluginSandboxProcess` 明确不支持单实例并发（单管道请求/响应），未做并发压力测试
- **多插件同时加载**：仅测了 2 个（含 1 个失败）的容错，未测 10+ 并发场景
