# Dead-Code Deletion — Stop Report

Phase 13。结论：**计划的死代码删除已终止，因为它建立在一个错误的审计前提上。**
本文件记录证据与修正后的判断。未删除任何代码。

---

## 1. 计划

按审计报告的死代码清单，分三块删除 `roveagent/gateway/`（约 40,000 行）：

1. `gateway/platforms/**`
2. `gateway/{base,session,slash_commands,stream_consumer}.py`
3. `gateway/run.py`

每块之间跑全量测试。用户已提供全量源码备份（`git archive HEAD`，2703 条目，
17.7 MB，已校验含 `gateway/run.py` 且零凭据文件），约束前提已解除。

## 2. 执行前的验证（本仓库规矩：先验证再修改）

对 `roveagent/**/*.py` 全量检索 `from|import roveagent.gateway.*`，排除 `gateway/` 自身：

**结果：33 个顶层名字被 `gateway/` 之外的代码导入。**

其中包含**生产主路径**上的模块：

| 导入方 | 导入内容 | 该模块的角色 |
|---|---|---|
| `core/agent_init.py:1687` | `gateway.session_context` | **Agent 构造路径**（Phase 11 Task 3 优化的就是它） |
| `core/conversation_compression.py:2001,4930` | `gateway.session_context` | 上下文压缩 |
| `core/delegation_context.py:60` | `gateway.session_context` | 子任务委派 |
| `cron/scheduler.py`（20+ 处） | `config` / `status` / `session` / `platforms.base` / `relay` / `mirror` / `delivery` / `media_policy` / `profile_routing` / `session_context` / `media_repair` | **定时任务调度器** |
| `toolsets.py:928` | `gateway.platform_registry` | 工具集解析 |
| `clisupport/gateway.py`（30+ 处） | `status` / `config` / `restart` / `shutdown_watchdog` / `platform_registry` / `platforms.*` / `run` | 网关服务管理 |

被外部引用的 33 个顶层名字：

```
<pkg>            authz_mixin      browser_control_broker  channel_directory
code_skew        config           control_socket          delivery
disk_status      drain_control    hosted_room_execution_policy
lifecycle_ledger media_policy     media_repair            memory_status
mirror           pairing          platform_registry       platforms
profile_routing  readiness        relay                   response_filters
restart          run              session                 session_context
shutdown_forensics  shutdown_watchdog  slash_access      status
sticker_cache    whatsapp_identity
```

## 3. 审计为什么会得出"死代码"

审计的判据是：**「`api/` 内零模块级 gateway 导入；`python -m gateway.run` 是独立入口」**。

这句话本身没错，但它检验的是**模块级导入**，而上面这些导入**绝大多数是函数级惰性导入**，形如：

```python
def _something(self):
    from roveagent.gateway.session_context import set_current_session_id
    set_current_session_id(...)
```

这类导入在模块级扫描里完全不可见，却在运行时真实执行。
"从 `create_app()` 不可达"与"无人使用"是两件不同的事：`core/` 与 `cron/`
不是从 `create_app()` 的**模块级**导入图可达的，但它们是**运行时**可达的。

## 4. 修正后的判断

- **`roveagent/gateway/` 不是死代码**，是 `core/`、`cron/`、`clisupport/`、`toolsets.py` 的活跃依赖。
- 按原计划删除会直接打断 Agent 构造、上下文压缩、定时任务与工具集解析 —— 即审计报告自己列为"生产级护城河"的那部分控制面。
- **删除计划终止，未删除任何代码。**

## 5. 对审计其余死代码条目的影响

同一条目里的其他项也需要重新验证，因为它们很可能用了同样的判据：

| 条目 | 状态 |
|---|---|
| `roveagent/gateway/`（约 40,000 行） | **已证伪** —— 活跃依赖 |
| `roveagent/skills_market/`（2,441 行） | **已不适用** —— Phase 12 Task 4 已把其安全能力吸收进 `skills/` 安装路径，它现在是 `skills/` 的实现细节 |
| `src/lib/agent/permissions/engine.ts` | **未验证** |
| `src/lib/enterprise/memory.ts` | **未验证** |
| `getAuthContext` + `RF_HEADERS` + `injectRfHeaders` | **未验证**（注：`injectRfHeaders` 在 `src/proxy.ts` 中被**实际调用**，见 §6） |
| `src/lib/plugins/*`（TS，66 行） | **未验证** |
| `@aws-sdk/client-s3` + `lib-storage` | **未验证** |
| `skills_library/` 非业务分类（261 md） | **未验证** |

## 6. 顺带发现：审计把三个东西混为一谈，实际只有一个真的没用

审计称 `getAuthContext + RF_HEADERS + injectRfHeaders`「全仓库 0 读取 → 死代码」。

实测（`src/**/*.ts` 全量检索）：

| 名字 | 定义处 | 调用点 | 判定 |
|---|---|---|---|
| `injectRfHeaders` | `src/lib/auth-guard.ts:86` | **`src/proxy.ts:18`（import）、`:79`（调用）** | **活跃** |
| `getAuthContext` | `src/lib/auth-guard.ts:337` | **无** | 确实无用 |
| `RF_HEADERS` | `auth-guard.ts` | 随上述两者 | 需逐项判断 |

`src/proxy.ts` 是网络边界中间件，**每个 API 请求都经过**。因此该条目对
`injectRfHeaders` 而言是错的；只有 `getAuthContext` 符合"0 读取"。

三个名字被并成一条结论，是这条死代码清单不可直接采信的又一个例证。

## 7. 真正该做的事

要判断某个模块是否真的没人用，需要一个**真正的可达性分析**，而不是导入文本扫描：

1. 从真实入口出发（`roveagent/api/app.py::create_app`、`clisupport/main.py`、
   `cron/scheduler.py` 的启动点、`python -m gateway.run`）；
2. 展开**函数级**导入（惰性导入也算边）；
3. 得到可达集合，其余才是候选死代码；
4. 每个候选在删除前用一次全量测试确认。

这属于独立一轮的工作量，且收益是"审计面收窄"而非"功能增加"，
因此不应在未完成分析前动刀。

## 8. 一句话

备份为删除解除了约束前提，但**验证发现删除本身是错的**：
`gateway/` 是活跃依赖，不是死代码。终止删除，记录证据，不做破坏性变更。
