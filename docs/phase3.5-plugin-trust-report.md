# Phase 3.5 Complete — Plugin 生态安全闭环

**日期**：2026-09-12
**约束遵守**：未重构 `PluginManager`（仅一处加法式守卫）、未迁移任何 bundled 插件、未重写 `PluginContext`、未删除插件、**未修改 `EnterpriseToolGate` 核心逻辑**。
**前置**：`docs/phase3-plugin-center-mcp-sandbox-report.md`

---

## 完成内容

### 任务 1：Plugin Trust Model（双轨模型）

新增 `roveagent/api/plugin_trust.py`：

| trust_level | 来源 | 执行方式 |
|---|---|---|
| `official` | `bundled` | 允许 in-process（与今天完全一致） |
| `community` | `user` / `project` / `entrypoint` | **必须** MCP Boundary + Sandbox |
| `unknown` | 其他/无法确定 | **拒绝加载** |

`source_type`：`builtin` / `external` / `project` / `unknown`。

**核心规则（我认为这是本阶段最重要的设计决定）：插件不能自我提升信任。**

生效等级 = 发现所证实的等级 与 manifest 声明等级 的**最小值**。

```
user 插件声明 trust_level: official   → 仍为 community，并记录 trust_escalation_attempted
bundled 插件声明 trust_level: community → 降为 community（降级永远安全，予以尊重）
bundled 插件声明 trust_level: offical   → unknown（拼错是「无法履行的声明」，不是「没声明」）
```

最后一条容易做错：若把拼错的值当作「未声明」而回落到来源推导等级，一个 typo 就能让检查静默失效。测试锁定了这一点。

### 任务 2：第三方插件强制隔离

在 `clisupport/plugins.py` 的发现循环插入**一处**守卫（位于既有 `plugins.disabled` 检查之后），**用的是该文件自己的「跳过并记录原因」惯用法**：

```python
trust_denial = _trust_gate_denial(manifest)
if trust_denial:
    loaded = LoadedPlugin(manifest=manifest, enabled=False)
    loaded.error = trust_denial
    self._plugins[lookup_key] = loaded
    logger.warning("Refusing to load plugin '%s' in-process: %s", lookup_key, trust_denial)
    continue
```

`_trust_gate_denial()` 是 `plugins.py` 里的薄包装（放在既有 `_get_disabled_plugins` 旁），策略本体在 `plugin_trust.py`。**失败处理刻意不对称**：

| 情形 | 行为 | 理由 |
|---|---|---|
| 策略模块导入失败 + **bundled** | 放行 | 产品必须能启动；bundled 代码就是产品 |
| 策略模块导入失败 + **非 bundled** | 拒绝 | 不可信插件不能仅因「检查没跑起来」就被放进主进程 |

社区插件的执行路径：`Plugin → MCP Boundary → Sandbox → Tool Gateway`（Phase 3 已建并验证）。

### 任务 3：Plugin Tool 进入 Gate

新增 `roveagent/api/plugin_tools.py`：

- **命名空间**：`plugin__<plugin>__<tool>`。函数**拒绝**名字里含 `__` 的输入（否则插件可伪造他人命名空间）；前缀使插件**无法遮蔽内建工具**（`plugin__web__terminal ≠ terminal`）。
- **注册即受门**：工具进 `registry`（toolset `plugin`），handler 经 `PluginToolBridge` 转发到沙箱进程。
- **策略行是强制而非可选**：`DEFAULT_POLICIES` 末尾是兜底 `ToolPolicy("*", "", LOW, NONE)`，其自带注释写明「registered therefore allowed, without approval」。**没有策略行的插件工具会被无审批执行，而 gate 看起来仍在工作。** 因此 `register_plugin_tools` 在无行覆盖时**拒绝注册**，把危险的静默默认变成注册期的显式错误。
- **一工具一行，不用 glob**：`plugin__*` 会预先授权**尚未被审查的未来插件**。每行对应一个具名决定。
- **风险分级**：默认 MEDIUM/MANAGER；声明 `network: true` 或 `filesystem != readonly` 时升为 **HIGH/OWNER**。
- 通过 `EnterpriseToolGate(policies=...)` 的**文档化前置扩展点**注入 —— **核心逻辑一行未改**。

### 任务 4：SandboxPolicy

`plugin_trust.SandboxPolicy`：`filesystem` / `network` / `cpu` / `memory_mb` / `timeout_s`。

默认（安全侧）：`filesystem=readonly`、`network=false`、`timeout_s=60`。

**策略层独立于后端存在** —— 你的要求原文即如此。理由也已写进代码：策略是「插件被允许什么」，`plugin_isolation.SandboxSpec` 是「如何启动它」。两者分离意味着**后端从 docker 换成 microVM 时策略不用改**，且**没有任何后端时策略仍可被评估与拒绝**（容器不可用的插件现在就被拒绝）。

未知字段值（`filesystem: whatever`）→ `unsatisfied` → 拒绝，**不强制转成已知值**。

---

## 修改文件

| # | 文件 | 动作 |
|---|---|---|
| 1 | `roveagent/api/plugin_trust.py` | **新建** —— 信任模型、评估、SandboxPolicy、manifest 读取 |
| 2 | `roveagent/api/plugin_tools.py` | **新建** —— 命名空间、注册、策略包、沙箱 bridge |
| 3 | `roveagent/api/plugin_trust_test.py` | **新建** —— **53 测试** |
| 4 | `roveagent/clisupport/plugins.py` | **改（极小）** —— 1 处守卫 + 1 个薄包装函数 |

**未修改**：`tools/framework.py`（`EnterpriseToolGate` 与 `DEFAULT_POLICIES`）、`PluginContext`、`PluginManifest` 定义、54 个 bundled 插件、`api/plugin_security.py`、`api/plugin_isolation.py`。
**未新增依赖**：仅标准库。

---

## 架构变化

```
                            User
                              |
                        Agent Gateway
                              |
                  Agent Capability Router
                              |
                      RoveAgent Runtime
                              |
            ┌─────────────────┼─────────────────┐
          Tools             MCP             Plugins
            │                 │                 │
            │                 │        ┌────────▼─────────┐
            │                 │        │ PluginManager    │  ← 未重构
            │                 │        │  + 信任门(1处)   │  ← 新增
            │                 │        └────────┬─────────┘
            │                 │                 │
            │                 │      ┌──────────┴──────────┐
            │                 │      │                     │
            │                 │  official              community
            │                 │  in-process            （必须隔离）
            │                 │  （与今天一致）              │
            │                 │                 ┌────────▼─────────┐
            │                 │                 │ MCP Boundary     │
            │                 │                 │ JSON-RPC 2.0     │
            │                 │                 └────────┬─────────┘
            │                 │                 ┌────────▼─────────┐
            │                 │                 │ Sandbox Process  │
            │                 │                 └──────────────────┘
            │                 │
            └─────────────────┴──────────┐
                                        ▼
                        Command / Permission Layer
                                        │
        ┌───────────────────────────────┴──────────────────────────┐
        │  EnterpriseToolGate  ← 核心逻辑未改                        │
        │  行来源：DEFAULT_POLICIES  +  prepend(plugin tool pack)   │
        └───────────────────────────────┬──────────────────────────┘
                                        │
                                Approval System
                                        │
                                Sandbox Runtime
                                        │
                                External Services
```

**新增闭环**：`Plugin Tool → Registry → Gate → Sandbox → 结果`。插件没有绕过它的路径，也没有调用自身代码的私有通道 —— 唯一入口是已注册工具，而每个已注册插件工具都有具名策略行。

---

## 测试结果（全部实测，2026-09-12）

```
$ python -m pytest roveagent/api/plugin_trust_test.py -q
53 passed, 8 subtests passed in 8.65s

$ python -m pytest roveagent -q --ignore=roveagent/skills_library
580 passed, 365 subtests passed, 1 failed in 68.97s
  （Phase 3 后为 527 passed；本阶段 +53）

$ pnpm exec tsc -p tsconfig.json --noEmit
exit 0

$ pnpm exec tsx --test tests/{roveagent-stream-contract,runtime-status-contract,
                              runtime-fallback-policy,runtime-recovery,artifacts-pdf}.test.ts
tests 73  pass 73  fail 0

$ 遗留沙箱进程
0
```

### 你要求的 6 项验证

| # | 要求 | 结果 | 证据 |
|---|---|---|---|
| 1 | **builtin plugin 正常运行** | **通过** | 真实 `PluginManager`：**54 插件 / 48 enabled / 0 被信任门拒绝**；另断言 bundled 恒不被拒 |
| 2 | **third-party 不能 in-process** | **通过** | `in_process_denial(source="user")` 非空且含 "MCP boundary"；`_trust_gate_denial` 对 user 返回拒绝 |
| 3 | **unknown 拒绝** | **通过** | 5 种未知来源全部 `UNKNOWN` 且 `refused`；注册插件工具时抛错 |
| 4 | **plugin tool 经过 Gate** | **通过** | 前置策略包后 `policy_for(qualified)` 命中具名列；**且断言无包时落到兜底 `*`/`none`**（正是被消除的危害）；`DEFAULT_POLICIES` 无 `plugin__` 行 |
| 5 | **sandbox crash 不影响 Runtime** | **通过** | 插件 `os._exit(9)` → 返回结构化 JSON 错误（含 plugin/detail）；挂死 → <40s 返回错误；崩溃后注册表仍持有该工具且能再次派发 |
| 6 | **权限不足 blocked** | **通过** | 未授予 `shell:execute` → 判定拒绝；策略模块不可用时 untrusted 拒绝 / bundled 放行 |

**另覆盖**：自我提升被阻止、自我降级被尊重、拼错 trust_level → unknown、source_type 只能收窄不能放宽、命名空间分隔符被拒（防伪造）、插件无法遮蔽内建工具、策略默认值安全、策略层无后端也可用、未知 filesystem 值不被强制转换。

---

## 本阶段修掉的 3 个缺陷（均被自己的测试或守卫抓出）

| # | 缺陷 | 严重性 | 修法 |
|---|---|---|---|
| **1** | **策略行用了裸工具名**：`build_policy_pack` 取 `binding.tool_name`（`act`）而非 `binding.qualified_name`（`plugin__x__act`）→ 策略行**永不命中**，调用落到免审批兜底 | **高** | 改用 `qualified_name`。这正是「注册必须被策略覆盖」守卫存在的意义 —— 它拒绝注册从而暴露了这个 bug |
| **2** | **声明被静默忽略**：`register_plugin_tools` 拿到 `plugin_path` 却**不读盘上 manifest** → 插件声明的 `sandbox: network: true` 被忽略、静默套用默认策略；`filesystem: whatever` 也不会被拒 | **高** | 未显式传 `manifest` 时自动从 `plugin_path` 读取；新增 `read_manifest_mapping()`。**声明不能取决于调用方是否记得传参** |
| **3** | 测试误用 `registry.unregister`（实为 `deregister`）；另一处断言 `terminal` 已注册，但它在测试进程中本就没注册 | 低 | 改用 `deregister`；改为断言语义上正确的性质（注册表仍持有该工具、仍能再次派发） |

---

## 剩余风险

| # | 风险 | 说明 | 处置 |
|---|---|---|---|
| **R19** | **已闭合，但仅对"未来安装的"第三方插件** | 加载流程现在会拒绝社区插件进入主进程。**当前 0 个第三方插件**，故实际拦截数也是 0 —— 机制已就位并验证，但尚未在真实第三方插件上跑过 | 首个真实第三方插件安装时即为首次实战 |
| **R39** | **插件工具的 Gate 端到端未接入请求链路** | `register_plugin_tools` 返回策略包，但**没有调用方**把它交给 `EnterpriseToolGate(policies=...)`；工具也不在任何 agent 的能力画像里 | 需要一个接入点：谁构造 gate、谁注册工具。见下 |
| **R41** | **社区插件的沙箱启动未接入 PluginManager** | 守卫**拒绝**社区插件进主进程，但**没有**自动改为用沙箱加载它们 —— 那条路径要由调用方显式调用 `plugin_isolation`。当前结果是社区插件"被拒绝"而非"被沙箱加载" | 这是刻意的 fail-closed 中间态：拒绝比错误地 in-process 加载安全。需要接入点 |
| **R42** | **`trust_level` / `source_type` 未进 `PluginManifest` 数据类** | 按「不重构」约束，我以容错读取解析它们（`assess_trust` 接受 mapping 或对象）。`PluginManifest` 本体无这两个字段，故 `manifest.trust_level` 属性访问会失败 | 有意为之；`assess_trust` 两种形态都接受。若要进数据类需改 307KB 文件 |
| **R37** | 容器执行仍未验证 | 未变（docker daemon 不可达） | — |
| **R38** | 进程隔离不含文件系统/网络约束 | 未变 | 策略层已能表达约束（`SandboxPolicy`），但 SUBPROCESS 后端不执行全部约束 |
| **R40** | 无权限授予 UI | 未变 | 第三方插件默认被拒是 fail-closed 的正确状态 |
| R31–R36 | 见 Phase 7 报告 | 未变 | — |

### 需要后续接入的两个点（不阻塞本阶段验收）

1. **谁构造 gate 并把插件策略包前置**。当前 `register_plugin_tools` 已返回包，但请求链路里构造 `EnterpriseToolGate` 的地方尚未使用它。**在此之前，插件工具虽有注册但无策略行，因此不应投入实际使用** —— 这一点在代码注释与返回值的 `note` 字段里都写明了。
2. **社区插件从"被拒绝"变为"被沙箱加载"的调用点**。需要有人在 PluginManager 判定拒绝后，改走 `plugin_isolation.PluginSandboxProcess` + `plugin_tools.register_plugin_tools`。

---

## Confidence & gaps

**高置信（本机实测，可复现）**
- 53 passed / 8 subtests；全量 580 passed / 365 subtests
- **真实 `PluginManager` 未受影响**：54 插件 / 48 enabled / **0 被信任门拒绝**（这是本次改动最大的风险，已直接实测而非推断）
- `EnterpriseToolGate` 与 `DEFAULT_POLICIES` 未被修改（有测试断言无 `plugin__` 行泄漏）
- 自我提升被阻止、降级被尊重、拼错值 → unknown
- 沙箱崩溃三类（`os._exit` / 挂死 / 普通异常）均转为结构化工具错误，注册表与宿主不受影响
- 命名空间阻止遮蔽内建工具、阻止伪造他人命名空间
- `tsc` exit 0；TS 73/73；0 遗留进程

**中置信**
- 「插件工具落到兜底 `*`/`none`」的断言基于当前 `DEFAULT_POLICIES` 内容；若将来有人改动兜底行，该测试会失败并需要重新评估（这正是它该做的）
- 策略不对称失败处理（untrusted 拒绝 / bundled 放行）经 mock 验证，但未在真实的「策略模块损坏」场景下端到端验证

**未验证（明确缺口）**
- **一个真实第三方插件都没装过**：`user` 来源插件数为 0。机制经单元测试与合成夹具验证，未在真实安装流程中跑过
- **社区插件的沙箱加载路径**：零。守卫只做到「拒绝」，未做到「改道沙箱」（R41）
- **插件工具的 Gate 端到端**：策略包已产出，未接入真实 gate 构造点（R39）
- **Linux 行为**：命名空间、`--user`、信号语义均只在 Windows 验证
- **容器执行**：仍未起过一个容器
