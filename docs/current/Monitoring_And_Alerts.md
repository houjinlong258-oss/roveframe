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

**刻意不含业务数据**（租户数、营收、订单）。指标端点常被长期留存，
不应成为第二条数据泄漏路径。有测试守住这一条。

---

## 2. 告警规则

按优先级排列。**每条都给了可判定的表达式**，不用"感觉不对劲"当阈值。

### P1 —— 服务不可用

| 规则 | 表达式 | 建议阈值 |
|---|---|---|
| web 不可用 | `up{job="roveframe-web"} == 0` | 立即 |
| 数据库不可用 | `roveframe_health_database_ok == 0` | 立即 |
| 运行时不可达 | `roveframe_health_runtime_ok == 0` | 持续 5m |

### P2 —— 静默降级（最容易长期无人发现）

| 规则 | 表达式 | 说明 |
|---|---|---|
| 调度器无证据 | `absent(roveframe_scheduler_last_tick_age_seconds)` | 心跳从未写过；`/api/health` 会同时报 `source: "unknown"` |
| 调度器心跳过期 | `roveframe_scheduler_last_tick_age_seconds > 300` | 超过 5 个 tick 周期 |
| 调度器降级 | `roveframe_health_scheduler_ok == 0` | `cron_state` 缺失或心跳停摆 |

**为什么这三条重要**：调度器一旦停摆，邮件外发、IMAP 同步、Square 同步会**同时**静默停止。
没有心跳指标时，这类故障只能靠"用户发现邮件没发出去"。

### P3 —— AI 服务

| 规则 | 表达式 | 说明 |
|---|---|---|
| AI 错误率上升 | `rate(roveframe_ai_calls_total{status="error"}[15m]) > 0.2` | 需按实际量调整 |
| **完全无 AI 调用** | `rate(roveframe_ai_calls_total[1h]) == 0` | 可能是上游故障，也可能是**没人用** —— 需人判断 |

### P4 —— 资源

| 规则 | 表达式 | 说明 |
|---|---|---|
| 内存持续偏高 | `roveframe_process_resident_memory_bytes > 1.5e9` | 1.5 GB；web 镜像本身较大，按机器调整 |
| 进程频繁重启 | `changes(roveframe_process_uptime_seconds[1h]) > 2` | 说明在 crash-loop |

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
