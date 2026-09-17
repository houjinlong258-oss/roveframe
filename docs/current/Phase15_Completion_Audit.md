# Phase 15 附录 — 完成度盘点与剩余项

本文件回答三个问题：还有哪些**没完成**、**完成度是多少**、**该优化什么**。

方法：只采信本次可复现的观测（命令输出、脚本、系统目录查询）。
无法确定的一律写 UNVERIFIED。**不使用"大概/应该/基本"这类措辞**。

判定沿用本项目既定口径，分四层：
**L1 代码存在 → L2 测试通过 → L3 真实调用 → L4 生产可用**。同一功能可能在不同层。

---

## 1. 一句话结论

**核心业务闭环已达 L4**（真实 LLM、真实库、真实工具、真实审批、真实审计，本轮 30/30 通过）。
**缺的不是功能，是"部署与运营"这一层**：全新部署会缺表、数据库层隔离实际不存在、
没有监控与告警、限流是单实例内存态。

即：**能在当前这台机器上跑通，不等于能被别人部署起来、也不等于能在故障时被发现。**

---

## 2. 完成度（按维度，非单一百分比）

| 维度 | 完成度 | 依据 |
|---|---|---|
| 核心业务功能（20 页 + 91 API） | **约 85%** | 20 个页面、91 个路由全部实现；API 层 **0 未授权路由** |
| AI / Agent 主链路 | **约 90%** | 真实 LLM 调用、工具调用、审批闭环、审计、记忆沉淀均已实测 |
| 数据库 schema | **约 80%** | 51/51 张表存在；但隔离策略未生效、5 个迁移不在部署链 |
| 部署链 | **约 45%** | 容器可构建可运行；但全新部署会缺 13 张表、迁移清单不完整 |
| 安全（应用层） | **约 85%** | 91 路由 0 未授权；跨租户查询在 `tenant-db` 层被强拦 |
| 安全（数据库层） | **约 10%** | 声明的 RLS 第二道防线**实际不存在**（33 表启用却零策略） |
| 可观测性 | **约 25%** | 有请求 id / 审计 / 健康探针；无指标、无告警、无日志聚合、无 APM |
| 可水平扩展 | **约 20%** | 限流与并发槽为单实例内存态；调度器为单实例 |
| 测试（有效性，非数量） | **约 60%** | 682 + 812 通过；但部分为源码文本断言，不验证行为 |
| 运维手册 / 回滚 | **约 70%** | 备份、校验、回滚演练已有且做过负向验证；缺调度与真实恢复演练 |
| 外部集成 | **约 45%** | 邮件/Square/Stripe/存储/平台模型达 L4；**RAG 平台耦合**、**web 搜索仅 Python 侧**、**ERPNext 仅 L1** |
| 产品化（面向外部客户） | **约 35%** | 无落地页、无自助试用、无计费闭环、无多租户开通流程 |

**综合判断**：作为**单一商户的试点（pilot）**，可交付度约 **75%**。
作为**对外部客户开放的 SaaS**，约 **35–40%**。

差距集中在：自助开通、计费、监控、隔离、多实例。

### 2.1 三个"看起来能用、其实不能"的地方（最该先处理）

这三项的共同点：**UI 或文档声称的能力，后端并不具备**。
它们不会被测试发现（测试全绿），只能靠读代码 + 查系统目录发现。

| 项 | 声称 | 实际 |
|---|---|---|
| 数据库层租户隔离 | 文档列为"上线前必须执行"的第二道防线 | 33 张表启用 RLS 却**零策略**，`migrate-rls.sql` 从未应用 |
| ERPNext 集成 | 设置页显示"已连接" | 只 ping 通；同步端点明确 `not implemented`；库存显示的是种子数据 |
| RAG / 知识库 | 平台功能之一 | 嵌入凭据来自 Coze 平台运行时身份，**自部署下抛错** |

---

## 3. 本轮新发现的问题（按严重度排序）

### 3.1 【高】全新部署会缺 13 张表 —— 部署链缺口

`src/lib/migration.ts` 的 `MIGRATION_FILES` 只执行 4 个 SQL。但 `scripts/` 下另有 5 个迁移
**不在清单里**，其中 4 个创建的表正被现网功能使用：

| 未纳入的迁移 | 创建的对象 | 依赖的功能 | 代码引用数 |
|---|---|---|---|
| `migrate-platform-admin.sql` | platform_admins、platform_admin_sessions、subscription_plans、tenant_subscriptions、subscription_events、invoices、feature_entitlements、support_access_grants、platform_admin_audit_logs | `/api/admin/*` 平台管理台、订阅 | subscription 78 处、invoice 7 处 |
| `migrate-production-hardening.sql` | error_events、coding_proposals、audit_logs | coding-agent 审批流、错误事件、审计 | audit_logs 17 处 |
| `migrate-customer-favorites.sql` | customer_favorites | 顾客端收藏（公开接口） | 4 处 |
| `migrate-ai-provider-views.sql` | ai_providers、ai_credentials、ai_usage_logs（视图） | **无代码引用** | 0 处 |
| `migrate-rls.sql` | 33 张表的 RLS 策略 | 数据库层隔离 | 见 3.2 |

实测（`scripts/_verify_fresh_deploy_gap.mts`）：**现存 13 个对象，缺失 3 个**。

- 13 个现存 ⇒ 这些表是**手工应用**过的，所以当前环境侥幸可用；
- 但 `migration.ts` 不会创建它们 ⇒ **全新部署必缺**；
- 缺的 3 个视图**无代码引用** ⇒ 属死对象，不影响功能（这一点降低了该项的严重度）。

**与 `runtime-metadata` 是同一类缺陷**（§5）：代码依赖的数据库对象，缺少一条把它建出来的线。
本轮已修 `runtime-metadata`，但**另外 4 个仍未纳入**。

### 3.2 【高】数据库层租户隔离**实际不存在**

`PILOT_READY_STATUS.md` §三.1 把 `migrate-rls.sql` 与 `verify-rls.sql` 列为
**上线前必须执行的部署步骤**，并称 RLS 为"数据库第二道隔离防线"。

实测（`scripts/_verify_rls_applied.mts`，系统目录查询）：

| 观测 | 值 |
|---|---|
| `public` schema 中启用 RLS 的表 | **52** |
| 全库策略总数（`pg_policies` = `pg_policy`，两处一致） | **2** |
| 有策略的表 | **仅 `leads`（2 条）** |
| 33 张业务表中启用 RLS 且有策略的 | **0** |

即：**`migrate-rls.sql` 从未应用到该库。** 33 张表处于"已启用 RLS、零策略"状态。

**当前不破坏功能**（已核实 `getSupabaseClient(token)` 只在定义处出现，
**没有任何调用点** ⇒ 全部走 `service_role`，而 `service_role` 旁路 RLS）。

**但风险是真实的**：

- 声明存在的第二道防线**实际不存在**，隔离 100% 依赖应用层；
- "启用 RLS + 零策略"的真实语义是**对 `authenticated`/`anon` 全拒**。
  任何未来改动只要引入 `authenticated` 客户端（移动端、Supabase 控制台、
  新的直连查询），就会**静默返回 0 行**而不是报错 —— 正是本仓库记录过的
  "撞 RLS → 0 行"故障模式；
- `audit_events`、`integration_events` 两张表**连 RLS 都没启用**。

`verify-rls.sql` 是设计成"泄漏就 `raise exception`"的负向验证，从未运行过。

### 3.3 【中】限流与并发槽是单实例内存态 —— 阻塞水平扩展

`src/lib/rate-limit.ts:42-44` 三个 `Map`，文件头注释已自认"当前为单实例内存实现"。

推论（**算术，非实测**）：N 个副本 ⇒ 注册/登录限流实际放宽 N 倍，
每商户聊天并发上限从 4 变成 4N。

这不是"可能有问题"，而是"多开副本就失效"。当前单副本部署不受影响。

### 3.4 【中】可观测性只有 25%

| 能力 | 状态 |
|---|---|
| request id 贯通 | 有（`proxy.ts`，本轮实测响应头可得） |
| 工具门控审计 | 有（`tool_gate.jsonl`） |
| 业务审计 | 有（`audit_events`，本轮已证实会写入） |
| 健康探针 | 有（本轮修复后能真实反映调度器） |
| 指标导出（Prometheus 等） | **无** |
| 告警规则 | **无** |
| 日志聚合 | **无**（多实例需逐容器看） |
| APM / 分布式追踪 | **无** |
| 备份调度 | **无**（需外部 cron） |

**本轮已把"信号可信"这一层补上**（修掉两个 fail-open + 调度器盲区）。
下一层（采集与告警）仍需引入外部系统，属架构决策。

### 3.5 【高】测试数量与有效性不匹配 —— HTTP 面几乎没有行为覆盖

682 TS + 812 Python 全绿。但按**断言实际做了什么**分类后（子代理静态分类审计）：

| 套件 | 行为级 | 源码文本断言 | 备注 |
|---|---|---|---|
| TypeScript（72 文件 / 682 用例） | 568（**84.5%**） | **104（15.5%）** | 其中 4 个文件 19 个用例**全部**是文本扫描 |
| Python（36 文件，35 为真测试） | ≈801（**>99%**） | 5 | 质量明显更好：真子进程、真管道、真 HTTP |

源码文本断言 = 读源文件、`assert.match` 其内容。**它能证明"代码里有这句话"，
不能证明"代码能工作"**；重命名变量就会失败，而功能坏掉反而可能通过。

**比数字更重要的结构性发现**：91 个 API 路由文件中，

| 覆盖程度 | 数量 | 说明 |
|---|---|---|
| 被测试**实际调用**过 | **11** | 且主要是 401 行为 |
| 仅被文本扫描 | 31 | |
| 测试里**从未出现** | **49** | |

（独立复核：我按"路径是否出现在 tests/ 源文中"这一较宽口径统计，得到 41 个出现过、50 个从未出现；
子代理按"是否被 import 并调用"的严格口径得到 11。两个口径方向一致：**绝大多数路由没有行为覆盖**。）

**高风险且无行为测试的模块**（行数 / 性质）：

| 路由 | 行数 | 性质 |
|---|---|---|
| `internal/agent/business-data` | 585 | HMAC 门控的内部数据面 |
| `settings/models` | 234 | 加密凭据读写 |
| `webhooks/[provider]` | 188 | **无鉴权**入站 webhook |
| `store/orders` | 152 | 公开接口 + 服务端计价 |
| `payments/checkout` | 144 | **资金流转** |
| `admin/tenants/[id]` | 143 | 跨租户管理 |
| `auth/signup` | 133 | 账号创建 + 限流 |
| `settings/wipe` | 99 | **破坏性数据清除** |
| `admin/auth` | 90 | 平台管理台认证 |

对照组：核心安全原语**确实**被 import 并执行
（`crypto.ts`、`auth-guard.ts`、`tenant-db.ts`、`rbac.ts`、`agent/approvals.ts`、`ai/router.ts`）。

### 3.5.1 确认"无法失败"的测试（4 处）

本仓库旧报告曾把"永远通过的测试"列为高危类别。本次确认：

| 位置 | 为什么无法有意义地失败 |
|---|---|
| `tests/agent-tasks.test.ts:8-17` | 断言 `typeof registerTaskHandler === 'function'`，而该值由第 4 行的 import 保证（非函数会在模块加载时就抛）；另一条断言 `executed === false`，即"处理器**没有**被调用"——任何实现都能通过 |
| `roveagent/api/plugin_sandbox_mode_test.py:169` | `except SandboxStartError: self.skipTest(...)` 使 171-175 行的断言在容器启动失败时**不可达**；每次失败都退化成绿色跳过 |
| `tests/artifacts-pdf.test.ts` | 12 处 `t.skip()` 由字体发现决定；无字体机器上 32 个用例中约 10 个静默跳过，套件仍 exit 0 |
| `tests/audit-store.test.ts:46` | 断言页面源码里含字面量 `useState<'code' \| 'business'>('business')`；仅格式化重构就会失败，而功能坏掉仍可能通过 |

**没有**发现 `assert.ok(true)`、恒等断言、或 try/catch 吞掉的断言。

Python 侧另有 1 个**误命名**文件：`roveagent/clisupport/approvals_test.py` 是 CLI 子命令
（`roveagent approvals test`），被 `*_test.py` 模式误收为测试文件，贡献 0 个用例。
它是重命名风险，会把测试文件数虚高 1。

**UNVERIFIED**：子代理未运行任何套件（只读约束），所有计数为静态；
Python 静态 `def test_` 共 806 与实测 812 相差 6，来源未查明。

### 3.6 【低】其他已确认项

| 项 | 证据 |
|---|---|
| 无落地页 | `src/app/[locale]/page.tsx` 是仪表盘（`'use client'`，拉 `/api/dashboard`），未登录访客无任何营销/说明页 |
| `SQUARE_*` / `STRIPE_*` 未配置 | 代码存在；`NEXT_PUBLIC_APP_URL` 未设，而 Stripe checkout 与 Square OAuth 回调依赖它 |
| `WEB_PUSH_VAPID_*` 未配置 | `push.ts:57` 有订阅时抛错（fail-closed，可接受）；`deploy.env.example` 未含这三项 |
| 公开路由声明不一致 | `/api/integrations/square/oauth/callback` 不在 `PUBLIC_API_PREFIXES`（已核实无 `integrations` 条目），但自身用 `verifySquareOAuthState` 守卫 |
| 平台管理面无纵深 | `proxy.ts:58-63` 对 `/api/admin/*` 整体跳过边界检查，全部依赖路由内 `requirePlatformAdmin`。已核实 9 个 admin 路由都调用了它 —— 无缺口，但**只有一层** |
| `proxy.ts:102` 排除含点路径 | `matcher: ['/((?!_next|_vercel|.*\\..*).*)']`。当前无含点路由，**无实际绕过**（推断，已标注） |
| 插件沙箱仍在 L2 | 本轮实测候选集为空（54/54 bundled），P1-3 的 L4 未做 |
| `gateway/` 死代码未处置 | 沿用 Phase 13 结论（活跃依赖，未删） |
| 凭据待轮换 | 多组密钥曾出现在对话中（G-03 挂了四轮） |
| 测试残留 | `auth.users` 测试账号未清（清理脚本只动 `public` schema）；`cron_state` 孤儿水位线 |
| 镜像体积 | web 1.57 GB（无 `output: 'standalone'`） |

### 3.7 【高】ERPNext 在 UI 上"已连接"，但数据永远不会到达

这是本轮发现的**唯一"假实现"**，且它面向用户可见。

| 观测 | 证据 |
|---|---|
| 测试端点只 ping 连通性 | `api/integrations/test/route.ts`：`fetch(url + '/api/method/ping')`，凭据走 `Authorization: token key:secret`；成功即 `{ ok: true }` |
| 同步端点**不支持 ERPNext** | `api/integrations/[provider]/sync/route.ts:24-26`：`if (provider !== 'square') return 400 'sync not implemented for <provider>'`（已直接读取确认） |
| 没有 ERPNext 客户端模块 | 全仓无 `/api/resource` 调用、无供应商/采购单客户端 |
| 没有写路径 | 没有任何代码把 ERP 库存写入 `inventory_items` |
| 调度器从不调用它 | `scheduler.ts` 无 ERPNext 分支 |
| 文档已自认 | `PILOT_READY_STATUS.md` §五 列为"不开发"；`RESTAURANT_PILOT_RUNBOOK.md` 亦提及 |

**危害**：老板在设置页看到 ERPNext "已连接"（因为 ping 成功），
而库存 Tab 实际显示的是**种子/本地数据**。这不是崩溃，是**误导性状态** ——
比报错更危险，因为用户会据此做采购决策。

**诚实度说明**：代码库自己承认未实现（注释 + 文档），所以这不是"谎报"，
但**UI 的"已连接"语义与后端能力不匹配**，仍应修正（要么标注"仅连通性已测试"，
要么把同步按钮置灰并说明）。

### 3.8 【高】RAG / 知识库耦合 Coze 平台，自部署下不可用

| 观测 | 证据 |
|---|---|
| 嵌入无自有凭据 | `src/lib/embedding.ts:6`：`new EmbeddingClient(undefined, forwardHeaders)` —— 第一个参数（凭据）传 `undefined`，由 SDK 从**平台运行时身份**解析；仓库里没有对应的应用级 env var |
| 1024 维 + RPC | `knowledge/ask:22`、`internal/agent/business-data:303` 调 `match_doc_chunks` |
| 后果 | 离开 Coze 平台（即自部署）后，`/api/knowledge/ask`、`/api/knowledge/docs` 与内部 RAG 通路会抛错 |

即：**知识库功能不是自托管的**。它是本仓库里第二处"依赖平台注入凭据"的地方
（第一处是平台内置模型，已在本轮修好并给了自部署通路）。
P1-5"嵌入 provider 抽象"的记录正是这个问题，本轮未做。

### 3.9 【中】web 搜索只在 Python 侧，Next.js 侧完全没有

| 观测 | 证据 |
|---|---|
| Python 侧有 8 个 provider | `roveagent/plugins/web/*`（ddgs / exa / firecrawl / searxng / parallel / keenable / brave_free / keyless_mcp） |
| `src/` 侧**零**搜索通路 | 全仓 `web_search` 在 `src/` 下出现 **0 次**；仅一处 UI 标签 `settings/page.tsx:772 'searchProvider'` |
| 后果 | 全新部署的 **web 应用没有联网搜索能力**（仅 Python 运行时内部有） |

用户此前明确要求过"搜索系统：可对接搜索引擎及社交/短视频接口"。
**该需求在 TS 应用层未交付**，只在 Python 运行时内存在。

### 3.10 外部集成分层实况（子代理审计，已抽查核实）

| 集成 | 真实出站调用 | 层级 | 全新部署下的下场 |
|---|---|---|---|
| 邮件 SMTP 发送 | 是（nodemailer） | **L4** | 无 `email_accounts` 行 → 硬失败（错误信息清晰） |
| 邮件 IMAP 同步 | 是（imapflow） | **L4** | 同上 |
| Square（订单/商品/客户/库存） | 是 | **L4** | 缺 `SQUARE_APP_ID/SECRET` → token 刷新中止 |
| Stripe（checkout/refund/webhook） | 是 | **L4** | 生产拒绝 http origin 与非 `sk_live_` key → 自托管 http 部署返回 409 |
| 对象存储上传 | 是（Supabase Storage） | **L4** | 需 service_role key（生产无 anon 回落，fail-closed） |
| 平台模型回落 | 是 | **L4**（本轮修复） | 需 `ROVEFRAME_PLATFORM_LLM_*` |
| RAG / 嵌入 | 是，但经平台 | **L4 仅限 Coze 平台** | 自部署抛错（见 3.8） |
| web 搜索 | 是，仅 Python 侧 | **L3** | TS 应用无此能力（见 3.9） |
| **ERPNext** | 仅 ping | **L1** | UI 显示已连接，数据永不到达（见 3.7） |

**唯一 L1 是 ERPNext**；没有 L2-only 的集成（集成测试是源码文本断言）。

---

## 4. 本轮已修（对比 Phase 14 末）

| 项 | 状态 |
|---|---|
| web 镜像重建 | 已完成，容器 `healthy`，R-02 契约实测生效 |
| `pnpm validate` 不可达 | 已修，exit 0 |
| 表结构核验假阳性 | 已推翻并修正：真实库 **51/51** |
| boot-check fail-open | 已修 + 回归守卫（注入后变红） |
| scheduler 健康盲区 | 已修：心跳落库，`source=heartbeat` 实测 |
| R-03 凭据解密失败 | 已修：compose 白名单 + `ENCRYPTION_SECRET_PREVIOUS` |
| runtime-metadata 迁移 | **已应用并证实写入**（9→14 列，3 行有值） |
| 平台回落可用性 | 已修并端到端验证（新商家 1653 字符回复） |
| 测试残留 | 已清理：1 tenant / 1 business / 0 孤儿 |

---

## 5. 优化建议（按 收益/成本 排序）

| # | 事项 | 收益 | 成本 | 依据 |
|---|---|---|---|---|
| 1 | 把 4 个在用迁移纳入 `MIGRATION_FILES` | 全新部署才能起来 | 低（改一个数组 + 加列级守卫） | §3.1 |
| 2 | 把列级守卫扩展到全部迁移 | 防止第 3 次同类缺陷 | 低 | §3.1、§5 |
| 3 | 实际应用 `migrate-rls.sql` 并跑 `verify-rls.sql` | 兑现声明的第二道防线；否则把文档改成"未实施" | 低（一个 SQL） | §3.2 |
| 4 | **给资金/认证/管理台路由补行为测试** | 90 个路由里 80 个无行为覆盖，其中含 payments / admin / signup / wipe | 中 | §3.5 |
| 5 | 轮换全部已暴露凭据 | 消除已发生的泄漏 | 低 | §3.6 |
| 6 | ERPNext：UI 标注"仅连通性已验证"或隐藏同步入口 | 停止误导采购决策 | 低 | §3.7 |
| 7 | 限流/并发槽换共享后端（或明确声明单副本契约） | 解锁水平扩展 | 中 | §3.3 |
| 8 | 接指标导出 + 一条"运行时不可达"告警 | 从"可追踪"到"可监控" | 中（需外部系统） | §3.4 |
| 9 | 在 TS 侧补搜索能力（或明确降级为"仅 Agent 内可用"） | 用户明确提过的需求 | 中 | §3.9 |
| 10 | 清理 `auth.users` 测试账号 | 基线干净 | 低 | §3.6 |
| 11 | 补落地页 + 自助注册引导 | 面客可用性 | 中 | §3.6 |
| 12 | 镜像改 `output: 'standalone'` | 体积从 1.57 GB 显著下降 | 中（需实测） | §3.6 |
| 13 | 插件沙箱 L4 | 仅在引入社区插件时才需要 | 高 | §3.6 |

**第 3 项有个前置选择**：若短期不打算用 `authenticated` 客户端，
也可以选择**把文档改为"RLS 未实施"**并在 `migrate-rls.sql` 头部注明
——诚实的文档比假装有防线更安全。但那样必须承认：隔离只有应用层一层。

**第 4 项是全表里投入产出比最高的一项**：91 个路由中 80 个从未被行为测试调用，
而其中恰好包含资金、认证、跨租户管理与破坏性操作。
本轮改动之所以能发现 `boot-check` 的 fail-open，正是因为它有可执行的负向对照；
没有行为测试的路由没有这种保护。

---

## 7. 本轮审计自身的证据分级

| 结论 | 来源 | 我的复核 |
|---|---|---|
| API 授权覆盖 91 路由 / 0 未授权 | 子代理静态审计 | 独立复核路由数 **91** 一致 |
| RLS 从未应用（33 表零策略） | 我的脚本查系统目录 | 两处系统表交叉验证一致 |
| 全新部署缺 13 张表 | 我的脚本查 `to_regclass` | 直接读取 + 代码引用计数 |
| 测试 15.5% 为源码断言 | 子代理静态分类 | 未独立复核比例；仅复核路由数 |
| 路由行为覆盖 11/91 | 子代理 | 我的宽口径得 41，方向一致 |
| ERPNext 仅 L1 | 子代理 | **已直接读取 sync 路由确认** `not implemented` |
| RAG 平台耦合 | 子代理 | **已直接读取** `embedding.ts:6` 确认凭据为 `undefined` |
| web 搜索仅在 Python 侧 | 子代理 | **已复核** `src/` 下 `web_search` 出现 0 次 |

**未复核**：Python 806 vs 812 的 6 个差值、per-test mock 分类、
`tests/` 的路径别名解析。这些不影响上述结论的方向。

三个子代理均声明**未运行任何测试套件**（只读约束），所有测试相关计数为静态分析结果。
本文件中的"测试通过"数字来自我自己本轮运行的 `pnpm validate`（exit 0）与
`run-python-tests.py`（812 OK / 4 skip），两者已实测。

---

## 6. 与外部代理并发改动的风险提示

本机除本代理外，还装有**另一套代理框架**（其配置目录位于用户主目录下）。
本次检查时该目录**没有配置文件、也没有 24 小时内的活动会话**，
因此本轮未发现并发改动冲突。

但用户提供的历史记录显示，另一个代理曾在这个仓库上工作过
（建表、灌种子数据、改看门狗）。**两个代理改同一棵工作树会互相覆盖**。
建议约定：同一时刻只允许一个代理写这个仓库。
