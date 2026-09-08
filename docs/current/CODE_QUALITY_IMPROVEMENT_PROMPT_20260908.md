# RoveFrame AI Business OS — 代码质量提升提示词（审查版 v1.2）

> 审查对象：`RoveFrame-AI-Business-OS-source-20260908-1802.zip`（1,994 条目）≡ 仓库 HEAD `233c1f6`（2026-09-08 17:48）
> 审查方法：5 组独立分片只读深审（API/鉴权安全 · 数据层/DB/集成 · Python roveagent · 前端/i18n · Agent 平台内核/实验子系统）+ 主干逐文件人工核查与全库量化扫描；全部发现均带文件:行号证据。
> 本文件用途：**可直接投喂给编码 AI 的提示词**。复制「任务区」整段并让它以仓库为工作目录、按 P0→P1→P2 顺序产出小步提交；每条修复按「证据/改动/测试/风险」回填。

---

## 〇、给 AI 的全局工作方式（先读）

1. 只允许 pnpm；新增依赖必须说明理由并获准。回复与新增注释用中文。
2. 每步先立证据再动手：先读相关文件、跑相关测试；禁止凭印象改代码、禁止编造行号。
3. 小步提交：一个 commit 只做一件事，形如 `fix(scope): 一句话`；禁止把格式化、文件移动与行为修改混入同一 commit；禁止大爆炸重写。每个文件建议独立 commit（或文件数 ≤5 的同族修复）。
4. 每条修复交付格式（最终报告逐条回填）：
   ```
   [P0-x] 标题
   - 证据：<文件:行 + 原文摘录 1-5 行>
   - 改动：<diff 摘要>
   - 测试：<新增/更新测试名与结果>
   - 风险：<行为变化点、回滚方式>
   ```
5. 视觉冻结：UI 只允许等价重构（抽组件/hook、统一 shadcn），不得改变视觉 token/间距/文案观感（以 `.cozeproj/prototype/web/*.html` 与 `globals.css` `@theme` 为唯一标准）。
6. 每完成一个 P0 跑一次完整验证（见「五」），全绿再进入下一项。

---

## 一、项目档案（上下文，只读）

- **产品**：RoveFrame AI Business OS — 面向海外餐饮/中小商户的多租户 AI COO SaaS；核心产品 = Restaurant AI Chief of Staff（Morning Brief / Ask / Approve 三入口，四 persona 统一 runtime）。
- **TS 侧**：Next.js 16 App Router（`src/proxy.ts` 边界）· React 19 · TS 5 strict（全库 `as any` = 0，必须保持）· Tailwind 4 + shadcn/ui（ui 56 文件仅 12 被引用）· Supabase（service-role 主通道 + 33 表 RLS 兜底）· next-intl（en/zh/es，866×3 键零漂移）· 自研 AI 路由（10 家 provider，Anthropic/OpenAI 双协议）。规模：274 文件 ≈3 万行；84 个 route.ts。
- **Python 侧**：`roveagent/` 单仓包 ≈1,132 个 .py / ≈80.1 万行 / 38.5MB（clisupport 298 文件 22.5 万行、core 210、tools 161、plugins 212、gateway 108…）。**RoveFrame 自有业务薄层仅 ≈43 文件 ≈3,800 行**（api/agents/business/enterprise/workforce/tenant/connectors/deployment/repair/permissions/skills），其余为大型 Agent CLI 运行时（结构带第三方产品痕迹 nous_account/kanban 等；目录含 LICENSE/NOTICE，但**需人工完成来源与授权合规核对**）。经 `ROVEAGENT_API_KEY` + `roveagent/api/app.py` HTTP 对接。
- **安全主链路**（禁止劣化）：`proxy.ts` 剥/注 `x-rf-*` 头 → `withAuth`（JWT 本地验签 HS256 白名单 + timingSafeEqual + 60s/5min 缓存）→ `requirePermission`/`protectBusinessMutation`（审计）→ 业务代码经 `tenant-db.ts`（`scopedTable/insertWithScope…` + `PLATFORM_TABLES`/`BUSINESS_SCOPED_TABLES` 白名单）→ Supabase。
- 官方文档：`docs/current/PILOT_READY_STATUS.md`（基线 65fa020）、`ARCHITECTURE.md`、`API_PERMISSION_MATRIX.md`；验证口径：TS 278 tests · Python 21 unittest · ts-check/eslint/stylelint 通过 · RLS `verify-rls.sql` 零交叉 · live E2E `pnpm run e2e:recovery`。

## 二、代码库体检数据（实测）

| 指标 | 数值 | 备注 |
|---|---|---|
| TS/TSX 源码 | 274 文件 / ≈29.9k 行 | app 108 · lib 82 · components 68 |
| TS 测试 | 37 文件 / ≈4.2k 行 | 领域覆盖广（permission/RBAC/approval/隔离…） |
| Python | ≈1,132 .py / ≈80.1 万行 | 自有薄层 ≈3.8k 行；运行时 1 万+ try/except（防御性为主） |
| i18n | 866×3 键零缺失零多余 | 保持；新建文案必须入 messages |
| `as any` / `<any>` / `@ts-ignore` | 0 / 0 / 0 | 全库 |
| `@ts-expect-error` | 1（InstallPrompt.tsx:34，iOS 私有属性，合理） | |
| TODO/FIXME/HACK | ≈5（TS 业务代码）；Python 运行时 ≈373 | |
| `console.log/debug` | 4；`console.*`（含 warn/error）≈32 | scheduler.ts 10、server.ts 9 为主 |
| 非空断言 `!` | ≈635 | 热点：platform-admin 25 · channels 23 · approvals 18 · ai/router 15 · integrations/test 14 · approvals/events 13 |
| API route.ts | 84 | 守卫接线逐一核对完成（见 P0-9/附录结论）；**仅 5 个 route 引入 zod** |
| route 层速率限制 | **0** | 全仓无任何限流实现 |
| ui 组件库使用率 | 56 文件中 44 个零引用 | chart(357 行)/sidebar(724 行)/form 等死文件 |

**必须保留的既有优点**：三层鉴权与纵深（proxy+withAuth+mutation-guard）；JWT 本地验签（alg 白名单/timingSafeEqual）；租户数据层白名单拒绝；webhooks/[provider] 与 approvals/events 的 HMAC 恒定时间验签+租户配对；store/orders 服务端计价；AI 路由 SSRF baseUrl 校验/结构化 AIError/有界重试/用量不阻断主链路；coding-agent apply-engine 的 worktree 隔离+测试门禁自动 revert；Python 侧 auth compare_digest、archive_safe 解压防护、active_sessions 跨进程锁+lease、data_layer 全参数化+scope 回验；前端无密钥进 bundle（NEXT_PUBLIC 仅 VAPID 公钥）。

---

## 三、审查发现与修复指令

### P0 — 先修：安全、越权、数据正确性（每项含证据/修复/验收）

**[P0-1] 全站无速率限制**
- 证据：全仓 grep 无任何 ratelimit/429 实现（仅 `src/lib/ai/router.ts` provider 429 重试与 `scheduler.ts:223` square 节流）。缺口端点：`api/auth/{login,signup}`、`api/admin/auth`（平台管理员，TTL 12h）、`api/emails/send`、`api/channels/send`、`api/marketing/send`、`api/payments/*`、`api/store/orders`、`api/upload`、`api/agent/chat`（SSE 并发）、`api/healing/*`（staff 可触发 LLM 消耗）、roveagent `/api/agent/chat`（共享 Key，无签名）。
- 修复：集中限流 util（进程内令牌桶，接口预留多实例后端），按 `tenant+user` / `ip+path` 双维度：登录注册 5 次/15min/账号+指数退避；公开下单 30/min/token；上传 20/min/商户；chat 并发 ≤4/商户；healing 按商户日配额。`/api/health` 不阻塞。
- 验收：`tests/rate-limit.test.ts`：超窗 429、不同 key 互不影响、健康检查放行。

**[P0-2] service_role→anon 静默回落 + RLS 处于休眠态**
- 证据：`src/storage/database/supabase-client.ts:100-101` `key = serviceRoleKey ?? anonKey`；`scripts/migrate-rls.sql` 只为 service_role/authenticated 建策略、anon 无策略（默认拒绝）；全仓 216 处 `getSupabaseClient()` 无一传 token → authenticated 策略永不被应用层使用，RLS 仅靠 service_role 旁路。
- 修复：生产缺失 service role key 直接抛错（不回落 anon，避免「漏配 env 反而退化成 anon 全表读写」的事故）；在 `docs/current/ARCHITECTURE.md` 明示当前安全模型 = 「service_role 全旁路 + 应用层谓词收口」，RLS 作为纵深保留并在迁移文档注明启用顺序；同时模块级复用客户端实例（按 url+key 缓存，避免每请求重建与 execSync 探测）。
- 验收：无 key 时启动/请求抛错；`pnpm test` 全绿；文档更新。

**[P0-3] 业务表被 plainTable 直查（跨租户读）**
- 证据：`src/app/api/business/inventory/route.ts:13-21` 用 `plainTable('integration_configs')` 且无 tenant 过滤（注释自称平台级配置），而 `tenant-db.ts:67-100` 明确 `integration_configs ∈ BUSINESS_SCOPED_TABLES`；同文件 `channels/route.ts:15-18` 用 `scopedTable` 查同一张表。
- 修复：改 `scopedTable(ctx,'integration_configs',…)` + `eq('provider','erpnext')`；给 `plainTable` 增加与 `tenantTable` 相同的业务表拒绝（复用 `rejectTenantOnlyBusinessAccess`）。
- 验收：新增越权测试：租户 B 的库存页响应不含租户 A 的集成状态；`grep plainTable(` 后所有调用点均过白名单。

**[P0-4] 读接口 RBAC 缺位：staff 可读全量 PII 与审批载荷**
- 证据：`rbac.ts:29` staff 仅有 `orders:read/customers:read/agent:use/healing:write`，但以下 GET 仅 `requireBusinessContext(getTenantContext(...))` 即全量读取：`api/emails/route.ts`（邮件正文）、`api/reservations/route.ts`（phone/notes）、`api/reviews/route.ts`、`api/agent/approvals/route.ts:13-19`（payload/arguments 含退款金额与工具参数）、`api/audit/export/route.ts:25-37`（含 result 的审计全量导出）、`api/admin/support-access/route.ts`（无 roles 限制可列他 admin 授权记录）。对照组：`alerts/route.ts:11`、`notifications/route.ts:21` 有 requirePermission。
- 修复：所有 GET 读接口按 `entity:read` 权限门控（或 `withAuth` + roles），审批/审计类至少 owner/manager；support-access 补 roles 限制与必选 tenantId。
- 验收：新增 staff 角色访问上述端点的测试全部 403；`docs/current/API_PERMISSION_MATRIX.md` 同步。

**[P0-5] SSRF 族（4 处，需统一校验器）**
- 证据：
  a) `api/channels/test/route.ts:12-18` + `src/lib/channels.ts:115-125`：manager 级（`channels:write`）对客户端 webhookUrl 任意 POST，且失败时 `throw new Error(\`Webhook ${status}: ${await resp.text()}\`)` 回显内网响应体；
  b) `api/integrations/test/route.ts:16-23`：erpnext url 任意 fetch 且带 `token key:secret` 头；shopify 分支同（:35-43）；
  c) `src/lib/ai/url-utils.ts:76-97`：生产 baseUrl 校验可被 `127.0.0.1.nip.io`、十进制定点、IPv6 ULA、DNS 重绑定绕过（仅拦点分十进制与 '127.' 前缀）；
  d) `src/lib/ai/router.ts:98-108`：多模态消息 `image_url` 任意 http(s) 抓取（15s 探测窗），无任何 host/IP 限制。
- 修复：抽公共 `validateOutboundUrl(url, {allowPrivate})`（DNS 解析后按 IP 段拦截：环回/链路本地/私网/保留/ULA/映射地址 + 禁 nip.io 类重绑定域名，参考 url-utils 现有实现扩展）；channels/integrations 测试与发送统一走该校验；错误分支不回显上游响应体；`imageToBase64` 仅允许 data URL 与白名单域名。
- 验收：新增 SSRF 单测覆盖 nip.io/十进制/内网/元数据地址 4 类 + channels 错误不回显 body；`tests/ai-router-contract.test.ts` 保持全绿。

**[P0-6] 支付/清空/下单金额与幂等边界**
- 证据：
  a) `api/payments/checkout/route.ts:76-95`：reservation 分支只查预约存在性，金额完全信任客户端（order 分支有权威价比对 :85-88，reservation 无）；
  b) `api/settings/wipe/route.ts:16-18`：`delete().eq('tenant_id', …)` 按租户全删 13 张业务表——多 business 租户下一店清空即全租户丢数据（其余路由均双 eq tenant+business）；`settings/overview/route.ts:13` 同款 tenant-only 计数；
  c) `api/store/orders/route.ts`：幂等键可选+查插竞态无唯一索引兜底、items 数组无长度上限（单项 qty≤99）、tip 无上限、销售计数 RPC 失败仅 console.warn（:69-72）。
- 修复：(a) reservations 增加权威应缴字段并在 checkout 服务端比对，无权威价则拒绝该模式；(b) wipe 双 scope + 二次确认令牌 + dry-run；overview 计数按 business；(c) zod 完整 schema（items≤50、金额上限）+ 部分唯一索引 `(tenant_id,business_id,source,external_id)`（external_id 非空）+ 同 key 返回既有订单 + 计数入队重试。
- 验收：新增并发同 key 双插测试只留一行；wipe 越店测试不删除他店行；checkout reservation 金额不符 409。

**[P0-7] 前端「保存成功」误报与全站静默吞错**
- 证据：`src/app/[locale]/settings/page.tsx:265-272`（saveSection 及同型 saveModel/saveMailbox/saveIntegration/saveChannel/wipeData 均无 `res.ok` 检查无 catch → 失败仍弹「已保存」，fetch reject 产生 unhandled rejection）；`emails/page.tsx:177-186`（草稿保存无视响应仍报成功）、`knowledge/page.tsx:83-109`（await 后无 finally，reject 时按钮永久卡 saving）；`src/lib/utils.ts:19-32` safeFetchJson `catch { return null }` + `[locale]/page.tsx:68-78` 等全站约 10 页复用此无错误路径 → API 失败时骨架屏永转/空态假死，无错误提示无日志。
- 修复：抽统一 `useApi`/`useFetch`（loading/error/empty/retry + AbortController 护栏），错误展示 t() 文案；safeFetchJson 至少 console.error 并保留调用方错误分支；保存类操作 res.ok 校验 + try/finally。
- 验收：mock fetch 500 时各页显示错误态且不报「已保存」；新增 1-2 个组件测试或 e2e 断言。

**[P0-8] 时区/货币链路不一致（海外市场核心正确性）**
- 证据：`src/lib/format.ts:1-8` fmtCurrency 固定 `en-US`（无 locale/currency 参数联动——store 页调 `fmtCurrency(x)` 不带币种恒显示 $）；`reservations/page.tsx:121` 浏览器本地时 `toISOString()` 落库，而服务端聚合按进程时区 CST 切日（`business-context.ts:33-39`、`channels.ts:196-200`、`business/metrics.py:27-28`）——美东店铺「今日营收/预约」口径错位 12-13h；`business-context.ts:46-58,92-99,141` avgRating/pendingReviews 只基于最近 20 条评论、customerCount 上限 500、支付统计上限 200（静默失真并喂给 AI）。
- 修复：format.ts 增加 locale/timeZone/currency 显式参数并按调用点传入；日期聚合全链路约定「ISO-UTC 存储 + 按业务配置时区取本地零点切日」；business-context 统计改 count/avg 聚合（`head:true` count）或明确标注「最近 N 条」。
- 验收：新增 `tests/format.test.ts` 与 business-context 时区单测（固定 TZ=America/New_York 断言今日窗口）；zh/es 货币符号断言。

**[P0-9] Python：L4 会话记忆跨会话/跨用户泄漏**
- 证据：`roveagent/state/enterprise_memory.py:146-199` `search()` 对 L2+ 只按 `tenant_id+business_id` 过滤，`session_id` 形参从不参与查询；`roveagent/api/app.py:321` 每轮把 `业主问：{message[:200]}` 写入 L4，:266-269 检索时不传 session_id → 同租户其它会话/其它用户的私密对话被注入当前 Agent 上下文。
- 修复：L4 检索强制 `session_id` 精确匹配（L2/L3 语义不变）；补跨会话/跨用户隔离负向测试。
- 验收：新增 `enterprise/context_isolation_test.py` 用例：会话 B 检索不得返回会话 A 的 L4 记录。

**[P0-10] Python：tenant_id 未净化 → 路径穿越/任意文件写**
- 证据：`roveagent/api/app.py:576-593` `skill_dir = ctx.root / "skills" / f"tenant-{req.tenant_id}" / safe`；`roveagent/skills/marketplace.py:100-116` 同构。Pydantic 仅 `min_length=1`，`tenant_id` 含 `../` 时 `mkdir+write_text` 越出目录任意写。
- 修复：tenant_id 与 skill name 共用白名单净化 helper（`[A-Za-z0-9_-]`），在 ServiceContext 入口统一净化全部请求字段。
- 验收：新增路径穿越测试（`../../x` 拒绝/净化）；既有 100 并发隔离测试保持绿。

**[P0-11] Python：门控链 fail-open 三处**
- 证据：
  a) `roveagent/clisupport/middleware.py:303-314`：执行链中回调抛异常 → 跳过该中间件继续执行下游真实工具（安全保证依赖「中间件自己吞异常返回阻断 JSON」的脆弱约定）；
  b) `roveagent/tools/framework.py:109-115`：策略兜底 `ToolPolicy("*","",LOW,NONE)` —— 未登记工具免审批直执；`write_file`/`patch` 仅 MEDIUM+NONE 即直执；
  c) 权限由调用方 JSON 提供（`api/app.py:152-153` 仅 min_length），与「ctx 由服务端推导」不符。
- 修复：(a) 安全中间件异常终止链并返回 `enterprise_gate_unavailable`（fail-closed 收到执行链本身）；(b) 兜底改 deny + 显式登记白名单，写文件类至少 MANAGER 审批；(c) 权限由员工档案/会话服务端推导。
- 验收：新增「中间件抛错必须阻断」与「未知工具必须拒绝」测试；`approval_flow_test.py` 保持绿。

**[P0-12] Python：/api/agent/execute 假执行 + 整单批准 + 无锁 RMW**
- 证据：`roveagent/api/app.py:420-450` approved=True 时把含 execute 类步骤全部置 done 并写 `result = "executed by …"`（:438-441，注释自认真实动作走另一链）；`api/tasks.py:74-102` 纯 read-modify-write JSON 无锁无版本。
- 修复：execute 返回前真实驱动动作或明确仅落「意图登记」并改状态机文案；任务存储加乐观锁/版本号；批准粒度到 step（含 required_role 死锁修复：`agent/approvals/events/route.ts:115-117` + `approvals.ts:69-73` 的 admin 级无人可批问题——改映射或移除）。
- 验收：并发双 execute 只生效一次；审计记录与真实执行状态一致；补充单测。

**[P0-13] Python：healing/installer 死代码携带 RCE/自动批准原语**
- 证据：`roveagent/repair/healing.py:150-164` 先 `check()` 随即 `permissions.approve(...)`（docstring 却声明须人工批准）；`deploy()` 把 LLM 可影响的 error_signature 拼入 `git commit -m` 无转义；`deployment/installer.py:52-68,114-117` host/app_dir 原样拼 `ssh {target} '…'` 以 shell=True 执行 + 硬编码 `POSTGRES_PASSWORD=roveframe`（:60）。grep 证实无调用方（仅 kernel.py:44-45 实例化）。
- 修复：删除，或接线前强制改造（命令参数列表化、approve 需真实人工来源、消除快速通道、移除硬编码口令）；在 EXPERIMENTAL_MODULES.md 登记威胁模型。
- 验收：新增 `tests/error-healing.test.ts` 断言两模块不可从任何 API/任务路径触发；grep 无 shell=True 拼接。

**[P0-14] 迁移体系双源漂移（自动迁移建出的库与 schema/代码不符）**
- 证据：`src/lib/migration.ts` MIGRATION_SQL（止于 :612 platform_admin_audit_logs）vs `scripts/migrate*.sql` 10 个文件互相漂移：
  a) migration.ts 建 `staff` 无 `business_id` 列且 :314-322 补列循环不含 staff（migrate.sql:223-241 含），而 `schema.ts:605-616` 声明 staff.business_id NOT NULL、`api/store/staff` 按 business_id 查询 → 自动迁移库写 staff 即 42703；
  b) migration.ts:442-444 建 `settings (tenant_id)` 唯一索引 vs migrate.sql:429-432 的 `(tenant_id,business_id)` vs schema.ts:593-594 → 同租户第二家店 settings 插入冲突 500；store_qr_codes 唯一键同型漂移（migration.ts:413 vs migrate.sql:406）；model_configs 残留 `(tenant_id,provider)` 与 `coalesce(business_id,'')` 表达式索引（migration.ts:427,436）；
  c) `agent_approvals`（migrate.sql:644 起）、`notifications`（:536）、`push_subscriptions`（:631）不在 MIGRATION_SQL 内，而 `boot-check.ts:14` REQUIRED_TABLES 强制要求 → 仅 autoMigrate 的部署 boot 告警、通知/审批端点报表不存在。
- 修复：单一迁移事实源（migration.ts 直接执行 `scripts/migrate*.sql` 文件，或把漂移项并入 MIGRATION_SQL 并删双份）；以 schema.ts 为口径做一次 diff 校对；CI 加「migration.ts 与 scripts/*.sql 表名/索引断言比对」脚本。
- 验收：全新库按官方迁移路径重建后 `boot-check` 全表通过、settings 双 business 可并存、staff 可写；CI 新增比对步骤。

**[P0-15] email_send_tasks 无租约恢复：任务与活动永久卡死 / 重复外发**
- 证据：`src/lib/email/outgoing.ts:128-171` CAS 置 sending 后发送，进程崩溃即永远停留 'sending'（无 15min 回收，对比 migration.ts:245-249 的 claim 有 lease）；`finalizeCampaignIfComplete:198-204` 把 sending 视为未完成 → 活动永不 sent、审批 execution_result 卡住；反向地 SMTP 已发但回写失败会重发（无 Message-ID 级去重）。
- 修复：加 claimed_at 与租约过期回收（sending ∧ claimed_at<now-15min → queued + attempts+1，超 max_attempts → failed）；发送前落 claimed_at；考虑 outbox 同款处理。
- 验收：新增单测：模拟崩溃残留 sending 行被回收重发、attempts 上限后转 failed。

**[P0-16] Web Push 瞬时失败被静默置 sent（通知丢失）**
- 证据：`src/lib/notifications/push.ts:64-75` 对非 410/404 失败只 failed++ 不抛错；`src/lib/notifications/outbox.ts:140-163` 忽略返回值一律 update status='sent'；无订阅也计 sent。
- 修复：push 适配器返回结构化结果，failed>0 或 sent=0 视为未完成，由 outbox 按 attempts/backoff 重试；仅 410/404 删除订阅；scheduler 恢复逻辑复核（daily_briefing 只应成功一次）。
- 验收：新增 outbox 单测：模拟 429 后重试成功；重复 tick 不重复发。

**[P0-17] scheduler 60s tick 无互斥 + 单点异常中断整轮**
- 证据：`src/lib/scheduler.ts:313-319` setInterval + `void runScheduledJobs()` 无 in-flight 检测；:289-306 单 tick 内多 business 串行且无逐项 try/catch——:296 getSchedulingConfig 抛错即外层 catch 跳过剩余全部 business；单 business 简报/同步耗时 15-20s+ 时 tick 必重叠 → cron_state 读-判-写竞态，重复外发。
- 修复：模块级 in-flight 锁（超时强制续跑）+ 每 business 独立 try/catch；对可重入任务加 DB 水位原子更新。
- 验收：新增 scheduler 并发单测（两 tick 重叠时简报任务仅执行一次）；长任务模拟下无重叠。

**[P0-18] AI 路由无 scope 时跨租户读取模型配置并解密他租户 API Key**
- 证据：`src/lib/ai/router.ts:176-213` —— scope 缺省时 `settings` 与 `model_configs` 查询均无 tenant 过滤（`if (scope) { …eq }`），命中任意第一行后 `decrypt(cfg.api_key_encrypted)`（:246）直接用其 Key 发请求；settings 按 tenant+business 多行存储（migrate.sql:430 唯一索引）。实际调用方 `src/lib/customization/nl-engine.ts:522-539` 与 `src/lib/coding-agent/code-generator.ts:129-138` 以「无租户业务 scope（允许的例外）」注释传 `undefined`。
- 影响：平台级 LLM 调用（NL 定制/编码提案）会随机命中**任意租户**的 model_assign 与 model_configs，解密并使用该租户付费 Key 发送含平台代码/租户文本的请求——跨租户凭据滥用 + 被借租户付费 + 行为非确定 + 用量记 null。
- 修复：平台级任务必须显式平台 scope（平台专用配置行/密钥）或强制指向 AUTO_ROUTE；`resolveModelDetailed` 在无 scope 时禁止无过滤 select（throw 或显式参数）；两个调用方补 scope。
- 验收：新增测试：无 scope 调用断言不产生无过滤查询（mock 层校验）或抛错；nl-engine/code-generator 调用点全部显式 scope。

**[P0-19] internal/business-data：静态共享 Key + 无 body 签名 + invocation 不强制 → 可绕过审批真实群发/写库**
- 证据：`src/app/api/internal/agent/business-data/route.ts:339-401` —— 认证仅为静态 `x-roveagent-key` 头比对（:383-386，无 body HMAC/时间戳；对照 `approvals/events/route.ts:43-57` 有 HMAC+±300s 时钟窗）；`invocation_id` 可选，缺省时 `approvalId=''` 仍执行 `executeRecoveryCampaign`（recovery-campaign.ts:219-232 向 email_send_tasks 真实插入逐人 SMTP 邮件）。
- 修复：写操作强制绑定已冻结 approval 的 execution/invocation（无记录即 403）；请求体 HMAC+时间戳；key 每部署唯一支持轮换；body 大小与并发限制。
- 验收：新增测试：无 approval 关联的群发请求 403；篡改 body 签名失败；时钟超窗拒绝。

**[P0-20] durable 任务引擎与迁移 schema 契约断裂（定时任务整体静默死亡）**
- 证据：`src/lib/agent/tasks/worker.ts:62-78,89-94` 写入 `agent_tasks` 的列（agent_type/priority/scheduled_at/attempt_number…）与状态词汇（QUEUED/COMPLETED…）在 `scripts/migrate.sql:436-588` 权威表中**不存在**（表列实际为 task_type/name/schedule_cron/status'active'/payload/next_run_at…；claim RPC 要求 run.status='pending' AND task.status='active'，worker 从不写这两个值）；worker 写 `agent_task_runs.attempt_number` 而 SQL 列名为 `attempt`。另 `detector.ts:94-101,143-152,180-189` 创建的 INVENTORY_ALERT_TASK/REVIEW_ANALYSIS_TASK/SALES_DROP_ANALYSIS_TASK 无任何注册 handler（worker 仅 DAILY_BRIEFING/EVENT_DETECTION）。
- 修复：以 claim 语义（pending/running/attempt/available_at/lease）为准重写 worker 或反向统一 SQL 与词汇；detector 三类任务「接线或移除」二选一；新增契约测试：对迁移 SQL 建真实/镜像库冒烟跑一次 worker 全链路。
- 验收：迁移库上跑通一次 DAILY_BRIEFING 全链路；`tests/agent-tasks.test.ts` 增加真实 schema 断言（现有测试 mock 掉 DB，掩盖此断裂）。

**[P0-21] 审批执行 `executing` 无租约恢复，资金副作用非幂等**
- 证据：`src/lib/agent/approvals.ts:361-415` —— CAS claim 置 executing（:361-374）后执行真实副作用（stripe.refund/roveagent 回调/邮件，:384-390）再置 executed；进程中途崩溃 → 行永久卡 executing：退款可能已在 provider 侧发生而库未回写，重复批准被拒、无对账路径。
- 修复：副作用前置幂等意图记录（refund 先落 pending 行 + provider 幂等键）；executing 超时租约（参照 claim RPC 15min 模式）触发重放，重放前以幂等键核对 provider 状态。
- 验收：新增测试：模拟 executing 卡死后租约回收并正确对账；重复批准恰一次生效。

### P1 — 次重要（按表逐项执行，每项一个小 commit）

| # | 位置 | 问题（证据已核） | 修复要求 |
|---|---|---|---|
| P1-1 | `api/internal/agent/business-data/route.ts:382-386` + `proxy.ts:48-55` | 服务密钥端点不在 PUBLIC_API_PREFIXES（auth-guard.ts:45-57 无 /api/internal），proxy 先要商户 JWT → 纯服务调用 401「死锁」 | 加入 public 白名单（handler 内已有密钥校验 fail-closed），与 approvals/events 同模式；补注释 |
| P1-2 | `webhooks/[provider]/route.ts:52-58,121-127` | receipt 无过期回收：处理中崩溃 → 重复事件永久 503，上游退避重试永不生效 | receipt 加 claimed_at；旧未处理行（>N 分钟）允许重占；补测试 |
| P1-3 | `src/lib/ai/usage-ledger.ts:33-65` | 单次写失败即置永久 dbUnavailable，之后用量全进 500 条内存环形缓冲静默丢弃 | 按次重试+退避探测恢复；降级打 warn 日志；补恢复测试 |
| P1-4 | `src/lib/ai/router.ts:196-209` | PROVIDER_ALIAS（claude→anthropic）只作用 catalog 查询未作用 model_configs 查询 → 旧 id 配置永远查不到并静默回落平台内置 | DB 查询用别名后 id；加断言测试 |
| P1-5 | `src/lib/connectors/square-sync.ts:138-159,190-207` + `scheduler.ts:222-233` | catalog/customers 完成态存 `''` → 下轮判为进行中从首页全量重拉并逐条 upsert；orders 每 15min 72h 回溯逐条 upsert | 完成态存 null/专用标记；orders 改 updated_at 增量游标；批量 upsert |
| P1-6 | `src/lib/email/imap-sync.ts:79-101` | 无 UID 水位，仅扫最新 200 封，越窗新邮件永久不入库 | per-account lastUID/UIDVALIDITY 游标 + 批量 upsert |
| P1-7 | `src/lib/scheduler.ts:200-218` | Telegram 双向问答发送失败仍推进 offset → 提问永久丢弃 | 成功才推进 offset 或入重试队列 |
| P1-8 | `src/lib/settings.ts` 缓存 + `auth-guard.ts:104,219` 缓存 | 进程内 TTL 缓存多实例最终一致（写后最长 30s/5min 读旧）；无并发上限审计 | 顶部加部署一致性契约注释；补「写后读立即新值」单测 |
| P1-9 | `src/app/api/agent/chat/route.ts:237-279` | SSE 断连 → assistant 不落库、摘要不推进、记忆不沉淀；每轮另调一次 LLM 抽记忆（延迟成本×2，吞错） | draft 行先行+结束 update；记忆抽取移后台/降频；摘要与消息插入同批 |
| P1-10 | `src/app/api/onboarding/confirm/route.ts:29-37` | 幂等匹配 `.ilike('name', …)` 名称含 %/_ 命中他店 | 改规范化精确匹配或 hash 键 |
| P1-11 | `src/app/api/health/route.ts:16-21` | 公开健康检查回显缺表清单/调度降级/加密配置等内部拓扑 | 收敛为 ok/status+版本号；细节仅服务端日志 |
| P1-12 | `src/app/api/store/menu/route.ts:15-16` | RPC `increment_store_qr_scan` 全仓无定义（迁移 SQL 无 create function）→ 扫码计数永不累计且每次公开访问一次写 | 迁移补函数+grant 或改应用层原子 update；补 e2e 断言 |
| P1-13 | Python `metrics.py:35-52`/`anomalies.py:43-54`/`data_layer.py:100-111` | 日营收/环比/流失检测默认 limit=100 静默截断（高峰门店数字失真，与 RoveFrame 口径对不上） | 服务端聚合或显式分页+溢出告警；统一流失口径（21 天 vs 60 天 vs TS 三处定义） |
| P1-14 | Python `approval_grants.py:13,48` + `permissions/engine.py:52-101` | 审批三套真源（grants 文件 500 条截断/进程锁、PermissionEngine 全内存、RoveFrame agent_approvals）互不互通 | 统一 agent_approvals 单一真源；本地 grant 改 SQLite+WAL+跨进程锁 |
| P1-15 | Python `workforce/employees.py:47-132` + `api/app.py:278-290` | 员工权限档案装饰化：ctx.permissions 取自请求体；emp.forbidden 只进 system prompt；员工权限点与 DEFAULT_POLICIES 两套命名 | ctx 权限由服务端档案推导并与策略表统一命名；加映射测试 |
| P1-16 | Python `api/app.py:88-94`+`audit.py:38-41`+`gate_hook.py:50-56` | 审计三处落地不 fsync 无轮转（含默认 ~/.roveagent 与 ROVEAGENT_ROOT 不一致） | 统一 sink + 批量 fsync + 轮转 |
| P1-17 | Python `state/chat_sessions.py:44-62`、`api/tasks.py` | sqlite 共享连接 check_same_thread=False 无 WAL/busy_timeout；task store 无锁 RMW | 每请求短连接或 WAL+busy_timeout；task 加版本号 |
| P1-18 | Python `app.py:234`、`approval_bridge.py:56` | ROVEAGENT_APPROVAL_SECRET 缺省回落 API Key（同值则持 Key 可伪造审批签名） | 强制分离部署检查；文档+启动断言 |
| P1-19 | Python `state/enterprise_memory.py:245-254` | purge_expired 无调用方；L4 与 chat_sessions 双份会话真源永不清理 | 会话轮转联动清理或 ttl+调度调用 |
| P1-20 | 前端竞态族 | dashboard range 切换（page.tsx:68-78）、reviews/knowledge/emails 筛选、customers 抽屉连点（:96-102）、business 筛选均无 abort/序号护栏，慢响应覆盖新响应 | 统一 useFetch/useSSE 护栏（AbortController/序号）；逐页替换 |
| P1-21 | 前端 SSE | `hooks/use-sse.ts:14-72` 卸载不 abort（跳页后流仍计费）；customers/marketing/emails 三份手写副本均不查 res.ok 且 catch 吞错 → AI 生成失败无提示 | use-sse 增加 cleanup/重连参数与 res.ok 校验；三处副本改复用 |
| P1-22 | 前端 i18n 缺口 | `onboarding/*`、`admin/*` 全中文硬编码未走 t()；signup 行业选项硬编码英文 | onboarding/auth 补命名空间并三语；admin 平台控制台声明语言策略并至少统一 |
| P1-23 | 假操作按钮 | dashboard Approve/Execute（page.tsx:296-298 仅 router.push）、topbar owner（:130-133 无 onClick）、reservations「AI 优化排台」（:391-394） | 接真实动作或改文案「查看详情」；删除死交互 |
| P1-24 | 前端乐观更新无回滚 | business/page.tsx:243-251 商品上下架失败不回滚、emails markAllRead:115-122 同族 | 失败回滚+toast；统一提交函数 |
| P1-25 | store 预展示与权威计价 | store/page.tsx:62-68 vs 95-97 前端按 menu 算总额，下单后展示服务器价，价变时无解释 | 下单成功后展示服务器明细或提交前取价 |
| P1-26 | `src/lib/memory.ts:45-53` + `agent/chat/route.ts:161-176,256-278` | 每轮自动记忆抽取（>15 字符即触发额外 LLM 调用，无上限/去重），且记忆原文不设「数据围栏」直拼 system prompt → 间接 prompt 注入放大 + 账单膨胀 | 仅显式/owner 确认沉淀；上限+哈希去重；注入加 `<memory>` 分隔围栏；抽取走低配模型可关闭 |
| P1-27 | `src/lib/ai/router.ts:294-298` + `api-helpers.ts` | AIError 消息内嵌 provider 原始响应 body（可能含请求回显），进日志并外泄客户端 | 截断 ≤500 字符并剥离可疑内容；errorResponse 只出 requestId+文案 |
| P1-28 | `src/lib/coding-agent/apply-engine.ts:155-276` 生产启用门 | 多租户共享部署下任一租户 owner 可合入平台共享仓库 + 每次 ~8min×2 测试占用（无全局锁/限流） | 仅单租户/演示实例（显式 env 门 + `applyEngineAvailable` 加环境检查）；全局串行队列+每租户频率限制；修改已导入文件（src/custom/ 等）的提案强制人工 diff 确认 |
| P1-29 | `src/lib/agent/audit.ts:85-88` | audit_events 写失败仅 console.error，审批/执行审计链静默缺失但状态仍返回成功 | 审计失败计入审批结果并告警；enterprise/tool-runtime.ts:239-247 审计 input 复用 registry 的 redactAuditInput 脱敏 |
| P1-30 | `src/lib/roveagent/client.ts:32-60` | 服务间通道未强制 TLS（可配 http:// 明文 IP），共享密钥明文过网 | 启动校验/部署文档强制 HTTPS+回环；补 `app.py:598-605` 双入口清理 |
| P1-31 | `router.ts:614-619` SSE 非法行静默丢弃 | 供应商流被污染/截断时模型「答到一半」无诊断 | 计数非法行，阈值后抛 stream_error 或计入诊断字段 |

### P2 — 整洁（等价重构，禁止行为变化）

| # | 位置 | 处理要求 |
|---|---|---|
| P2-1 | `src/app/[locale]/settings/page.tsx` 1696 行、`business/page.tsx` 1285 行 | 按 feature 拆组件+hooks（数据/UI 分离）；每步 ts-check+test |
| P2-2 | 635 处非空断言热点（platform-admin 25/channels 23/approvals 18/router 15…） | 逐处判断：真不变量加注释，可收窄改守卫；目标降 ≥30%（<400） |
| P2-3 | `src/components/ui/` 44/56 零引用（chart 357 行、sidebar 724 行、form、use-mobile）+ 平行自绘体系 | 删死文件或反向复用；手写 Toggle（settings:125-140，无 role=switch）等改 ui/ 组件 |
| P2-4 | a11y：手写弹层无焦点陷阱/无 Esc（knowledge/customers/reservations/store/marketing）、图标按钮无 aria-label、agent-card 可点 div 无键盘可达 | 换 Radix Dialog/Sheet（已装）；补 aria-label/role；验证键盘全流程 |
| P2-5 | 兜底硬化残留：approvals/audit 40+ 处 `t.has(...) ? t('...') : '英文'`；knowledge `{docs.length} docs`；customers 中文顿号 `、`；reservations 占位符 Michael Chen | 删 t.has 兜底改纯 t()（键已齐）；文案/占位符入 messages 三语 |
| P2-6 | PWA：PushSubscribe 挂载即弹权限（:31） | 改设置页/引导显式 opt-in；react-dev-inspector 仅在 dev 引入（[locale]/layout.tsx:5,44）；timeAgo 无 tick（改组件+interval 或绝对时间）；approvals 8s 轮询加 visibilitychange+in-flight 去重 |
| P2-7 | 文案双轨：AI system prompt 硬编码（chat/route.ts:44-56 等）与 messages 不一致（es 回退英文） | 集中 prompts 模块按 locale 取用；消息键审计脚本入 CI |
| P2-8 | `schema.ts` 1059 行 / `migration.ts` 668 行 / `router.ts` 766 行 / `sidebar.tsx` 724 行 | 按域拆分（保持 import 面）；协议适配层与路由决策分离 |
| P2-9 | 根 `AGENTS.md` 仍描述 Phase1/2（19 表/10 页/旧 api-helpers ok/err） | 指针化重写指向 docs/current；docs 补 EXPERIMENTAL_MODULES.md（P1-3 实验子系统威胁模型+feature flag 默认关） |
| P2-10 | Python `runtime.py` 巨型转发层 / `approvals_test.py` 命名误导 / 产品包内嵌 *_test.py | 转发层加边界注释；测试移 tests/ 或改名；业务层保持零 TODO |
| P2-11 | 依赖卫生 | @aws-sdk/* 全库零引用移除；serwist disable 状态与 sw.ts 处理；react-day-picker/cmdk/vaul 等按引用核实；移除同步 lockfile |
| P2-12 | CI/校验漂移 | `validate` 不含 test:python/build/stylelint 之外补全：新增 `pnpm validate:all`；CI 对齐（当前 CI 仅 ts-check+test+lint:build） |
| P2-13 | `apply-engine.ts:102-149` rollback 门禁失败仍标 rolled_back（代码已变更） | 门禁失败不标记成功回滚，状态与事实一致 |
| P2-14 | `deployment/generator.ts:65-87,216-217,244` sslEmail/healthPath 校验不足（无空格即可含 `;`/`$()`）拼入 deploy.sh | 参数化/单引号 + 字符白名单 |
| P2-15 | 契约测试补强 | worker↔schema（P0-20）与 task-handler 注册表测试进 CI；`approvals_test.py`（Python CLI 干跑器）改名/迁移，产品包内 *_test.py 移 tests/ |

### 红色底线（任何情况下不得违反）
1. `as any`/`@ts-ignore` 新增即失败；strict 类型收窄；禁隐式 any/未用变量导入。
2. Next 路由副作用必须 `await`（fire-and-forget 被丢弃）；流式一律 `sseResponse`，禁止直接 return AsyncGenerator。
3. 生产禁止 `RF_E2E_DEMO=1`（server.ts 已拒绝启动，保持）；演示播种只经显式 env。
4. 凭据不落日志/不进 audit payload/不回传；ENCRYPTION_SECRET 生产缺失=启动失败（保持 fail-closed，收紧 P0 兜底常量与同源回退）。
5. RLS 33 表不回退；新表必须同步 migrate-rls.sql 与 verify-rls.sql；租户数据访问一律走 tenant-db 白名单 helpers。
6. 时区：全链路「UTC 存储 + 业务时区切日」；`toISOString()` 仅存储/传输。
7. i18n：新文案必须 en/zh/es 三语同 commit。
8. Hydration：渲染期禁 typeof window/Date.now()/Math.random()；禁 `<head>`；禁非法嵌套；React Compiler 下渲染期不重赋值累积变量。
9. 加密凭据读写只经 `@/lib/crypto`（改造需先完成本文件 P0 中密钥版本化方案再动，避免在产数据不可解）。
10. 业务安全语义修改（审批状态机/门控/幂等）不得与「视觉/格式化」同 commit；Python 运行时（core/gateway/clisupport 大目录）只做边界整理不重构内核。

## 四、验证矩阵（每个 P0/P1 完成后全跑）

```bash
pnpm ts-check
pnpm lint:build && pnpm lint:style
pnpm test                        # TS ≥278 通过（不得减少）
python -m unittest discover -s roveagent -t . -p '*_test.py'   # ≥21 通过
pnpm scan:production
pnpm build                       # next build + tsup
pnpm run e2e:recovery            # live 全链（无真实凭据栈时注明跳过原因）
```
按需：`scripts/verify-rls.sql`（目标库零交叉）；i18n 键三语比对；新增迁移在全新库演练；P0-5 后补 SSRF 专项测试进 `pnpm test`。任何一项失败 = 该 commit 不合入。

## 五、验收总门（全部完成才算结束）
- [ ] P0-1…P0-21 全部修复并有回归测试（Python 项在 roveagent 侧补测试）
- [ ] P1 表 ≥80% 落地（未做项给出理由与负责人）；P2 ≥10 项落地
- [ ] 全库 `as any`/`@ts-ignore` = 0；非空断言下降 ≥30%
- [ ] TS 测试 ≥278、Python ≥21，**新增 ≥30 个**（含限流/SSRF/越权/幂等/租约/隔离/契约冒烟）
- [ ] 三语键零漂移；无新增硬编码用户文案；CI 与 validate:all 对齐
- [ ] 迁移单一事实源落地，全新库演练通过 boot-check
- [ ] 每条修复按「证据/改动/测试/风险」回填；全部为可独立 revert 的小步 commit
- [ ] 文档更新：AGENTS.md 指针化 · ARCHITECTURE.md（缓存/RLS/时区语义）· EXPERIMENTAL_MODULES.md（含 coding-agent 启用门）· API_PERMISSION_MATRIX.md

## 六、审查范围声明（证据边界）
主干人工核查：`src/proxy.ts` · `server.ts` · `lib/auth-guard.ts` · `lib/auth.ts` · `lib/crypto.ts` · `lib/api-helpers.ts` · `lib/tenant-db.ts` · `lib/settings.ts` · `lib/ai/router.ts` · `storage/database/supabase-client.ts` · `lib/coding-agent/apply-engine.ts` · `lib/healing/patch-generator.ts` · `lib/customization/nl-engine.ts` · `api/{agent/chat,store/orders,upload,integrations/test,integrations/[provider]/sync}/*` · `hooks/*` · `[locale]/settings/page.tsx` · CI/lint/next.config · messages 键集 · roveagent/pyproject.toml 与目录规模。

五组独立分片深审（每组逐文件精读并核对行号）：
1. **API/鉴权**：84 route.ts 全量分类（含动态段）+ 13 个核心 lib —— 产出 P0-1/3/4/5a-c/6 + P1-1/9-12 等；
2. **数据层/DB/集成**：storage/*、migration.ts、scripts/*.sql、connectors/email/notifications/payments/scheduler/crypto/embedding/usage-ledger —— 产出 P0-2/14/15/16/17 + P1-2…8；
3. **Python roveagent**：业务薄层 100% 精读 + 运行时安全件精读 —— 产出 P0-9…13 + P1-13…19；
4. **前端/i18n**：20 页 + 73 组件 + hooks + messages 全量 —— 产出 P0-7/8 + P1-20…25 + P2-3…7；
5. **Agent 平台内核/实验子系统**：lib/ai 全量、lib/agent（tasks/events/approvals/tools）、coding-agent、healing、enterprise、customization、deployment、plugins、roveagent client、packages/roveagent-core 及对应 API —— 产出 P0-18…21 + P1-26…31 + P2-13…15。

量化扫描口径：src 全 274 ts/tsx 文件（any/ts-ignore/TODO/console/非空断言/路由数/zod 使用/RPC/限流）；roveagent 全 .py（规模/TODO/except）；messages 键集脚本比对。五组分片相互独立、无交叉覆盖之外的盲区（测试文件断言质量未逐读，P2-15 已要求补契约测试兜底）。
