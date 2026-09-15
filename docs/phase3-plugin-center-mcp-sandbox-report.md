# Phase 3 Complete — Plugin Center + MCP Sandbox

**日期**：2026-09-12
**性质**：**补做**。Phase 3 早前只交付了观察式的 manifest 信封审计（`enforce=False`），并把「插件装进主进程」记为风险 **R19**。本阶段实现真正的隔离边界。
**前置**：`docs/phase7-skill-marketplace-report.md`

---

## 完成内容

### 0. 执行前扫描结果（按你的要求）

| 扫描项 | 实测结果 |
|---|---|
| **1. 现有 plugin 目录** | `roveagent/plugins/` 18 个子目录；发现函数共报出 **54 个插件**（bundled 54 / user 0） |
| **2. MCP 能力** | 18 个 MCP 文件，**已很完整**：`tools/mcp_tool.py` 387KB、`mcp_oauth.py` 84KB、`mcp_oauth_manager.py` 44KB、`clisupport/{mcp_config,mcp_catalog,mcp_security,mcp_startup}.py`、**`tools/mcp_stdio_watchdog.py`**（stdio 子进程父死监管） |
| **3. tools/environments** | 8 个真实后端：`base.py`(72KB，含 `ProcessHandle` 协议 + `_ThreadedProcessHandle`)、`docker.py`(96KB)、`local.py`(103KB)、`singularity.py`、`ssh.py`、`modal.py`、`daytona.py`、`vercel_sandbox.py`；另有 `process_registry.py`(158KB，含 `spawn_local`/`spawn_via_env`) |
| **4. sandbox 相关代码** | 仅 `skills_market/sandbox.py`（Phase 7 我建的接口层）；**没有任何插件隔离实现** |
| **5.（额外）隔离二进制可用性** | `docker` **v29.4.2 存在**，但 **daemon 不可达**：`failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`。`podman`/`firejail`/`bwrap`/`singularity`/`nsjail`/`systemd-run` 全部 NOT FOUND |

**`PluginManifest` 字段现状**：有 `name` / `version` / `author` / `provides_tools` / `capabilities` / `granted_capabilities`；**没有 `permissions`、`sandbox`** —— 你的规格要求这两个，故需扩展（以容错读取方式，不改 307KB 的 `plugins.py`）。

**Phase 3.1 与 3.2 早已完成**（勿重复）：R16 命令级策略 → `api/command_policy.py`（默认不启用）；R15 插件 hook 静默吞失败 → `core/agent_runtime_helpers.py` 已修复为三分支（不存在→忽略 / 执行失败→warning / 明确 block→阻止）。

### 1. 隔离边界（本阶段核心）

实现你给的架构：

```
Plugin → MCP Boundary → Sandbox Process → Tool Gateway → Agent
```

映射到本仓库既有部件：

| 你的架构层 | 实现 | 复用情况 |
|---|---|---|
| **Sandbox Process** | `subprocess.Popen` 拉起独立 OS 进程；CONTAINER 模式走 `docker run` | 命令构造为纯函数、可测 |
| **MCP Boundary** | **JSON-RPC 2.0 over stdio**（MCP 的线格式），每行一个 JSON 对象 | 协议形状与 MCP 兼容 |
| **Tool Gateway** | 工具调用经边界转发；`EnterpriseToolGate` **仍是唯一执行门** | 未改动 |
| **Plugin registry** | `clisupport/plugins.py` 的 `PluginManager` 与其 307KB 模块 **未改一行** | 完全复用 |

**关于 `tools/environments/docker.py` 的复用判断**：它是**一次性 `execute(command) → output` 抽象**，自带 session 与 file-sync 模型；插件沙箱需要的是**长驻进程 + 双向 stdio**，那个接口不描述这件事。硬塞进去要么绕过它的契约、要么重写它 —— 都劣于在此处构造一小段可检查的 argv。这个判断写进了 `container_argv` 的 docstring。

**协议方法**：`initialize` / `tools/list` / `tools/call` / `ping` / `shutdown`。

### 2. manifest 扩展：`sandbox` + `permissions`

以**容错读取**方式解析（`read_manifest_isolation`），不改 `PluginManifest`：

- **`sandbox`**：`mode`（`in-process` / `subprocess` / `container`）、`image`、`memory_mb`、`cpus`、`network`、`writable_paths`、`timeout_s`
- **`permissions`**：`tools:expose` / `hooks:register` / `files:read` / `files:write` / `shell:execute` / `network:egress` / `env:secrets`

**声明≠授权**（与 Phase 7、与既有插件框架同一条规则）：`requested` 由 manifest 推导，`granted` 默认为空。

### 3. 禁止静默降级

| 情形 | 行为 |
|---|---|
| manifest 要求 `container`，但本机无可用引擎 | **拒绝加载**，并说明「不是静默降级到进程隔离」 |
| manifest 的 `sandbox.mode` 拼错（如 `gvisor`） | 标记 `unsatisfied` → **拒绝**，不做 fallback |
| manifest 要求 `in-process` | **默认拒绝**（正是你的规格禁止的模式），需显式 `allow_in_process` |
| 权限未授予 | **拒绝** |

### 4. Plugin Manager `status`

新增 `isolation_status` / `isolation_status_for_discovered` / `isolation_summary`，并把结果**加法式**接入 `plugin_center_summary()` 的 `isolation` 键（既有键一个未动，失败不致命）。

---

## 修改文件

| # | 文件 | 动作 |
|---|---|---|
| 1 | `roveagent/api/plugin_sandbox_runner.py` | **新建** —— 沙箱**内**运行的 stdio JSON-RPC 服务器 |
| 2 | `roveagent/api/plugin_isolation.py` | **新建** —— 沙箱**外**的边界、manifest 扩展、策略、状态 |
| 3 | `roveagent/api/plugin_isolation_test.py` | **新建** —— **90 测试** |
| 4 | `roveagent/api/plugin_center.py` | **改** —— 新增 `_isolation_block()`，summary 增加 `isolation` 键 |
| 5 | `scripts/_scan_plugin_isolation.py` | **新建** —— 只读扫描 |
| 6 | `scripts/_probe_plugin_isolation_status.py` | **新建** —— 真实插件集状态探针 |

**未修改**：`clisupport/plugins.py`（307KB，插件框架本体）、`tools/environments/*`、`tools/process_registry.py`、`tools/mcp_tool.py`、`EnterpriseToolGate`、`plugin_security.py` 的判定逻辑。
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
        │                 │        ┌────────┴─────────┐
        │                 │        │  Plugin Manager  │  ← 既有，未改
        │                 │        │  manifest/sandbox│  ← 新增字段
        │                 │        └────────┬─────────┘
        │                 │                 │
        │                 │      ┌──────────▼───────────┐
        │                 │      │  MCP Boundary        │  ← 新增
        │                 │      │  JSON-RPC 2.0/stdio  │
        │                 │      └──────────┬───────────┘
        │                 │                 │
        │                 │      ┌──────────▼───────────┐
        │                 │      │  Sandbox Process     │  ← 新增
        │                 │      │  (subprocess/docker) │
        │                 │      └──────────────────────┘
        │                 │
        └─────────────────┴──────────┐
                                    ▼
                     Command / Permission Layer
                                    │
                        EnterpriseToolGate   ← 仍是唯一执行门，未改
                                    │
                           Approval System
                                    │
                           Sandbox Runtime
                                    │
                           External Services
```

**新增的两条保证，及其界限**：

| 保证 | 状态 |
|---|---|
| **失败隔离**（独立进程） | **已实现并验证**：插件崩溃 / 挂死 / `os._exit` / 写坏协议流，宿主不受影响 |
| **权限隔离**（文件系统 + 网络） | **命令已构造并断言**；**执行未经验证**（无容器引擎）。`--network none` / `--read-only` / `--tmpfs` / `--user 65534` / 插件目录只读挂载 / 不发宿主环境 |

---

## 测试结果（全部实测，2026-09-12）

```
$ python -m pytest roveagent/api/plugin_isolation_test.py -q
90 passed in 24.65s

$ python -m pytest roveagent -q --ignore=roveagent/skills_library
527 passed, 357 subtests passed, 1 failed in 49.50s
  （Phase 7 后为 437 passed；本阶段 +90）

$ pnpm exec tsc -p tsconfig.json --noEmit
exit 0

$ pnpm exec tsx --test tests/{roveagent-stream-contract,runtime-status-contract,
                              runtime-fallback-policy,runtime-recovery,artifacts-pdf}.test.ts
tests 73  pass 73  fail 0

$ 遗留沙箱进程数
0
```

**真实插件集探针**（`_probe_plugin_isolation_status.py`）：

```
discovered                 : 54
allowed / refused          : 54 / 0
by mode                    : {'in-process': 54}
container usable           : False
plugin_center.isolation    : 存在且 json-safe
```

**测试覆盖的关键性质**：
- 插件**抛异常** → 报错且**进程仍存活**，后续调用正常（一个坏工具 ≠ 死插件）
- 插件 `import` 失败 / `on_load` 失败 → 报错，不挂起
- 插件 `os._exit(7)` → 报为崩溃，宿主存活，进程被回收
- 进程被 kill → 报为崩溃
- 插件**挂死** → 超时抛错、进程被丢弃、宿主等待 < 30s
- **插件写 stdout 伪造 JSON-RPC 回复** → 被忽略，真实结果胜出（stdout 在插件加载前即被重定向）
- 插件向 stderr 输出噪声 → 协议不受影响
- **宿主密钥不可见**：连**自造名字**的环境变量也不泄漏（allowlist 而非 denylist）
- 畸形 JSON / 非对象请求 / 缺 method / 未 initialize 就调用 / 未知方法 → 各自被干净拒绝，流继续
- 容器 argv：默认 `--network none`、`--read-only` + `--tmpfs`、插件目录只读挂载、非 root、`--rm`、`-i`、资源限制仅在声明时出现、无 shell 字符串

---

## 本阶段修掉的 5 个缺陷（均由测试抓出）

| # | 缺陷 | 严重性 | 修法 |
|---|---|---|---|
| **1** | **死锁**：`_request()` 持有 `self._lock` 时调用 `stop()`，而 `stop()` 又发 `shutdown` 请求去抢同一把**不可重入**的锁 → **第一个挂死的插件就会挂死宿主** | 高 | 错误处理移到释放锁之后；`stop()` 不再发协议请求（已判定挂死的进程再发请求本就无意义，另设 `graceful_shutdown()`） |
| **2** | **密钥泄漏**：把 `local._make_run_env` 当净化器 —— 它是 `os.environ` **减去已知 provider 密钥名**。denylist **无法枚举**操作者的秘密，测试用自造变量名证明其直接穿透 | 高 | 改为 **allowlist**（`_CHILD_ENV_ALLOWLIST`），另加 `_CHILD_ENV_NEVER` 兜底 |
| **3** | **in-process 可被"省略"到达**：若默认值是 in-process，不声明 sandbox 的插件就自动共享宿主进程 | 高 | 默认 `subprocess`；`in-process` 必须显式要求 —— 正是你规格禁止的模式必须有测试断言它**不可**由省略到达 |
| **4** | **状态说谎**：行内报 `subprocess`，而 `PluginManager` **实际仍 import 进主进程** —— 会被读成"已隔离"的保证 | 中 | 每行加 `isolation_enforced: false` + `runtime_loader`，summary 加 `boundary_enforced: false` 与明确说明 |
| **5** | `PluginPermissions()` 无法无参构造（`requested` 无默认） | 低 | 两者均默认 `frozenset()` |

---

## 新发现风险

| # | 风险 | 说明 | 处置 |
|---|---|---|---|
| **R19** | **边界已建，但加载未改道** | **本阶段最重要的未完成项。** 隔离边界已实现并验证，但 `PluginManager` **仍然把插件模块 import 进主进程**。今天安装的第三方插件**依旧跑在主进程**。每行 `isolation_enforced: false` 就是这个事实 | **需人工决策**：把 `PluginManager` 的加载改道经过边界，会一次性改变 54 个 bundled 插件的加载方式，可能破坏产品。见「需决策」 |
| **R37** | **容器执行未验证** | 命令已构造并断言，但本机 daemon 不可达，**一次容器都没起过** | 需可用引擎。`available_isolation_modes()` 会在启用时自动放行 |
| **R38** | **进程隔离不含文件系统/网络约束** | 子进程仍能读写宿主文件系统、发起网络连接 | `evaluate_isolation` 的 `effective_guarantees` 对 SUBPROCESS **明写** "partial: 仅环境净化，无文件系统/网络约束"，不谎称是容器 |
| **R39** | **边界转发 ≠ 授权** | 边界只中继调用；插件工具尚未注册进 tool registry，因此 `EnterpriseToolGate` 目前不会对它们逐次校验 | 接入 registry 后自动生效（届时 gate 的兜底行会命中，**必须补策略行** —— 见 Phase 1 的教训） |
| **R40** | **`plugin.yaml` 的 `permissions` 尚无 UI** | 操作者目前无法授予权限，故第三方插件会被默认拒绝 | 这是 fail-closed 的正确状态；需要授权入口 |
| R31–R36 | 见 Phase 7 报告 | 未变 | — |

### 需决策（触发暂停条件 5：人工业务决策）

**是否把 `PluginManager` 的插件加载改道经过隔离边界？**

- **不改**（当前）：bundled 与第三方插件都跑在主进程。边界可用于新装的第三方插件，但需要有人实现"仅对非 bundled 插件走沙箱"的分支。
- **改**：一次性改变 54 个 bundled 插件的加载方式。它们在主进程里通过 `PluginContext` 注册工具与 hook；改道意味着重写这部分契约 —— 那是**推倒重写**，违反你的工程原则 3。

我倾向**不改道，而是让第三方插件走边界**（bundled 视为产品的一部分，与浏览器信任内建代码、沙箱扩展同一逻辑）。但这是产品边界决策，我停在边界内。

---

## Confidence & gaps

**高置信（本机实测，可复现）**
- 90 passed / 24.65s，全量 527 passed / 357 subtests
- 失败隔离四类全部验证：抛异常（进程存活）、挂死（超时+丢弃）、`os._exit`（报崩溃+回收）、伪造协议回复（被忽略）
- 宿主密钥对插件不可见，含**自造变量名**
- 真实 54 个插件：manifest 全部解析、状态全部产出、`plugin_center` 集成 json-safe
- 容器 argv 的形状（网络默认拒绝、只读根、非 root、只读挂载）
- `tsc` exit 0；TS 73/73；0 遗留进程

**中置信**
- 超时路径在 Windows 上的回收时机（测试加了有界等待，因为回收是异步的）
- `container_argv` 的正确性靠断言而非运行；挂载路径的语义未在真实 docker 上验证

**未验证（明确缺口）**
- **一次容器都没起过** —— daemon 不可达
- **插件加载改道**：零。`PluginManager` 未改一行
- **`tools/call` 经 `EnterpriseToolGate` 的端到端授权**：插件工具未注册进 registry，故未验证
- **多插件并发**：`PluginSandboxProcess` 明确不支持同一实例并发调用（协议是单管道请求/响应），未做多实例并发压力测试
- **Linux 行为**：`--user 65534`、cgroup 限制、`terminate()` 的信号语义均只在 Windows 验证过（部署目标是 Linux）
