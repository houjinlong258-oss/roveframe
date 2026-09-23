# Phase 19 —— 上线阻断项收口报告

本文件记录本次收口把哪些阻断项关到什么程度。判定沿用四层口径：
**L1 代码存在 → L2 测试通过 → L3 真实调用 → L4 生产路径可用（真实入口 + 有人能被叫醒）**。
**不拿 L1/L2 冒充 L3/L4。**

## 0. 一句话

三个阻断项都动手修了：**生产入口真的跑起来并验证了调度器**（L4），
**告警从"文档里的表格"变成可加载的规则文件 + 能失败的校验器**（L3/L4），
**schema 门禁从 11 张手写表变成 52 张表 / 601 列的连库比对**（L3）。
跑生产入口的直接代价是暴露了一个四轮审计都没看见的缺陷：
**通知队列从来没被消费过**（SQL 函数 42702），已修代码但**尚未应用到真实库**
（缺 DB 密码），因此 48 行通知仍在积压 —— 这条新告警规则会持续报它。

## 1. 逐项状态

| 项 | 层级 | 证据 | 未完成的部分 |
|---|---|---|---|
| 阻断项 2 生产入口 | **L4** | A/B 对照：同 135 秒内 `next start` 心跳冻结（`heartbeat.at` 两次完全相同、`tickAgeMs` 341112418、`health_scheduler_ok 0`），`node dist/server.js` 心跳推进（age 28s、`ok: true`、`heartbeatStale: false`） | 无 |
| 阻断项 2 附带发现：通知队列 | **L1**（代码已修，库未改） | 真实库 RPC 调用返回 `400 {"code":"42702","message":"column reference \"attempts\" is ambiguous"}`；阳性对照 `claim_daily_briefing_slot → 200 true` | **需要 DB 密码应用**：`$env:RF_DB_PASSWORD='...'; npx tsx scripts/_apply_claim_fn_fix.mts notification` |
| 阻断项 3 告警规则 | **L4**（规则机器校验 + 与真实端点对照） | `13` 条规则；`node scripts/check-alert-rules.mjs` 通过；`--base` 对照新构建通过、对旧构建**变红**（列出 5 个缺失指标）；7 种注入全部变红 | 规则**没有被 Prometheus 真正加载过**（本环境无监控栈）。PromQL 语义正确性由 Prometheus 加载时校验，此处只校验结构/指标名/注释 |
| 阻断项 6 schema 门禁 | **L3** | `[ok] 核对 52 张表 / 601 列，无漂移`；对照：人为加一列 → 报缺列；从 live 删一张表 → 报缺表；读不到 schema → fail-closed 报缺失 | 列**类型**不比对（只比名字）；11 张"代码在用但 schema.ts 未声明"的表由测试钉住而非运行时门禁 |
| 非阻塞 1 审计失败语义 | **L2** | 修复前 2 条红（执行成功却报 ok:true）、修复后 5/5 绿并带正方向对照 | 无 |
| 非阻塞 2 支付行为测试 | **L2** | 19/19；签名验证含必须为 true 的正面对照；三条路由无凭据 401 | 成功路径（真实退款/对账）需真实 Stripe 凭据 |
| 非阻塞 3 未引用路由 | **L2** | 33/132 未被引用；其中 14 条有真实副作用的写路由已真实调用并断言 401/403 | 剩下 19 条（含只读与 405 恒拒）未补 |
| 非阻塞 4 纯静态测试 | **分析**（见 §4） | 26/109 个测试文件从不 import 产品代码 | 未逐个改写；见 §4 的处置建议 |
| 非阻塞 5 健康检查耗时 | **L3** | p50 **5145ms → 1062ms**（同为 15 次采样；旧实现 11 张表串行探测，新实现 1 次 schema 文档 + 全量比对） | 每次抓取 ~386KB 文档；未加缓存（缓存会让漂移检测变旧，取舍见 §3） |
| 非阻塞 6 死代码 | **已完成** | 全仓检索 0 调用点、无再导出、packages/ 无消费者；删除后 `rg` 复查只剩注释 | 无 |
| 非阻塞 7 保留期清理 | **L3** | 生产入口日志 `purged 16 expired delivery position(s)`；留存 2 行实测 0.6h（在 24h 窗口内）；新增行为测试 3/3 | 无 |
| 非阻塞 8 孤儿账号 | **L3（只读）** | `auth.users=20 public.users=4 孤儿=16`；备份文件写出 16 条；`--delete` 无备份时 exit 2 | **刻意不删**，见 §5 |
| 非阻塞 9 注释与代码不一致 | **L2** | 加了真限流（20 次/分钟），4 条行为断言；回退修复后 4/4 变红 | 无 |
| 非阻塞 10 无 importer 子目录 | **分析 + L2** | `roveagent/social`：6 文件 2641 行、**包外 0 条入边**（阳性对照 `src/lib/roveagent` 14 条；反向对照 `roveagent/gateway` 448 条） | **判断：接线**（不删不归档），但需平台适配器与真实运行时才能验证 |

## 2. 生产入口 A/B 对照（阻断项 2 的全部意义）

观察对象是 `cron_state` 里的 `scheduler.heartbeat`（调度器每 tick 落库的心跳）。

| 观察 | `next start -p 5069` | `node dist/server.js`（PORT=5068） |
|---|---|---|
| 进程内等待 | 135 秒（≥2 个 tick 周期） | 30 秒 |
| `heartbeat.at` | `2026-09-19T16:03:45.565Z`（**两次完全相同**） | `2026-09-23T14:49:45.568Z`（**推进**） |
| `tickAgeMs` | 341112418（约 3.95 天） | 30806 |
| `scheduler.ok` | `false` | **`true`** |
| `heartbeatStale` | `true` | **`false`** |
| 指标 `roveframe_health_scheduler_ok` | `0` | **`1`** |

生产入口的启动日志同时给出了另外三件只有真实入口才会发生的事：

```
✓ [boot-check] 数据库 schema 完整          ← 新的全量漂移检测
[scheduler] purged 16 expired delivery position(s) for 000…000/000…001
⚠️ [rate-limit] 使用进程内限流状态：本进程必须单副本运行
[dotenv] injecting env from scripts\deploy.env
```

以及那个缺陷：

```
[scheduler] notification outbox worker failed:
  Error: notification outbox claim failed: column reference "attempts" is ambiguous
```

`claim_notification_outbox` 的 `returns table` 里 `attempts`/`max_attempts` 是 OUT 参数名，
租约回收的 UPDATE 却写成未限定的 `attempts >= max_attempts` → PL/pgSQL 无法判断指变量还是表列。
后果：48 行 `notification_outbox` 满足全部认领条件（`status=queued`、`available_at` 已过、
`claimed_at` 为空），`attempts` 永远是 0，最久 441879 秒（5.1 天）。
这是同**一类**缺陷第二次上线（第一次是 `claim_agent_task_runs` 的 `attempt`），
现已加通用守卫（`tests/sql-claim-function-guard.test.ts`）：从 SQL 解析 OUT 参数名、
从真实库取列名，判定"同名且未限定"。

## 3. 值得单独说明的取舍

- **健康检查不缓存 schema 文档。** 每次抓取约 386KB / ~0.7-1s。加 5 分钟缓存能省这部分开销，
  但会让"刚发生的漂移"在最多 5 分钟内不可见。在一个把"静默降级"当主要风险的仓库里，
  我选择保持实时，并把取舍写在这里而不是悄悄加缓存。
- **缺席的指标一律判失败，除非显式 `--allow-absent`。** 校验器第一版把"指标缺席"当注释放过，
  结果对**旧构建**也报通过 —— 一个对旧构建与正确构建给出同样结论的探针等于没有探针。
- **孤儿账号不删。** 判定条件与不可逆风险见 §5。

## 4. 非阻塞 4：26 个纯静态测试文件的处置建议（未逐个改写）

分类依据：文件只 `readFileSync` 源码/迁移文本、从不 import 产品代码。

| 类别 | 例子 | 建议 |
|---|---|---|
| **契约快照，文本是对的介质** | `i18n-parity`（messages 与 `t()` 键集合）、`migration-column-coverage`（schema 与 SQL 对齐）、`pwa-tier`、`demo-data-visibility` | **保留**。它们断言的是"两个文件之间的一致性"，本来就没有运行时可观察的行为。 |
| **本该连库，已有连库版本替代** | `rls-policy`（文本）→ 已有 `rls-coverage-live`（连库） | 保留文本版做快速反馈，连库版做真实验证。两者都要。 |
| **可疑：断言了一个"不会被调用"的实现** | `notification-claim-visible`、`command-policy-enforced`、`high-risk-routes` | 需要逐个人工判定（本轮时间不够，**未做**）。判据：把被测实现改坏，测试会不会红？不会红的就补真实调用或删掉。 |

## 5. 只有人能做 / 需要人拍板

| # | 事项 | 为什么 |
|---|---|---|
| 1 | **轮换凭据**（第六轮挂账） | 只能在各控制台操作。`.env` 与 `scripts/deploy.env` 两个文件都要改 |
| 2 | **是否做自动续费** | 产品决策。当前定位是"人工开通 + 线下收款"，`stripe.ts` 只有一次性支付 |
| 3 | **应用通知队列的 SQL 修复** | 需要 DB 密码：`$env:RF_DB_PASSWORD='...'; npx tsx scripts/_apply_claim_fn_fix.mts notification`。在此之前 48 行通知继续积压 |
| 4 | **社交能力接线 or 归档** | 2641 行实现、0 生产 importer、能力清单已在对外承诺（`WIRED=False` 已声明）。接线需平台适配器凭据与可验证的运行时 |
| 5 | **孤儿账号是否清理** | 判定条件：`auth.users` 有行且 `public.users` 无同 id 行（16 条，全部测试生成）。不可逆且无 auth 备份通道 → 本轮不删。工具默认 dry-run，`--delete` 必须与 `--export` 同用 |

## 6. 本轮无法验证的（UNVERIFIED）

| 项 | 卡在哪 |
|---|---|
| 通知队列修复的**真实生效** | 缺 DB 密码，无法执行 `create or replace function` |
| 告警规则被 Prometheus 加载 | 本环境没有监控栈；只做了结构 + 指标名 + 真实端点对照 |
| `roveagent/social` 接线后的行为 | Python 运行时容器不可达（`/api/health` 的 `runtime.unreachable`） |
| 真实 Stripe 退款/对账 | 无商户凭据 |
| 列**类型**漂移 | 当前门禁只比列名 |
| 26 个纯静态测试文件逐个改写 | 本轮时间不足，已在 §4 给出分类与判据 |
