# Phase 3 Complete — Plugin Center + MCP Sandbox + 命令级安全策略

**日期**：2026-09-12
**自主执行**：未逐项询问；未删核心模块、未改既有安全模型默认行为、未用生产密钥。
**前置**：`docs/phase2c-devops-readonly-report.md`

---

## 完成内容

### 扫描结论（决定了「怎么复用」）

按要求先扫描，结论**改变了实现策略**：

| 面 | 实测发现 | 决定 |
|---|---|---|
| 插件管理器 | `clisupport/plugins.py` 已有 `PluginManifest` **v2**（`manifest_version`/`api_version`/`requires_plugins`/`python_dependencies`/`config_schema`/`capabilities`） | **不新增 manifest 框架**，扩展它 |
| 能力授权 | `clisupport/plugin_capabilities.py` 已有 `CAPABILITY_REGISTRY` 与「**声明 ≠ 授予**」模型（`plugins.entries.<id>.granted_capabilities`） | **不动**，本阶段做正交的资源信封 |
| 生命周期 | `plugins_cmd.py` 已有 **dashboard 级 API**：`dashboard_install_plugin` / `dashboard_set_agent_plugin_enabled` / `dashboard_remove_user_plugin` / `dashboard_update_user_plugin` | **全部委托**，零重复实现 |
| 清单 | 101 个 `plugin.yaml`；字段 `name`(101)/`version`(101)/`author`(93)/`kind`(89)/`requires_env`(39)… | 与用户 spec 对齐，只需补 `network`/`filesystem`/`sandbox` |
| MCP | `tools/mcp_tool.py` 已有完整客户端（reconnect / stdio watchdog / OAuth） | 复用为跨进程边界，不新建 |
| 沙箱 | `tools/environments/` 已有 8 个后端（local / docker / daytona / modal / managed_modal / singularity / ssh / vercel_sandbox）+ `BaseEnvironment` | 复用，不新建 |

**结论：Phase 3 的真实缺口不是「插件框架」，而是「安全可见性」与「命令级策略」。**

### Phase 3-1：Plugin Security Envelope（安全信封）★

既有的插件框架很强，但缺一件东西：

> 没有机制回答「这个插件**实际能做**什么，与它**声明**的一致吗？」

于是「插件不能影响主系统」只能靠信任。新增 `api/plugin_security.py` 把这件事
变成**可审计**：

```
declared envelope（manifest 声明）
          ⟷
derived envelope（AST 静态扫描插件代码实际用到的能力）
```

- **实现**：纯 `ast` + 标准库（无新增依赖），扫描 import 与调用形态
- **能力词表**：`network.http` / `network.raw_socket` / `filesystem.read` /
  `filesystem.write` / `filesystem.delete` / `process.spawn` / `native.code`
- **定级**：代码用到但未声明 → `undeclared`，按危险度 `CRITICAL`/`HIGH`/`MEDIUM`
- **fail-closed**：扫描失败 → `UNKNOWN`（可据 `is_load_allowed(enforce=True)` 拒绝）
- **默认只报告**：`enforce=False` 不改变既有加载行为

**实测校准（重要，两次迭代）**：对 12 个真实插件扫描后按结果修正了定级 ——

| 迭代 | 问题 | 修正 |
|---|---|---|
| v1 | `ctypes` 与 `subprocess` 都判 CRITICAL → discord 这类正常插件被误报最高危 | `process.spawn` 保持 CRITICAL；`native.code`（FFI 加载）降为 HIGH |
| v2 | `derive_envelope` 的 sandbox 等级与定级逻辑不一致 | 统一为 `process.spawn → container`、`native.code → process` |

**零误报验证**：逐个人工核对抽查项，全部为真阳性 ——
`ddgs` 确实 `subprocess.Popen` + `ctypes.PyDLL`；`discord` 确实 `ctypes.util.find_library("opus")`；
`memory` 确实 `subprocess.run`。

**全量结果（54 个插件）**：`OK 11 / HIGH 32 / CRITICAL 11`
（11 个 CRITICAL 全部含真实 `subprocess`）

### Phase 3-2：Plugin Center

新增 `api/plugin_center.py`（**全部委托**既有 dashboard API）+ 7 个端点：

| 端点 | 作用 |
|---|---|
| `GET /api/plugins` | 清单 + 状态 + 安全信封（`?include_audit=false` 跳过扫描） |
| `GET /api/plugins/summary` | 概览（含第三方插件风险） |
| `GET /api/plugins/{name}` | 单插件详情 |
| `POST /api/plugins/toggle` | 启用/禁用 |
| `POST /api/plugins/install` | 安装（Git URL / owner/repo / 索引名） |
| `POST /api/plugins/update` | 更新 |
| `POST /api/plugins/remove` | 移除（bundled 被既有逻辑拒绝） |

**风险信号按来源区分**（避免噪音）：

- `needs_review`：只列 **user 来源**且 CRITICAL/HIGH 的插件 —— 那才是不可信代码
- `bundled_high_risk`：bundled 高危项单独放（随产品审计，不是运维待办）
- `untrusted_total`：第三方插件总数（当前 **0**）

理由：把 54 个 bundled 插件里 43 个都列为「待审查」只会让运维忽略这个字段。

**每个写操作都落审计**（`plugin_center` / toggle|install|update|remove）。

### Phase 3.1：Command Policy Layer（解决 R16）★

**R16 的本质**：`EnterpriseToolGate` 按**工具名**授权，无法区分
`tasklist` 与 `taskkill /F` —— 两者都是「调用 terminal」。
所以「DevOps 只读」只能靠模型遵循指令。

新增 `api/command_policy.py`，定位为**gate 的前置更细粒度判定**：

```
Command Policy  →  EnterpriseToolGate  →  Execution
（本模块，命令粒度）   （既有，工具粒度，核心逻辑未改）
```

- **四档分类**：`read` / `mutate` / `destructive` / `deploy`
- **复合命令按最严段定级**：`tasklist && taskkill /F` → `destructive`
  （否则只读前段会掩护破坏性后段）
- **未知命令 fail-closed** → 按 `mutate`（需审批），绝不默认放行
- **默认不强制**：`ROVEAGENT_COMMAND_POLICY=enforce` 才阻断。
  理由：这是**新增安全层**，默认打开会静默改变既有部署的放行结果 ——
  那属于「改变安全模型」，必须先由部署方显式同意。

**实测两档行为**：

```
默认（未设 env）：只分类 + warning，全部放行
  tasklist                 -> EXECUTED
  taskkill /PID 1 /F       -> EXECUTED（但 logger.warning 记录 destructive）

enforce 模式：
  tasklist                 -> allowed
  docker ps                -> allowed
  docker logs --tail 5 web -> allowed
  taskkill /PID 1 /F       -> BLOCKED
  systemctl restart nginx  -> BLOCKED
  rm -rf /tmp/x            -> BLOCKED
  deploy prod              -> BLOCKED
```

### Phase 3.2：插件 Hook 安全（解决 R15）

`agent_runtime_helpers.py` 原实现把 import 失败与 hook 执行失败一律
`except Exception: block_message = None` —— **插件阻断能力静默失效**。

按你的要求区分三种情况：

| 情况 | 语义 |
|---|---|
| 插件子系统不可用（`ImportError`） | `debug`，忽略（不是错误） |
| hook **执行失败** | `warning`（可见）+ 明确事件。默认放行；设 `ROVEAGENT_PLUGIN_HOOK_FAIL_CLOSED=1` 则 fail-closed 阻断 |
| hook **明确返回 block** | 阻止执行（既有逻辑不变） |

**顺带修掉一个潜在 NameError**：该文件用了 `os.` 但模块级从未 `import os`
（我新增的代码首次触发）。已补 `import os`。

---

## 修改文件

| # | 文件 | 动作 |
|---|---|---|
| 1 | `roveagent/api/plugin_security.py` | **新建**（安全信封 + AST 审计 + 定级） |
| 2 | `roveagent/api/plugin_center.py` | **新建**（Plugin Center 服务，委托既有 API） |
| 3 | `roveagent/api/command_policy.py` | **新建**（命令级策略，R16） |
| 4 | `roveagent/api/command_policy_test.py` | **新建**（18 测试 / 75 子测试） |
| 5 | `roveagent/api/app.py` | 新增 7 个插件端点 |
| 6 | `roveagent/enterprise/gate_hook.py` | 接入命令策略层（gate 之前） |
| 7 | `roveagent/core/agent_runtime_helpers.py` | R15 + `import os` 修复 |
| 8 | `scripts/_probe_plugin_envelope.py` / `_probe_plugin_center.py` | **新建**（只读探针） |

**未修改**（按你的约束逐项确认）：`runtime.py`、`PluginManifest`、
`CAPABILITY_REGISTRY`、`EnterpriseToolGate` 核心策略逻辑、
`tools/environments/*`、`tools/mcp_tool.py`、`api/toolsets.py`、`api/capability_router.py`。

---

## 架构变化

```
                    Agent Gateway
                         │
                 Capability Router
                         │
                  RoveAgent Runtime
                         │
         ┌───────────────┼───────────────┐
      Tools            MCP            Plugins
         │               │               │
         │               │        ┌──────┴───────┐
         │               │        │ Plugin Center │ ← 新增（7 端点）
         │               │        │ Security Env. │ ← 新增（声明⟷实际审计）
         │               │        └──────────────┘
         ▼               ▼
   ┌─────────────────────────────────────┐
   │ Command Policy Layer（新增，命令粒度）│ ← R16
   └──────────────────┬──────────────────┘
                      ▼
   ┌─────────────────────────────────────┐
   │ EnterpriseToolGate（既有，工具粒度）  │ ← 唯一执行门，核心未改
   └──────────────────┬──────────────────┘
                      ▼
              Approval System
                      ▼
              Sandbox Runtime
                      ▼
              External Services
```

关键性质：**新增两层的默认行为都是「只观察不改变」**，因此接入
Phase 3 不会静默改变任何既有部署的放行结果。启用强制需显式 env。

---

## 测试结果

```
$ python -m pytest roveagent/api roveagent/tools/permissions_policy_test.py -q
115 passed, 235 subtests passed in 30.31s   （Phase 2c 时是 97）

$ python -m pytest roveagent/api/command_policy_test.py -q
18 passed, 75 subtests passed                （新增）

$ 路由
TOTAL 24   plugin 7                          （Phase 2c 时 17 条）

$ python scripts/_e2e_developer_loop.py
[summary] 7/7 checks passed                  （无回归）

$ python scripts/_e2e_devops_readonly.py
[summary] 7/7 checks passed                  （无回归）

$ pnpm exec tsc -p tsconfig.json --noEmit
exit 0
```

**安全信封实测（54 插件）**：

```
severity counts: {'OK': 11, 'HIGH': 32, 'CRITICAL': 11}
untrusted_total: 0        ← 当前无第三方插件
needs_review: []          ← 因此运维待办为空（正确）
bundled_high_risk: [43 个 bundled 高危项，供安全审计参考]
```

---

## 新发现风险

| # | 风险 | 说明 | 处置 |
|---|---|---|---|
| ~~R15~~ | 插件 hook 失败静默吞掉 | **已修**：区分不可用/执行失败/明确 block；失败记 warning，可选 fail-closed | — |
| ~~R16~~ | 只读/破坏性无法在门控层区分 | **已修**：新增 Command Policy Layer（默认只报告，env 开启强制） | — |
| **R17** | 命令策略是**文本级**判定，不是 shell 语义级 | 正则无法穷尽 shell 语法（变量展开、`$(...)`、base64 编码的 payload）。`echo $(rm -rf /)` 之类可能绕过 | 它是**纵深防御的一层**，不是唯一防线。真正的隔离仍需容器沙箱（`tools/environments/docker.py`）。若要强保证，需要「白名单可执行文件 + 参数校验」而非黑名单关键词 |
| **R18** | bundled 插件有 32 HIGH / 11 CRITICAL | 随产品分发、随产品审计，**不是漏洞**，但说明「插件能起子进程/读写文件」是常态 | 建议：①为 bundled 插件补 `network`/`filesystem`/`sandbox` 声明，让信封从「未声明」变成「已确认」；②CI 里跑信封审计，新插件必须声明 |
| **R19** | `plugin_center` 的 install 会拉取**不可信代码** | 安装后其代码与 bundled 插件同进程加载 | 当前 `untrusted_total=0`。首次安装第三方插件前，建议先定「第三方插件是否必须容器隔离」的策略 —— 这正是 Phase 3 标题里的 MCP 边界 |
| R2/R3 | `video_generate`/`tts`/`vision` 缺凭据 | 未变 | Phase 4 处理 |
| R7 | DB 迁移未应用 | 未变 | 有凭据环境执行 |
| R8 | TS→浏览器未经运行时验证 | 未变 | 提供 `.env` |
| R9 | 仓库既有失败测试 | 未变 | 建议清理 |

---

## 下一步：Phase 4（Media Hub + Document Runtime）

按目标模式继续，不等待确认。Phase 4 计划：

1. **Media Hub 统一接口**：`media.generate_image/video/audio` + `media.edit`
   —— 复用既有 `core/image_gen_provider` / `video_gen_provider` registry
   与 7 个 image provider、3 个 video provider（**不新建 provider 框架**）
2. **`image_generate` 真实上游验证**：Phase 1 重建了该模块但无凭据未验证，
   Phase 4 用 Mock provider 做接口级验证
3. **Document Runtime 中文 PDF**：`public/fonts/` 投 Noto Sans CJK，
   打通中文 PDF（一行配置，与其它 Phase 无耦合）

继续推进。
