# RoveFrame AI Business OS — Phase 16 接续任务：从"能演示"到"能收钱"

## 工作目录

```
D:\RoveFrame AI Business OS\RoveFrame AI Business OS\roveframe-src-latest
```

Next.js 16 (TS) + Python RoveAgent Runtime 双栈。Phase 1–15 已完成"让系统在真实环境跑起来"；
**Phase 16 的目标是让它成为能向外收费的产品**。

---

## 0. 开工前必读（不要跳过）

按顺序读这些，它们是你判断的**唯一事实基础**：

| 文件 | 作用 |
|---|---|
| `docs/current/Phase15_Completion_Audit.md` | **最重要**。完成度盘点 + 剩余项 + 三个"看起来能用其实不能"的发现 |
| `docs/current/Phase15_Real_Environment_Continuation_Report.md` | Phase 15 全部修复的证据链（含 RLS、迁移、调度器心跳、平台回落） |
| `docs/current/Monitoring_And_Alerts.md` | 指标端点、告警规则、备份调度 |
| `docs/current/Operations_Runbook.md` | 备份/恢复/回滚/排查 |
| `docs/current/Real_Environment_Acceptance_Report.md` | Phase 14 首次真实环境验收 |
| `docs/current/Phase12_Audit_Remediation_Report.md` | 安全/可靠性修复全清单 |
| `docs/current/Dead_Code_Deletion_Stop_Report.md` | **为什么死代码删除被终止**（必读，防止重犯） |
| `docs/current/Reachability_Analysis_Result.md` | 静态可达性工具的假阴性 |

`AGENTS.md` 里的"常见陷阱"清单是踩出来的，**逐条读**。

---

## 1. 当前已核实状态（可直接采信，但建议抽样复验）

```
git log --oneline -1     # 9d2d8cf
git status --porcelain   # 应为空
```

| 项 | 值 |
|---|---|
| TypeScript 测试 | **726**（0 失败） |
| Python 测试 | **815** OK（4 个有据可查的跳过） |
| `pnpm validate` | **exit 0** |
| 容器 | `roveframe-roveagent-1` / `roveframe-web-1` 均 healthy |
| 镜像 | `roveframe/roveagent-runtime:phase12`、`roveframe/web:phase13` |
| 数据库 | 真实 Supabase。锚点 tenant `000…000` / business `000…001`；当前 1 tenant / 1 business / 0 孤儿 |
| 测试残留清理 | `scripts/_cleanup_test_residue.mts --apply`（public 侧）+ `scripts/_cleanup_auth_users.mts --apply`（auth 侧） |

**环境事实**

| 项 | 值 |
|---|---|
| compose 环境 | `docker/deploy.env`（gitignored，已指向真实库） |
| 仓库凭据 | `scripts/deploy.env`（gitignored） |
| 数据库密码 | 见文末"需要的钥匙" |
| 构建 | `auth.docker.io` 常不可达 ⇒ `DOCKER_BUILDKIT=0 docker build ...`；**不要用 `--no-cache`**（会退回 BuildKit 并失败），缓存坏了用 `docker build --no-cache` + `DOCKER_BUILDKIT=0` 同时给 |
| 用户已明确 | 所有环境均为测试环境，可自由读写 |

---

## 2. 必须先内化的四条工作纪律

这是本项目最核心的规矩，前面每一轮都靠它避免了错误决策。

### 2.1 先验证，再修改

三次实例（都写在报告里）：

1. 审计说 `agent_build` 4 秒瓶颈是 `get_tool_definitions()` —— **实测 0.71 ms/次，假设被证伪**。真正热点是 SSL CA 重复校验与本地端点探测无负缓存。
2. 审计说 `gateway/` 是 4 万行死代码 —— **实测 33 个外部导入方**，删了会打断 Agent 构造、上下文压缩、定时任务。
3. 自造的可达性工具判 `business_data_tool` 不可达 —— **但它在生产里真实驱动过工具调用**，证明工具有假阴性。

**动手前先跑一次能证伪你想要做的那个改动的命令。**

### 2.2 任何"通过/干净/0 命中"的结论，必须先有能产生"不通过"的负向证据

这是踩出来的：`git grep --cached` 位置错误导致错误被 `2>$null` 吞掉，"命令失败"被误读成"零泄漏"，用阳性对照才发现。

**Phase 15 又踩了四次同类，全部记录在案：**

| 错误的守卫 | 症状 | 教训 |
|---|---|---|
| `_verify_real_database.mts` 的表存在性探针 | 对**不存在**的表也报"存在"（`head:true` 让 404 变 204） | "33/33 存在"是假阳性，真实是 51/51 |
| `boot-check.ts` 的生产自检 | 同一形态 ⇒ 自检**不具检测能力**，永远报"schema 完整" | 已修 + 回归守卫 |
| 我自己写的依赖图守卫 | `@/lib/x` 被当成仓库根路径解析 ⇒ **只检查了入口文件**，整个依赖图从未遍历 | 负向对照才暴露 |
| 我自己写的迁移覆盖守卫 | 第一版"无法失败"——删掉迁移它照样通过 | 换成可失败的不变量 + 用临时迁移做对照 |

**规矩：每个新守卫都要跑一次"把修复回退掉，它必须变红"。** 做不到就说明守卫无效。

### 2.3 禁止事项

- **禁止删除未知代码**（除非先做真正的可达性分析，见 `Dead_Code_Deletion_Stop_Report.md`）
- **禁止重构大模块**
- **禁止新增重复架构**
- **禁止引入无必要依赖**（零新增依赖，仅 pnpm / Node / Python 标准库）
- **禁止静默 fallback** —— 宁可 fail-closed 报错
  （Phase 15 的教训：`if (error) return []` 让一个 SQL 缺陷隐藏了 11 天）

### 2.4 报告写法

平实、精确、陈述式、短句。表格优先。不用 emoji，不夸大。
**更正自己先前的结论时必须保留原文**（用 `<details>` 折叠），不留"当时说得很严重、后来悄悄改掉"的痕迹。
无法测量写 **UNVERIFIED**，禁止用推断代替证据。

---

## 3. Phase 16 任务清单（按严重度，即建议执行顺序）

### ★ 任务 1：仪表盘在零数据账户上编造增长数字【最该先做】

**这不是 bug，是产品在说假话。** 新商家注册后看到的第一屏就是编造的增长率。

已核实（`src/app/api/dashboard/route.ts`）：

```
L154: ordersDelta: 8.4,
L155: customersDelta: 5.2,
L156: ratingDelta: 1.2,
L150: todayCustomers: Math.round(todayOrders.length * 1.8),   ← 订单数 × 1.8 编的
L249-252: (RF_E2E_DEMO 分支里同样写死)
```

**要求**
- 真实计算这些 delta（与上一周期对比）；**算不出来就返回 null 并让 UI 显示"—"**，不得编造。
- `todayCustomers` 必须真查客户数，不用倍数估算。
- 演示数据继续**只在** `RF_E2E_DEMO=1 && COZE_PROJECT_ENV !== 'PROD'` 下生效（现有门控保留）。
- 补测试：断言"零数据账户的 delta 必须为 null 或 0，不得为 8.4/5.2/1.2"。负向对照：把写死的数字放回去，测试必须变红。

---

### ★ 任务 2：订阅与权益门禁 —— 平台目前收不到商家的钱

已实测（真实库 + 源码）：

| 观测 | 实测值 |
|---|---|
| `subscription_plans` 行数 | **0**（且**没有任何脚本灌过它**） |
| `tenant_subscriptions` / `invoices` / `feature_entitlements` | **全部 0 行** |
| `createStripeCheckoutSession` | 硬编码 `mode: 'payment'`（一次性），**无 `mode:'subscription'`**（`src/lib/payments/stripe.ts:57`） |
| 唯一调用方 | `src/app/api/payments/checkout/route.ts:83` 要求"恰好一个 reservation 或 order" ⇒ 那是**商家收自己客户的钱**，不是平台收商家的钱 |
| 前端调用 `/api/payments/*` | **0 处** |
| 注册流程 | 不建订阅、不建试用（`src/app/api/auth/signup/route.ts:70-111`） |
| 权益校验 | `tenant_subscriptions` 只被 3 个 admin 路由读 ⇒ **欠费/停用商家仍全功能** |
| 续费 | 手工离线（`admin/tenants/[id]/route.ts:96-110` 写 `renewal_source='offline'`） |

**要求（这是一个决策 + 一轮实现，不是架构改造）**
1. **先做决策并写进报告**：商家如何付费？推荐最小可用方案 —— 平台管理员手工开通 + 离线收款（现有 admin 路由已支持），**并同时实现权益门禁**。全自动 Stripe 订阅（Customer / Price / Billing Portal / webhook 续期）是更大的工程，可作为第二阶段。
2. **必须实现权益门禁**：`tenant_subscriptions` 状态（trialing/active/past_due/suspended/expired）影响功能可用性。
   - 未开通/过期 ⇒ 只读或明确提示，**不能继续全功能**。
   - 门禁要 fail-closed。
3. **`subscription_plans` 必须有数据**：写一个幂等 seed（放到 `MIGRATION_FILES` 覆盖的 SQL 或独立幂等脚本），并让 `/api/admin/subscriptions` 能列出真实套餐。
4. **注册时建订阅**：至少建一个 `trialing` 记录（含 `trial_ends_at`），让门禁有对象可判。
5. 补测试：断言"停用状态的商家访问受限" + "plan_id 必须指向真实存在的 plan"。两者都要负向对照。

---

### ★ 任务 3：新客户第一天的路径是断的

已核实：

| 问题 | 证据 |
|---|---|
| 注册**不建 `settings` 行** | `src/app/api/auth/signup/route.ts` 无 settings 写入；真实库 settings 仅 1 行（锚点） |
| 店铺菜单显示字面量 `"Store"` | `src/app/api/store/menu/route.ts:21` 读 `settings.business.name`，而注册把名字写在 `businesses.name`（`src/lib/auth.ts:149`） |
| 货币设置被忽略 | 向导把货币写到 `business.currency`，而菜单读 `settings.locale.currency`（`onboarding/confirm/route.ts:55`） |
| **无任何引导接入模型服务商** | 除设置页外无提示；失败信息**只有中文**（`src/lib/ai/router.ts:311-323`） |
| 引导向导是**孤儿页** | 无导航入口、无跳转；且**整页硬编码中文**，无 `onboarding` i18n 命名空间 |
| 向导创建的工作区**会话到不了** | `onboarding/confirm/route.ts:40-66` 不更新 `public.users.business_id` 与 JWT `app_metadata` |

**要求**
- 注册时建 `settings` 行（business.name 与语言/货币写进去），或在 `getSettings` 的合成行里回落到 `businesses` 值 —— **二选一，不要两套都做**。
- 错误信息走 i18n（三语）；`noPlatformProviderError` 不能只有中文。
- 向导**要么接进流程、要么删掉**：接进去就要补 i18n 命名空间（三语）并修好工作区归属；删掉要先做可达性分析并写进报告（禁止无分析删除）。
- 补测试：断言新注册商家的 `/api/store/menu` 返回**真实店铺名**而非 `"Store"`。

---

### ★ 任务 4：群发邮件法律上不可用

已核实：

- **没有退订、没有 opt-in、没有 `List-Unsubscribe` 头**（`src/lib/email/outgoing.ts:72-79` 只设 from/to/subject/text）。
  ⇒ 欧美加批量发信**合规硬阻断**。
- 商家按钮**不走审批**（`marketing/page.tsx:191-204`），而 Agent 路径走审批 —— 两条路径不一致。
- 发送是**一个 HTTP 请求里串行 N 次 LLM 调用**（`marketing/send/route.ts:103-126`），真实名单必然超时。
- UI 的"账号可用"判定（`marketing/send/route.ts:58-61`）**只查 `is_default`**，而 worker 要求 `status='active'` + `smtp_host` + `credentials_encrypted`（`outgoing.ts:45-54`）⇒ **按钮可用但每封都失败**。
- 保存邮箱账号时**不验证 SMTP**，"已连接"是无证据的断言。
- Outlook 预设用 465 端口，而 Office 365 不接受（需 587/STARTTLS）。

**要求**
- 加 `List-Unsubscribe` 头 + 退订链接 + 退订表/字段；发送前过滤退订用户。这是本任务的**硬要求**。
- 统一 UI 判定与 worker 判定（抽成一个函数，两处共用 —— 参照 Phase 15 的 `connectors/capabilities.ts` 单一事实源做法）。
- 发送改为**入队**（已有 `email_send_tasks` + scheduler worker），不在 HTTP 请求里串行生成。
- 保存邮箱账号时做一次真实连接测试，失败就别写"已连接"。
- 修 Outlook 端口。
- 补测试：断言"退订用户不会被发送" + "UI 判定与 worker 判定一致"。负向对照。

---

### ★ 任务 5：扫码点餐"能下单但收不到钱、也叫不动厨房"

已核实：

| 问题 | 证据 |
|---|---|
| 不收款 | 订单 `status='pending'`，`orders/route.ts` 全文无任何支付调用；小费只记录不扣 |
| 不通知厨房 | 新订单**无任何通知**；`enqueueNotification` 只在异常检测/任务 worker/一个工具里调用；无页面自动刷新；无打印 |
| 重复下单 | 服务端支持 `Idempotency-Key`（`orders/route.ts:56-59,115-125`），但唯一的客户端**从不发**（`store/page.tsx:87-97`） |
| 无可分享菜单链接 | 只有每桌 token，无 slug；无 token 即 404 |
| 二维码 URL 缺 locale 前缀 | `business/page.tsx:224,371` 生成 `/store?token=…`，而 `localePrefix:'always'` |

**要求（按可交付性排序）**
1. **客户端补 `Idempotency-Key`**（最容易、收益明确）。
2. **新订单通知商户**（复用 `notification_outbox` + 现有 scheduler worker）。
3. **收款**：接 Stripe（代码已在 `src/lib/payments/`，硬编码问题见任务 2）—— 先想清楚是"顾客扫码即付"还是"到店付"，这是产品决策，写进报告。
4. 二维码 URL 补 locale 前缀并实测跳转保留 query。

---

### 任务 6：团队无法入驻

已核实（`src/app/api/auth/invite/route.ts`）：
- 返回 `invite_url: null`（L102-103）
- 只传 `data: { business_id, role }` 给 `inviteUserByEmail`（L78），**不写 `app_metadata.tenant_id`** ⇒ 被邀请人**永远无法认证**（`auth.ts:219-221`、`auth-guard.ts:164`）
- `redirectTo` 指向 `<origin>/auth/callback`，该路由**不存在**
- **没有任何 UI 调用它**
- 另外：manager **没有** `marketing:send` 权限（`src/lib/rbac.ts:15`），所以只有 owner 能发群发邮件

**要求**：修通邀请（补 tenant_id、修 redirectTo、加 UI 入口）或明确删除功能。补测试：断言被邀请者能通过 `resolveUserByToken`。

---

### 任务 7：审批闭环之外还有绕过路径

已核实：`marketing` 生成/保存、`reviews` 起草/发布、`channels/send` 都**从 UI 直接写**，不经审批。
`reviews` 的 UI **完全不用**审批路径。

**要求**：明确哪些写入**必须**经审批（建议：对外可见的动作），统一到一条路径；不能两套并行。这是设计决策，写进报告再改。

---

### 任务 8：性能尾部（实测数据）

| 指标 | 实测 |
|---|---|
| p50 | 320 ms |
| p90 | 12.4 s |
| **p99** | **89 s** |
| `tool-planning` p90 | **26.3 s** |

**要求**：定位 89 s 的成因（是单次慢调用、冷启动、还是重试叠加）。先取证再改（参照 `_verify_latency_breakdown.mts` 的 SSE 事件时间戳做法）。

> 注意：**单位成本不是问题** —— 实测约 $0.0023/次对话（21 会话 / 5.9k in + 2.4k out），300 次/月 ≈ $0.70。$29 套餐完全覆盖。**约束是延迟，不是成本。**

---

### 任务 9（延续项，未完成但有价值）

| 项 | 状态 |
|---|---|
| 水平扩展：限流/并发槽接入共享后端 | 契约已显式化且可检测（`src/lib/rate-limit-contract.ts`）。真正接入要把 **12 处同步调用改为 await**，属跨模块改造 |
| 可观测性：APM / 日志聚合 | 指标端点与告警规则已就绪（`/api/metrics` + `Monitoring_And_Alerts.md`），需引入外部系统 |
| RAG 嵌入 provider 抽象（P1-5） | 需先选定第二个嵌入后端，否则抽象没有验证对象 |
| 插件沙箱 L4（P1-3） | 当前候选集为空（54/54 bundled，0 community），仅在引入社区插件时才需要 |
| `gateway/` 死代码处置 | 沿用 Phase 13 结论（**活跃依赖，未删**）。要动必须先做真正的可达性分析 |
| 镜像体积 1.57 GB | `output: 'standalone'` 未启用（需实测，不是无脑开启） |
| `agent_tasks` worker 命令策略 | `ROVEAGENT_COMMAND_POLICY` **在仓库里 0 引用** ⇒ CTO persona 的真实 shell 只被记录、不被阻止。HIGH 风险，建议评估 |
| 解耦工具死代码 | `registerDefaultTools` **零调用方**（仅测试引用）—— 需可达性分析后才能判 |

---

---

### 任务 10：外部集成还有三处"名义存在、实际不可用"

| 集成 | 实况 | 层级 |
|---|---|---|
| **ERPNext** | 设置页显示"已连接"，而同步端点对非 square 直接 400；只 ping 通，**数据永远不会到达**。Phase 15 已修成 `connectivity_only` 语义并加 UI 明示，但**同步本身仍未实现** | L1 |
| **RAG / 知识库** | `src/lib/embedding.ts:6` 是 `new EmbeddingClient(undefined, …)` —— 凭据来自**平台运行时身份**，无应用级 env var ⇒ **自部署下抛错**。即知识库功能不是自托管的 | L4 仅限平台 |
| **社交发布** | `capability_router.py:89-91` 声称 CMO 有"社交发布（需审批）"，但运行时**没有任何社交发布工具** | 不存在 |

**要求**
- ERPNext：要么实现真实同步，要么把 UI 入口改成"仅连通性"并**去掉同步按钮**（不要留一个点了会失败的东西）。
- RAG：属 P1-5，需先选定第二个嵌入后端再抽象（否则抽象没有验证对象）。若短期不做，**在文档里写明"知识库依赖平台"**，不要让它看起来可自托管。
- 社交发布：改掉 `capability_router.py` 的措辞，或在报告里记为"承诺未交付"。

---

### 任务 11：一处 HIGH 风险的命令策略未启用

`ROVEAGENT_COMMAND_POLICY` **在仓库里 0 引用**（实测），而 `gate_hook.py:157-199` 表示：
未设为 `enforce` 时，非只读命令**只被记录、不被阻止**。

CTO persona（`cto` → `devops`）暴露了**真实的 `terminal` / `process`**，只需**一次 manager 审批**，
而该 persona 持有 `admin:process` 权限 ⇒ 权限检查通过。

**要求**：先取证 —— 实测在当前配置下一条非只读命令能否通过；然后决定是设为 `enforce`、还是限制该 persona 的工具集。**这是安全决策，写进报告再改。**

---

## 4. 已知的坑（踩过，别重踩）

1. **`scripts/` 必须进 web 镜像** —— `src/lib/migration.ts` 启动时读 `scripts/*.sql`。
2. **`ENCRYPTION_SECRET` 必须与 `COZE_SUPABASE_SERVICE_ROLE_KEY` 不同**；历史数据需要 `ENCRYPTION_SECRET_PREVIOUS`（已配置）。
3. **compose 用显式环境变量白名单** —— 只加到 `docker/deploy.env` 的变量**不会**进容器，必须同时在 `docker-compose.yml` 里命名。
4. **`server.ts` 的依赖图不得出现 `next/server`** —— 会让容器启动即崩（`AsyncLocalStorage` invariant），而 `next build` 与 `tsc` 都通过。已有守卫（`tests/rate-limit-contract.test.ts`）。
5. **Windows PowerShell 把 `[locale]`、`(marketing)`、`[id]` 当通配符** —— 用 `-LiteralPath`，否则会得到假结果甚至误删文件（本会话真的误删过一次）。
6. **`next build` 会跑全项目 `tsc`**，包括 `scripts/**/*.mts` —— 脚本里一个类型错误会**阻断镜像构建**。
7. **Next.js 可能给不同路由独立模块实例** —— `/api/health` 与 `startScheduler()` 不是同一个实例。任何跨模块共享状态都不能靠模块变量（调度器心跳落库就是为此）。
8. **迁移清单只有一个事实源**：`src/lib/migration.ts` 的 `MIGRATION_FILES`。`scripts/verify-migrations.mjs` 从它解析；不要写第二份清单。
9. **改 `claim_agent_task_runs` 的返回列必须同步改 `src/lib/agent/tasks/types.ts`** —— 字段名不匹配会让 worker 拿到 `undefined` 静默跑偏。
10. **负向对照时先复制备份再注入** —— 本会话有一次在注入后才复制，还原把回归恢复了（测试抓住，但浪费一轮）。
11. **`docker builder prune` 清不掉经典构建器的层存储** —— 缓存坏了要 `DOCKER_BUILDKIT=0 docker build --no-cache`。
12. **`pnpm validate` 里 `&&` 串联** —— 任何一步失败，后面全部不执行（Phase 15 曾因此让 5 个步骤长期没跑过）。
13. **`tests/*.test.ts` 里有相当比例是源码文本断言**（Phase 15 实测 TS 侧约 15.5%）——
    它们能防回归，**不能证明功能可用**。新写测试时优先**调用真实函数/handler**，
    而不是 `readFileSync` + `assert.match`。本会话新增的 `tests/high-risk-routes.test.ts`
    是可直接照抄的范式（真实调用 handler，无 mock，无副作用）。
14. **`_verify_*.mts` 脚本要写进 `tests/` 才能被 `pnpm validate` 覆盖** ——
    `scripts/` 下的脚本只被 `next build` 的 `tsc` 检查类型，**不会被执行**。
    端到端类验证需要人工/gate 运行，不要以为放进 `scripts/` 就等于纳入 CI。
15. **同一仓库可能同时有别的代理在改** —— 本机装有两套代理框架。开工前
    `git status` 与 `git log` 对一下；若发现非自己的改动，**不要直接覆盖**，
    先弄清来源。建议约定同一时刻只有一个代理写这个仓库。

---

## 5. 验收口径（沿用，不得放宽）

**"完成"必须区分四层**：代码存在 / 测试通过 / 真实调用 / 生产可用。
报告里每一项都要标注属于哪一层。

**每条结论必须能追到一条可复现的命令及其原始输出。**
无法测量写 **UNVERIFIED**。

**不以"代码增加"验收，而以"真实运行能力增加"验收。**

具体到 Phase 16，以下必须有**真实环境**证据（不是 mock、不是静态断言）：

| 项 | 需要什么证据 |
|---|---|
| 仪表盘不编造 | 新注册账户的实际 `/api/dashboard` 响应，delta 为 null/0 |
| 权益门禁 | 把某 tenant 置为 expired，实际请求被拒；恢复后可用 |
| 注册首日路径 | 新注册后 `/api/store/menu` 返回真实店铺名 |
| 退订 | 真实发送一封带 `List-Unsubscribe` 的邮件；退订后不再收到 |
| 点餐幂等 | 同一 `Idempotency-Key` 发两次，库中只有一单 |
| 邀请 | 被邀请账号能通过 `resolveUserByToken` |
| 延迟 | 修复前后同一路径的 p50/p90/p99 对比 |

---

## 6. 当前环境状态

```bash
cd "D:\RoveFrame AI Business OS\RoveFrame AI Business OS\roveframe-src-latest"
git log --oneline -3 && git status --porcelain
python scripts/run-python-tests.py 2>&1 | tail -5      # 期望 815 OK (skipped=4)
pnpm validate 2>&1 | tail -5                            # 期望 exit 0
docker compose --env-file docker/deploy.env ps          # 期望两个都 healthy
curl -s http://127.0.0.1:5055/api/health                # 期望 ok:true
```

**有用的现成脚本**（都在 `scripts/`，命名以 `_` 开头的是本轮取证工具）：

| 脚本 | 用途 |
|---|---|
| `run-python-tests.py` | Python 全量测试 |
| `_verify_real_database.mts` | 真实库只读核验 |
| `_verify_schema_inventory.mts` | 表结构核验（带阴阳性对照） |
| `_verify_probe_validity.mts` | **探针有效性对照**（学怎么写能失败的检查） |
| `_verify_e2e_journey.mts` | 端到端用户旅程（30 项断言，会写测试数据） |
| `_verify_latency_breakdown.mts` | SSE 事件时间戳延迟分解 |
| `_verify_unit_economics.mts` | 单位经济性 / 任务积压 |
| `_verify_ai_errors_and_latency.mts` | AI 错误构成与延迟尾部 |
| `_cleanup_test_residue.mts` | 清理测试残留（public 侧，默认零写入） |
| `_cleanup_auth_users.mts` | 清理测试账号（auth 侧，默认零写入） |
| `_apply_rls_migration.mts` | 应用 RLS 迁移 + 零交叉负向验证 |
| `reachability.py` | 可达性分析（**定位为缩范围，不授权删除**） |
| `backup.mjs` / `rollback-drill.mjs` | 备份校验 / 回滚演练 |

---

## 7. 需要的钥匙（用户已提供，放在 gitignored 文件里）

| 用途 | 位置 |
|---|---|
| 应用凭据（Supabase / LLM / 加密密钥） | `docker/deploy.env`、`scripts/deploy.env` |
| DDL 直连（应用迁移用） | 数据库密码在会话中提供过；`db.<ref>.supabase.co` **IPv6 可直连**（Phase 15 已推翻"不可达"的旧结论） |

**注意**：有一批凭据曾出现在对话记录里（Supabase service_role JWT、JWT Secret、数据库密码、Cloudflare token、R2 S3 密钥、LLM key）。
**轮换这件事挂了四轮，只有用户能在控制台做。** 开工时提醒一次，之后不要反复追问。

---

## 8. 建议的第一步

```bash
cd "D:\RoveFrame AI Business OS\RoveFrame AI Business OS\roveframe-src-latest"
git log --oneline -3 && git status --porcelain
python scripts/run-python-tests.py 2>&1 | tail -5
pnpm validate 2>&1 | tail -5
docker compose --env-file docker/deploy.env ps
curl -s http://127.0.0.1:5055/api/health
```

基线对得上之后，**从任务 1（仪表盘编造数字）开始** —— 它最小、最该先修、且能立刻验证负向对照的做法是否到位。

每完成一个任务：跑全量验证 → 写报告（`docs/current/Phase16_*.md`）→ 提交（提交信息写清"改了什么、为什么、怎么验证的、以及你否定了自己什么"）。

---

## 9. 一句话

Phase 15 证明了**系统能跑**；Phase 16 要证明**它值得付钱**。
目前收入通路为 0（平台收不到商家的钱），新客户第一天看到的数字是编造的，
扫码点餐不收款也不叫厨房，群发邮件没有退订。**差距不在功能，在可交付性。**
