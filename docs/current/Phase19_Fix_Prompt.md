# Phase 19 修复提示词 — 关闭上线就绪度审查的剩余阻塞项

> 用途：把本文件全文粘贴给另一个 AI（或另一个会话），让它接手完成独立审查报告里**尚未关闭**的部分。
> 交接时 HEAD = `dff8464`（RLS 阻塞项已由本次会话关闭）。基准审查 HEAD = `69a5eec`。

---

## 你的任务

独立审查报告的结论是：

> 不能作为"自助收费 SaaS"上线；可以作为"人工开通 + 线下收款"的托管交付上线，但先要堵住一个数据层缺口。

那条数据层缺口（RLS）**已经修完**（证据见下）。你的任务是关闭**剩下的**阻塞项，并把非阻塞项按优先级处理完。
不要重做 RLS，不要"重新审查一遍然后写报告"——要**动手改代码**，每项都要有能证伪的命令。

---

## 先做的第一件事（不要跳过）

```powershell
git log --oneline -5
git status --porcelain
```

工作树必须干净。这个仓库有**多个 agent 在并发写入**：
动手前先看 `git log`，不要覆盖别人的改动；如果你看到不是自己写的未提交改动，先停下报告，不要 reset/stash。

然后读这三份事实源，别只读本文件：

```
docs/current/Outstanding_Work_Inventory.md          # 未完成项清单（实测得出）
docs/current/Phase18_Audit_And_Gap_Closure.md        # 上一轮审计与收口
scripts/migrate-rls-gaps.sql                         # 已完成的 RLS 修复（作为写法参考）
tests/rls-coverage-live.test.ts                      # 连接式回归测试的写法参考
```

---

## 已经关闭的：数据层缺口（RLS）——不要重做

修复提交：`199690e`。实测证据（同一把 anon key）：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 无 RLS 的表 | 12 | 0 |
| 有 RLS 但零策略的表 | 18 | 0 |
| 策略总数 | 139 | 175 |
| anon 读 `delivery_orders` | 21 行 | 0 行 |
| anon 读 `delivery_positions` | 16 行 | 0 行 |
| service_role 读 `orders`（应用路径） | 64 行 | 64 行（未削弱） |

`src/lib/migration.ts` 的清单从 18 项扩到 20 项（此前 `migrate-rls.sql` **从未在自动清单里**，
即"写了但永远不会执行"）。回归测试 `tests/rls-coverage-live.test.ts` 是**连接式**的——
这是关键：仓库里原有的 RLS 测试只读 SQL 文本，而"有 RLS 无策略"恰恰是文本完全正确、运行时完全敞开。

如果你怀疑 RLS 没生效，用这两个只读脚本复核（不要改它们）：

```powershell
node scripts/_verify_rls_anon_blocked.mts    # anon vs service_role 对照
node scripts/_verify_rls_fixed.mts           # pg_class/pg_policies 结构复核
```

---

## 阻塞项 2：生产入口从未被验证过（`node dist/server.js`）

**事实**：生产入口是 `node dist/server.js`（`scripts/start.sh`）。
`next start` **不会**加载 `src/server.ts`，因此 `startScheduler()` 在 `next start` 下**永远不跑**。
轮询式副作用（外发队列、超时关单、`purgeOldPositions`）在只有 `next start` 的进程里等于不存在。

基准审查报告这条为**无法验证**：验证需要停机窗口。所以要你来做。

**要求**：

1. 构建：`pnpm build`（= `next build && tsup src/server.ts --format cjs --platform node --target node20 --outDir dist`）。
2. 在**另一个端口**启动真实入口：`node dist/server.js`（先读 `scripts/start.sh` 确认它期望的环境变量与端口，`PORT`/`DEPLOY_RUN_PORT`）。
3. 证明调度器**真的在跑**，而不是"日志里出现了 scheduler 字样"：
   - 找到 `src/lib/scheduler.ts` 的 `startScheduler()` 打了什么日志、第一个 tick 的间隔是多少；
   - 用可观测的副作用证明它执行过（例如 `cron_state` 表被写入/推进，或 `purgeOldPositions` 的删除计数）；
   - **负向对照**：用 `next start` 起一个实例，断言同一副作用**不出现**。做不到这一点就说明你没证明任何事。
4. 记录：两个进程的行为差异、你实际观察到的行数/时间戳。

**注意**：不要动当前正在服务的 `http://127.0.0.1:5067`（那是 `next start` 起的演示实例）。
另起端口，验证完关掉。不要用 `taskkill /T /F`（实测无效，会留残余进程）；
用 `Get-CimInstance Win32_Process` + `Stop-Process`，按唯一 `--user-data-dir` 或端口过滤。

---

## 阻塞项 3：没有任何告警规则

**事实**：指标端点存在，但仓库里**零个**告警规则文件（无 prometheus/grafana/alert 目录，无 `*.yml` 规则）。
"有指标"不等于"会有人被叫醒"。

**要求**：

1. 先摸清现有可观测面：指标端点返回哪些指标名、`/api/health` 返回哪些字段、`runBootChecks()` 暴露什么。
2. 写**最小可用**的告警规则集，落地成文件（建议 `ops/` 或 `deploy/` 下，跟现有部署文件放一起，先看仓库既有约定）。
   至少覆盖：
   - 健康检查失败 / 运行时不健康（reachability）；
   - 调度器不推进（这是阻塞项 2 的运行时对应面）；
   - 队列积压（外发邮件/推送）；
   - 支付 webhook 失败或对账不一致。
3. 规则必须**可执行**，不是文档里的一段 YAML 示例。给出校验命令（例如 `promtool check rules`，
   但**禁止为此新增依赖** —— 如果 promtool 不在环境里就用标准库写一个解析/断言脚本，或者如实说明该规则未被机器校验）。
4. 每条规则要能回答："这条报警了，值班的人第一步做什么？"

---

## 阻塞项 6：启动自检只覆盖 11/52 张表，且没有真正的 schema 漂移门禁

**事实**：`src/lib/boot-check.ts` 的 `REQUIRED_TABLES` 只有 **11** 项（`cron_state, staff,
business_memories, agent_actions, agent_approvals, payments, payment_events, ai_usage_ledger,
platform_admins, tenant_subscriptions, platform_admin_audit_logs`），而 schema 里有 **52** 张表。
更关键的是 `scripts/verify-migrations.mjs` 是**文件级**检查（比对 SQL 文本），**从不连接数据库**——
所以它挡不住"库里真的缺列"。

**要求**：

1. 别再手工维护一份子集清单。写成**从 `src/lib/migration.ts` 的 `MIGRATION_FILE_LIST` 派生**的检查，
   或者做一个真正的 schema-diff 门禁：拿 `schema.ts` 与实际库的 `information_schema.columns` 比对。
2. 门禁必须在**真的缺列时变红**。做法：先把某个必需的列在测试库上 drop（或者用一份构造的假 schema 输入），
   断言检查失败，再恢复。**没有这一步的"通过"不算通过。**
3. 明确"缺表/缺列时系统是什么行为"：现在是 fail-closed 还是静默降级？如果是静默降级，
   改成 fail-closed 并说明改了哪里。
4. 注意 `health_check` 自己也是张表 —— 别让自检依赖它自己要检查的东西。

---

## 非阻塞项（按这个顺序做）

| # | 问题 | 位置 | 要求 |
|---|---|---|---|
| 1 | 审计写入失败被吞掉，但同一路径的 mutation-guard 是 fail-closed（503）。**同一条链上两种失败语义** | `src/lib/enterprise/tool-runtime.ts:256,260,283,287` 的 `.catch(() => undefined)` | 对齐成 fail-closed。先证伪：构造一次审计写失败，看现在是否静默返回成功；改完必须变成明确失败 |
| 2 | 支付路由只有**源码文本**断言（`checkout`/`refund`/`reconcile`） | `src/app/api/payments/{checkout,refund,reconcile}/route.ts` | 补行为测试：金额校验、幂等、签名失败必须拒绝、上游 5xx 不得当成成功 |
| 3 | 34/132 条路由从未被任何测试引用 | `tests/` | 不是"每个都补测试"——先分类：哪些有真实副作用（写库/外发/扣款），优先补这些 |
| 4 | 26/109 个测试文件从不 import 产品代码 | `tests/` | 这些是"断言写虚"的高发区：它们可能只读源码文本。逐个判定是保留（契约快照）还是补真实调用 |
| 5 | `/api/health` p50 ≈ 4s（`runBootChecks` 串行探每张表） | `src/lib/boot-check.ts:60` | 健康检查被部署 preflight 调用，4s 会拖慢/超时。改成并行或分批，并给出改前改后的实测耗时 |
| 6 | `getAuthContext()` 是死代码 | `src/lib/auth-guard.ts` 附近 | 先做真正的可达性分析再动 —— 这个仓库的教训是"自造可达性工具曾对 `business_data_tool` 有假阴性"。确认无引用后再删，或说明为什么不删 |
| 7 | 保留期/TTL 的删除任务事实上不执行 | `purgeOldPositions` 在 `src/lib/scheduler.ts:543`，只在调度器里 | 与阻塞项 2 同源。调度器真跑起来后才算解决；写一条能证明"过期行真的被删"的测试 |
| 8 | 16 条孤儿 `auth.users` | 数据库 | 先给出**判定条件**（什么算孤儿）和**不可逆风险**，再决定删还是标记。不要在没备份的情况下删 |
| 9 | `/api/onboarding/parse` 的注释声称有"输入长度与频率的自我保护"，实际只有长度 | `src/app/api/onboarding/parse/route.ts:12` | 二选一：真的加限流（复用 `src/lib/rate-limit.ts`），或把注释改成事实。**注释与代码不一致本身就是缺陷** |
| 10 | 一个子目录（约 2635 行）没有任何生产 importer | 先自己定位（提示：在 `src/lib/roveagent/` 下找无入边的模块） | 不要直接删。先做可达性分析，给出"接线 / 归档 / 删除"的判断和依据 |

---

## 需要人来决定的两件事（你不要自作主张）

1. **凭据轮换**：已连续 5 轮未做。`.env` 与 `scripts/deploy.env` **两个文件都要改**（轮换时）。
   这需要人的决定与操作，不在你的范围内 —— 在报告里如实列为未关闭，不要假装解决了。
2. **是否做付费自动续费**：`src/lib/payments/stripe.ts` 全文没有 `subscription` 这个词，
   只有第 57 行的 `params.set('mode', 'payment')`（一次性支付）。
   要变成"自助收费 SaaS"需要 Stripe 订阅模式 + webhook 生命周期闭环 + 对账，这是**产品决策**。
   在当前"人工开通 + 线下收款"的定位下，先保证手工开通链路是**幂等且可对账**的；
   不要在没人拍板的情况下自己实现自动扣款。

---

## 纪律（这个仓库为此翻过五次车，逐条都是硬要求）

1. **先验证再修改**：动手前先跑一次能证伪该改动的命令。不知道现状就不要改。
2. **任何"通过 / 干净 / 0 命中"的结论，必须先有一个能产生"不通过"的负向对照。**
   把修复回退掉，断言必须变红；做不到就说明该断言无效，要如实说"这个断言不证明任何事"。
   已有三次是审计者自己的测试把**正确**的代码判成错。
3. **数字必须来自本次实测。** 无法测量的写 `UNVERIFIED`，不要推断、不要继承旧数字。
4. **零新增依赖**：只用 pnpm 已有的、Node/Python 标准库。**严禁 npm/yarn**。
5. **禁止静默 fallback**：宁可 fail-closed 报错。Phase 15 的教训是一次 `if (error) return []`
   让一个 SQL 缺陷隐藏了 11 天。
6. **禁止**：删除未知代码（除非先做真正可达性分析）、重构大模块、新增重复架构。
7. **改完必须自己跑一次**：`pnpm validate`（exit 0 才算过），必要时加 `pnpm test:python`。
8. **更正旧结论时**，用 `<details>` 把原文保留下来，不要悄悄改掉。
9. 每项独立提交，commit message 里写清：改了什么 / 为什么 / 怎么验证的 / **我此前错在哪**。

---

## 环境事实（省你时间，都是实测的）

- 包管理器：**pnpm only**（`package.json` 有 `preinstall` 守卫）。
- 当前演示实例：`http://127.0.0.1:5067`（`next start`，**不是**生产入口，见阻塞项 2）。
- Docker daemon **未运行**；运行时容器 8788 从宿主机不可达，因此 `/api/health` 返回 503、
  `health_runtime_ok 0`、`health_scheduler_ok 0` —— 这是环境事实，不是代码缺陷。
  `scripts/_verify_p18_http.mjs` 会因此报恰好 1 条失败。
- 数据库是用户自有 Supabase（PostgREST + GoTrue + Storage），服务端一律 `service_role`。
  **DDL 通道**：PostgREST/API key **没有** DDL 权限；直连 `db.<ref>.supabase.co` 是 IPv6-only（沙箱不可达），
  必须走 Session pooler `aws-0-us-east-1.pooler.supabase.com`（user `postgres.<ref>`）。
  密码问用户要，**不要写进任何文件、不要 echo**。直连会间歇性被掐断，优先用 pooler。
- 已有助手：`npx tsx scripts/_apply_sql_migration.mts <sql>` 应用迁移并打印效果检查（连跑两次验证幂等）。
- **PowerShell 陷阱**：`[locale]`、`(marketing)`、`[id]` 被当通配符 → 用 `-LiteralPath`；
  反引号与 `${}` 会被 shell 吃掉 → 写成脚本文件再跑；
  `Select-String -Path` 的 glob 不可靠 → 用 `rg`。
- 登录/注册限流是**进程内内存**（15 分钟自锁）→ 测试脚本用随机 `X-Forwarded-For`。
- 生产扫描禁止在受跟踪文件里出现某个旧品牌词（跑 `pnpm scan:production` 会告诉你是什么）。
- 沙箱里 `node --test` 直接跑测试文件会 `ERR_MODULE_NOT_FOUND`，用 `npx tsx --test <file>` 或 `pnpm test`。

---

## 完成判定（四层，缺一层就写"未完成"）

| 层 | 含义 |
|---|---|
| L1 | 代码存在 |
| L2 | 测试通过 |
| L3 | 真实调用过（真连库/真探针/真进程，不是读源码文本） |
| L4 | 在生产路径上可用（真实入口、真实配置、有人能被告警叫醒） |

**禁止用 L1/L2 冒充 L3/L4。** 本轮审查已经发现多处这种冒充：
`verify-migrations.mjs` 是文件级检查却被当成 schema 验证；
"52/52 表覆盖"是我的探针测的，而 `/api/health` 自己的 `missingCount: 0` 只覆盖 11 张表；
路由从未被引用是 34/132（我早期报的 39 口径不同，审查者的第一版 29 是自污染的）；
我自己报的"浏览器 14/14"审查者只复验到 1/14。

---

## 交付

1. 每个阻塞项一个提交，commit message 按上述格式。
2. 一份**平实、精确、短句、表格优先**的报告：不用 emoji、不夸大、700 词以内；
   结论放最前；每个数字标注来源命令；做不到的写 `UNVERIFIED` 并说明卡在哪。
3. 报告里必须有一节**"我此前错在哪"**（如果这一轮更正了任何旧结论，用 `<details>` 保留原文）。
4. 结束时 `git status --porcelain` 必须为空，`pnpm validate` exit 0。
