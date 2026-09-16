# Operations Runbook

Phase 12 / P0-4。面向运维的最小可执行手册：备份、恢复、回滚、可观测性。
每条命令都可直接执行；无法验证的部分显式标注。

---

## 1. 备份

### 1.1 应用侧状态（必须）

RoveAgent 的数据根（容器内 `/data`）装着聊天会话、租户记忆、审计记录、任务队列、
已安装技能。**丢失即永久丢失**，而审计链路本身也在这上面。

```bash
# 备份默认数据根（ROVEAGENT_ROOT，缺省 .roveagent）
node scripts/backup.mjs

# 指定数据根与输出目录
node scripts/backup.mjs --root /data --out /backups

# 校验一份备份（逐文件 sha256 复校）
node scripts/backup.mjs --verify /backups/2026-09-16T11-09-37-448Z
```

产物结构：

```
/backups/<UTC 时间戳>/
├── manifest.json      # createdAt / source / 每文件 sha256+字节数 / 统计
└── data/              # 数据根的完整副本
```

**校验器已验证能拒绝损坏**，不是"总是 OK"：删除文件、大小不符、同大小内容篡改
（只能靠 sha256 发现）、目录里没有 manifest —— 四种都返回非零退出码。

| 注意事项 | 说明 |
|---|---|
| SQLite 热备 | 服务运行中复制 `.db` 可能拿到写入中途的快照。脚本会显式告警。要一致快照请停服务或使用容器卷快照 |
| 不加密 | 输出含租户数据，请落在受控位置 |
| 位置 | `/backups` 必须在容器卷之外，否则卷丢了备份也没了 |

### 1.2 数据库（外部 Supabase）

**刻意不放进脚本。** 备份它需要 DSN 或供应商凭据，而在应用服务器上放数据库超级凭据
正是 R-03 刚消除的模式。二选一：

1. **托管备份**（推荐）：在 Supabase 项目设置里启用 PITR / 每日备份。无需凭据。
2. **独立备份机**：在有凭据的机器上 `pg_dump "$DATABASE_URL" -Fc`，产物落对象存储。
   不要把 `DATABASE_URL` 配到本应用服务器。

应用侧状态与数据库是**两类互补的恢复单元**，两者都要有。

---

## 2. 恢复

```bash
# 1. 校验备份可用（恢复前必做，别在故障中才发现备份是坏的）
node scripts/backup.mjs --verify /backups/<stamp>

# 2. 停服务，避免写入与恢复竞争
docker compose stop web roveagent

# 3. 恢复数据根（先留一份现场，别直接覆盖）
mv /data /data.pre-restore-$(date +%s)
cp -a /backups/<stamp>/data /data

# 4. 起服务并确认
docker compose start roveagent
curl -fsS http://localhost:8788/api/health        # 期望 200
```

数据库恢复依赖 §1.2 选择的方式；Supabase 托管备份在控制台按时间点恢复。

---

## 3. 回滚

### 3.1 先演练，不要在生产上首次尝试

```bash
node scripts/rollback-drill.mjs                 # 演练回退到 HEAD~1
node scripts/rollback-drill.mjs --to <commit>   # 演练回退到指定提交
node scripts/rollback-drill.mjs --to <commit> --keep   # 保留 worktree 供人工检查
```

演练在**临时 worktree** 里进行，不触碰当前工作树，结束时自动清理。它会核验：

1. 目标提交可达且能完整检出（不是只存在于 reflog 的悬空对象）；
2. 关键文件齐备（`package.json` / `server.ts` / Python runtime / 部署产物 / CI）；
3. **两个提交之间的 schema 与迁移差异** —— 这是最容易出事的一步。

实测两个有价值的判定：

| 演练目标 | 判定 |
|---|---|
| `HEAD~1` | 无 schema 变化 → 纯代码回滚，风险较低 |
| `7a7f90d`（Phase 11 之前） | ① 跨越 `schema.ts` 与 `migrate-runtime-metadata.sql` 变更 → 警告<br>② 缺少 `Dockerfile` / `Dockerfile.roveagent` / `docker-compose.yml` → **判定回滚路径不可用** |

第二条正是演练的价值：回退到 Phase 11 之前会**丢掉整个容器部署能力**，这是
"回滚"这个词在纸面上看不出来的后果。

### 3.2 真实回滚步骤

```bash
# 1. 确认手上有一份可用的状态备份
node scripts/backup.mjs --verify /backups/<stamp>

# 2. 切代码（或从目标提交重建镜像）
git checkout <commit>

# 3. 按演练的 schema 结论决定迁移方向 —— 有差异时不要跳过这一步
#    代码回滚而迁移不回滚，旧代码会读到不认识的列；
#    反过来，新代码已写入的数据在旧 schema 下不可读。

# 4. 重建镜像并重启
docker compose up -d --build

# 5. RoveAgent 状态卷不要动 —— 回滚代码不等于回滚数据
curl -fsS http://localhost:5000/api/health
```

---

## 4. 可观测性

### 4.1 已有

| 能力 | 位置 | 说明 |
|---|---|---|
| 存活/就绪探针 | `GET /api/health`（web） | 数据库 + 调度器 + **Python 运行时**三项汇总；503 表示未就绪 |
| 运行时存活探针 | `GET /api/health`（runtime） | 无鉴权，只返回存活状态（不含租户数等业务字段） |
| 运行时详细信息 | `GET /api/health/detail`（runtime） | 需 `X-RoveAgent-Key` |
| 请求 id 贯通 | `src/proxy.ts` | 每个响应带 `x-request-id`，复用上游合法值，非法值重新生成 |
| 工具门控审计 | `<ROVEAGENT_ROOT>/audit/tool_gate.jsonl` | 每次工具调用一条：tool / risk / required_permissions / allowed / reason |
| 业务审计 | `<ROVEAGENT_ROOT>/audit/external-<tenant>.jsonl` | 按租户分文件 |
| 运行日志 | `<ROVEAGENT_ROOT>/logs/` | `roveagent.core.log` / `errors.log` |
| AI 用量账本 | `ai_usage_ledger` 表 | 每次 provider 调用一行：成功=ok / 失败=error |

### 4.2 排查入口

```bash
# 一次请求的完整追踪：从响应头拿到 id，再在各层日志里 grep 它
curl -i http://localhost:5000/api/health | grep -i x-request-id

# 最近被门控拒绝的工具调用（最常见的"功能不工作"根因）
docker exec roveframe-roveagent-1 sh -c 'tail -20 /data/audit/tool_gate.jsonl'

# 运行时错误
docker exec roveframe-roveagent-1 sh -c 'tail -50 /data/logs/errors.log'
```

### 4.3 仍缺（未做，如实记录）

| 缺口 | 影响 |
|---|---|
| 无 APM / 分布式追踪 | 只有日志与 request id，没有跨服务火焰图 |
| 无指标导出（Prometheus 等） | 无法做趋势与告警，只能事后翻日志 |
| 无告警规则 | 出问题要人先发现 |
| 无日志聚合 | 多实例时需逐容器查看 |
| 无自动备份调度 | 当前需外部 cron 调 `scripts/backup.mjs` |

这些都需要引入外部系统（APM/时序库/日志平台），属于架构决策而非代码修复，
因此本阶段只做到"可追踪、可备份、可回滚"，并在此明确列出剩余缺口。
