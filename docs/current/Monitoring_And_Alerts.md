# 监控与告警配置（Phase 15）

本文件补上 `Operations_Runbook.md` §4.3 列出的缺口：**指标导出、告警规则、备份调度**。
它是**配置说明**：代码侧只提供 `/api/metrics`（文本行格式），
采集与告警需要部署方接入自己的监控栈（属架构决策，本仓库不引入依赖）。

---

## 1. 指标端点

```
GET /api/metrics
```

**鉴权**（必读）：本端点不在公开白名单里，需要下列任一：

| 方式 | 用途 |
|---|---|
| `X-RoveAgent-Key: <ROVEAGENT_API_KEY>` | 采集器（服务间共享密钥） |
| `rf_admin_session` cookie | 人从浏览器查看 |
| 非生产且未配置服务端密钥 | 本地 curl 调试 |

生产环境（`COZE_PROJECT_ENV=PROD`）**不会**因"未配置密钥"而放行。

```bash
curl -fsS -H "X-RoveAgent-Key: $ROVEAGENT_API_KEY" \
  http://127.0.0.1:5000/api/metrics
```

### 导出的指标

| 指标 | 类型 | 含义 |
|---|---|---|
| `roveframe_process_uptime_seconds` | gauge | 进程运行时长 |
| `roveframe_process_resident_memory_bytes` | gauge | 常驻内存 |
| `roveframe_process_heap_used_bytes` | gauge | V8 堆使用 |
| `roveframe_health_database_ok` | gauge | 必需表齐全 = 1 |
| `roveframe_health_runtime_ok` | gauge | Python 运行时存活 = 1 |
| `roveframe_health_scheduler_ok` | gauge | 调度器**有心跳证据** = 1 |
| `roveframe_scheduler_last_tick_age_seconds` | gauge | 距上次心跳的秒数（无心跳时不输出） |
| `roveframe_ai_calls_total{status=...}` | counter | AI 调用计数（来自 `ai_usage_ledger`） |
| `roveframe_outbox_pending{queue}` | gauge | 队列待处理行数（Phase 19） |
| `roveframe_outbox_oldest_pending_seconds{queue}` | gauge | 最老待处理项的年龄（Phase 19） |
| `roveframe_outbox_failed_total{queue}` | gauge | 失败/死信行数（Phase 19） |
| `roveframe_payment_events_unprocessed` | gauge | 未处理完的支付回执数（Phase 19） |
| `roveframe_payment_events_oldest_unprocessed_seconds` | gauge | 最老未处理回执的年龄（Phase 19） |
| `roveframe_payments_total{status}` | gauge | 支付行按状态分组（Phase 19） |
| `roveframe_metrics_collection_ok{collector}` | gauge | 采集器查询成功 = 1（Phase 19） |

**刻意不含业务数据**（租户数、营收、订单）。指标端点常被长期留存，
不应成为第二条数据泄漏路径。有测试守住这一条。

`roveframe_metrics_collection_ok` 是**防"会撒谎的指标"**用的：采集查询失败时，
对应的数据指标会**缺席**而不是报 0 —— 否则后端故障会表现为"队列是空的"，
依赖它的告警永远不触发，而一切看起来正常。

---

## 2. 告警规则

⚠️ **本节原文只有"可判定的表达式"表格，没有任何可加载的规则文件。**
独立审查把它记为上线阻断项 3："指标端点存在，但仓库里零个告警规则文件。
'有指标'不等于'会有人被叫醒'。"

现在规则的**事实源是文件，不是本文**：

| 项 | 位置 |
|---|---|
| 规则集（13 条，Prometheus 格式） | `ops/alerts/roveframe.rules.yml` |
| 校验器（零依赖，不用 promtool） | `scripts/check-alert-rules.mjs` |
| 接入闸门 | `tests/alert-rules.test.ts`（随 `pnpm validate` 跑） |
| 校验命令 | `node scripts/check-alert-rules.mjs`（加 `--base <url> --key <k>` 再与真实端点对照） |

校验器会拒绝：引用了源码里不存在的指标名、缺 `runbook`/`severity`/`for`、
重复的 alert 名、空 expr、以及**解析到的规则数与文件里 `- alert:` 出现次数不一致**
（最后一条是"解析器不撒谎"的唯一保证）。七种注入（假指标名、缺 runbook、
缺 severity、重复 alert 名、截断文件、缺 for、解析器少读）已实测全部变红。

每条规则的 `annotations.runbook` 回答"值班第一步做什么"——
写不出来就说明这条规则不该存在。

### 阈值与取舍（以下是设计依据，不是规则文件本身）

#### P1 —— 服务不可用

| 规则 | 表达式 | 建议阈值 |
|---|---|---|
| web 不可用 | `up{job="roveframe-web"} == 0` | 立即 |
| 数据库不可用 | `roveframe_health_database_ok == 0` | 立即 |
| 运行时不可达 | `roveframe_health_runtime_ok == 0` | 持续 5m |

注：落地文件里"服务消失"用的是 `absent(roveframe_health_database_ok)` 而不是
`up{...}`。差别在于前者不依赖采集器配置正确（指标一条都没有 = 采集目标整个消失），
而 `up` 是本仓库不导出的外部序列 —— 校验器只允许引用本仓库导出的指标。

#### P2 —— 静默降级（最容易长期无人发现）

| 规则 | 表达式 | 说明 |
|---|---|---|
| 调度器无证据 | `absent(roveframe_scheduler_last_tick_age_seconds)` | 心跳从未写过；`/api/health` 会同时报 `source: "unknown"` |
| 调度器心跳过期 | `roveframe_scheduler_last_tick_age_seconds > 300` | 超过 5 个 tick 周期 |
| 调度器降级 | `roveframe_health_scheduler_ok == 0` | `cron_state` 缺失或心跳停摆 |

**为什么这三条重要**：调度器一旦停摆，邮件外发、IMAP 同步、Square 同步会**同时**静默停止。
没有心跳指标时，这类故障只能靠"用户发现邮件没发出去"。
**Phase 19 实测**：这正是当前演示实例的状态 —— 进程以 `next start` 启动，
`src/server.ts` 从未被加载，调度器心跳停在 3.9 天前。

#### P3 —— AI 服务（**未落地**，如实记录）

| 规则 | 表达式 | 说明 |
|---|---|---|
| AI 错误率上升 | `rate(roveframe_ai_calls_total{status="error"}[15m]) > 0.2` | 需按实际量调整 |
| **完全无 AI 调用** | `rate(roveframe_ai_calls_total[1h]) == 0` | 可能是上游故障，也可能是**没人用** —— 需人判断 |

这两条**没有**写进规则文件：它们需要按真实流量调参，而当前环境产生不了真实流量
（Python 运行时不在这台机器上，`roveframe_health_runtime_ok` 恒为 0）。
写一条无法被验证的规则，等于给自己一个"已覆盖"的错觉。

#### P4 —— 资源

| 规则 | 表达式 | 说明 |
|---|---|---|
| 内存持续偏高 | `roveframe_process_heap_used_bytes > 1.5e9` | 落地文件用堆而不是 RSS：RSS 含 V8 未回收的高水位，误报更多 |
| 进程频繁重启 | `changes(roveframe_process_uptime_seconds[1h]) > 2` | 说明在 crash-loop |

#### 队列与支付（Phase 19 新增，本节原先完全没有）

原先**没有任何队列/支付指标**，因此写不出可执行的规则 —— 只能写出永远不触发的规则。
已补指标（见 §1）并落地 5 条规则：推送积压、邮件积压、死信、
支付 webhook 卡住、支付失败新增。

积压按**最老一条的年龄**触发而不是按行数：一次正常的批量入队会造成瞬时堆积，
按行数会误报；**排了很久没人处理**才是故障。

---

## 3. 备份调度

`scripts/backup.mjs` 已存在且**校验器做过负向验证**（删文件 / 改大小 / 同大小篡改都能拒绝）。
缺的只是**定时执行**。二选一：

### 方案 A：宿主机 cron（推荐，最简单）

```cron
# 每日 03:15 备份 RoveAgent 数据根，产物写在容器卷之外
15 3 * * *  cd /opt/roveframe && node scripts/backup.mjs --root /data --out /backups >> /var/log/roveframe-backup.log 2>&1

# 每周日 04:00 校验上周备份（备份没恢复过就等于没有备份）
0 4 * * 0   cd /opt/roveframe && node scripts/backup.mjs --verify "$(ls -1d /backups/*/ | tail -1)" >> /var/log/roveframe-backup.log 2>&1
```

**注意**（来自 `Operations_Runbook.md` §1.1）：

- `/backups` **必须在容器卷之外**，否则卷丢了备份也丢了；
- 服务运行中复制 SQLite 可能拿到写入中途的快照，脚本会显式告警；
- 产物含租户数据，**不加密**，请落在受控位置。

### 方案 B：容器 sidecar

在 compose 里加一个只跑 cron 的服务挂同一份卷。代价是多一个容器，
收益是备份与数据根同生命周期。**本轮未实现** —— 需要真实的备份保留策略
（保留几份、放哪、是否异地），属部署决策。

### 数据库备份

**刻意不在脚本里**（需 DSN 或供应商凭据，而在应用服务器放数据库超级凭据
正是 R-03 刚消除的模式）。二选一：

1. **Supabase 托管备份 / PITR**（推荐，无需凭据）；
2. 独立备份机 `pg_dump "$DATABASE_URL" -Fc`，产物落对象存储。

---

## 4. 仍未做（如实记录）

| 项 | 原因 |
|---|---|
| 日志聚合 | 需外部系统（多实例时目前只能逐容器 `docker logs`） |
| 分布式追踪 | 只有 request id 贯通，无跨服务火焰图 |
| 指标保留与容量规划 | 取决于所接监控栈 |
| 备份保留策略与异地 | 部署决策 |
| 从备份**真实恢复**演练 | 手册有步骤，但未在本环境跑过一次完整恢复 |

最后一条值得强调：**备份没恢复过就等于没有备份**。校验器只证明文件没坏，
不证明恢复流程可用。
