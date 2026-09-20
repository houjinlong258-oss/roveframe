# Phase 16 — 从"能演示"到"能收钱"

Phase 16 接续 Phase 15 的真实环境验收，处理任务书列出的 11 项。目标不是增加代码，
而是把"看起来很完整、实际收不到钱"的几处补齐，并为每一处给出可复现的证据。

**所有数字来自本轮实测命令输出。无法测量者标 UNVERIFIED。**

判定沿用本项目四层口径：
**L1 代码存在 → L2 测试通过 → L3 真实调用 → L4 生产可用**。

---

## 1. 一句话结论

仪表盘不再编造增长数字、订阅门禁真正生效、新商家第一天的店名与货币是对的、
群发邮件第一次具备退订能力（真实 SMTP 抓包验证 `List-Unsubscribe` 上线）、
扫码下单的幂等键第一次被客户端真正发送、被邀请人第一次能通过鉴权。

**并且本轮推翻了任务书里的两条断言**：`ROVEAGENT_COMMAND_POLICY` 并非"0 引用"；
`social` 社交发布不是"措辞问题"，是一个**空的 toolset**（CMO 声明的 8 个 toolset 里
`social` 与 `media` 都解析不出工具）。

收入通路本身**仍未打通**：本轮的决策是"平台管理员手工开通 + 离线收款"，
支付网关自动扣费（Stripe Subscription）明确留到第二阶段。

---

## 2. 基线（本次实测，动手之前）

| 项 | 任务书基线 | 本次实测 | 判定 |
|---|---|---|---|
| git HEAD | `9d2d8cf` | **`2b96321`**（多一个 docs 提交） | 差异已说明 |
| 工作树 | 干净 | **干净** | 一致 |
| Python 测试 | 815 OK（4 skip） | **815 OK（skipped=4）** | 一致 |
| TypeScript 测试 | 726 | **725**（724 pass / 1 skip / 0 fail） | 差 1，未查明 |
| `pnpm validate` | exit 0 | **exit 0**（生产扫描 2296 文件） | 一致 |
| 容器 | 双 healthy | **双 healthy**（web `phase13`） | 一致 |
| `/api/health` | ok:true | **ok:true**，调度器 `source=heartbeat`、`tickAgeMs 39.5s` | 一致 |

> TS 用例数 726 vs 725 的 1 个差值**本轮未查明**（UNVERIFIED）。不影响任何结论方向。

---

## 3. 任务 1 —— 仪表盘在零数据账户上编造增长数字

### 3.1 问题（已核实）

`src/app/api/dashboard/route.ts` 的真实路径对**每个**账户返回写死的增长：

```
L150  todayCustomers: Math.round(todayOrders.length * 1.8),   // 订单数 × 1.8
L154  ordersDelta: 8.4,
L155  customersDelta: 5.2,
L156  ratingDelta: 1.2,
```

### 3.2 动手前的取证（`scripts/_verify_dashboard_kpi_basis.mts`，只读）

| 问题 | 实测 |
|---|---|
| `orders` 时间跨度 | 锚点租户 43 单，最新 **2026-09-05**；今日与上周同日均为 **0** |
| `reviews.created_at` | **存在** |
| `customers.created_at` | **存在** |
| 探针有效性 | `select('id')` on 真实表 → 1 行；on `zzz_definitely_not_a_table_9f3a` → **ERROR**（探针可败） |

结论：在当前数据下"真实计算"会得到 **null**（对比期无订单），而那才是正确答案。

### 3.3 修法

新增 `src/lib/dashboard-metrics.ts`（纯函数，可被测试真实调用）：

- 区间口径：本期 = 今日往前 `range` 天，对比期 = 紧邻的等长前一段；
- **无对比依据 ⇒ `null`**，不是 0。`0%` 是一个断言（"与上期持平"），
  而没有依据不是持平；
- `todayCustomers` 改为**今日订单覆盖的不同客户数**；
- 响应新增 `basis`（两段区间的起止与各自的订单/营收/客户/评价数），
  让"这个百分比从哪来"可被外部核验；
- 演示分支保留原门控（`RF_E2E_DEMO=1 && COZE_PROJECT_ENV !== 'PROD'`），
  并加 `demo: true` 标记使其一眼可辨。

UI 侧 `InsightCard` 增加三态：`null` → 显示 `—` + "无对比期数据"（三语 `noComparison`）。
原先页面写 `delta ?? 0`，会把 null 变成 `+0%` —— 那仍然是编造。

### 3.4 证据

| 层 | 证据 |
|---|---|
| L2 | `tests/dashboard-no-fabrication.test.ts` **24 例**（真实调用 `computeDashboardKpi`） |
| L2 负向对照 | 把旧的 `8.4/5.2/1.2` 与 `订单数×1.8` 注入回实现 → **24 例中 9 例变红**；还原后逐字节比对一致 |
| L3 | `scripts/_verify_dashboard_no_fabrication.mts` 对真实服务 **20/20 通过** |

真实响应（新注册的零数据商户）：

```json
{"todayRevenue":0,"todayOrders":0,"todayCustomers":0,
 "positiveRate":0,"avgRating":0,
 "revenueDelta":null,"ordersDelta":null,"customersDelta":null,"ratingDelta":null}
```

阳性对照（同一商户插入真实订单后，**必须算出非 null**，否则"永远返回 null"也能骗过测试）：

```json
{"ordersDelta":50,"revenueDelta":166.7,"ratingDelta":null}
basis: {"periodStart":"2026-09-12","periodEnd":"2026-09-18",
        "priorPeriodStart":"2026-09-05","priorPeriodEnd":"2026-09-11",
        "hasPriorBasis":true,"current":{"orders":3,"revenue":200},
        "prior":{"orders":2,"revenue":75}}
```

### 3.5 我自己算错的两处（记录）

第一次写阳性对照的断言时，我把"本期"当成"今日"（写成 +150 / +700），
实测是 **+50 / +166.7**。错在我的期望值，不在实现；已就地改正。
同样地，两次断言失败都不是实现缺陷，而是**我的断言与真实口径不一致**
（下文任务 4 的 SMTP 头折行、任务 5 的 token 格式也是同一类）。

---

## 4. 任务 2 —— 订阅与权益门禁

### 4.1 决策（写进报告，再改代码）

**商家如何付费：平台管理员手工开通 + 离线收款。**

理由（三条，都不是偏好）：

1. **现有基础设施已经支持**：`/api/admin/tenants/[id]` 的
   `record_offline_renewal` 分支已能写 `renewal_source='offline'`、
   `last_payment_status='paid_offline'`、`current_period_end` 与 `grace_period_end`；
2. **自动化 Stripe 订阅是另一档工程**：Customer / Price / Billing Portal /
   webhook 续期 / 按周期对账，且**本环境没有可验证的 Stripe 凭据**，
   做了也只能停在 L1–L2（代码存在、测试通过），拿不到 L3；
3. 试点期的实际收款方式是转账/线下，平台需要的不是自动扣费，而是
   **"没交钱的商家不能被继续服务"** 这条能力 —— 这正是本轮实现的部分。

**第二阶段（明确未做）**：Stripe Subscription 自动续费、Billing Portal、
webhook 驱动的状态机。

### 4.2 现状（实测）

| 观测 | 值 |
|---|---|
| `subscription_plans` | **0 行**，且仓库里没有任何脚本灌过它 |
| `tenant_subscriptions` / `invoices` / `feature_entitlements` | 全部 **0 行** |
| 业务代码读 `tenant_subscriptions` | **0 处**（只有 3 个 admin 路由） |
| 注册流程 | 不建订阅 |

### 4.3 实现

| 件 | 内容 |
|---|---|
| `src/lib/entitlements.ts` | 判定表 + fail-closed + 5 秒判定缓存 + `invalidateEntitlement()` |
| `src/lib/subscription-plans.ts` | 套餐 id 与试用期的单一事实源（与迁移 SQL 对齐） |
| `scripts/migrate-subscriptions-seed.sql` | 4 个套餐 + 存量租户回填 + 平台默认 entitlement |
| `src/lib/auth.ts` | `createTrialSubscriptionRow()` |
| `signup/route.ts` | 建 trialing 订阅（含 `current_period_end`） |

判定表（关键分支）：

| status | 期内 | 判定 |
|---|---|---|
| `active` | — | full |
| `trialing` | 是 / 无到期日 | full |
| `trialing` | 已过期 | read_only（`trial_expired`） |
| `past_due` / `grace` | 宽限内 | full |
| `past_due` / `grace` | 宽限已过 | read_only |
| `suspended` | — | suspended（写被拒） |
| `cancelled` | 期末前 / 后 | full / read_only |
| 未知状态 | — | read_only（`unknown_status:*`） |
| **无订阅行** | — | read_only（`subscription_missing`） |
| **查库失败** | — | read_only（`lookup_failed`） |

### 4.4 门禁挂在哪：唯一插入点 + 显式覆盖清单

全部 **96 处** `getTenantContext(request)` 调用、**59 个路由文件**都经过
`src/lib/tenant.ts`，因此门禁挂在那里（逐个路由加检查必然漏项）。

**但初版做成"所有写方法都拦"，被实测打回**：本仓库既有测试用非 UUID 的假租户
（`tenant_phase8`）调用真实 handler，初版让
`tests/phase8-approval-ui.test.ts` **8 例变红**。

测试只是暴露者，真正的问题是**拒绝范围没有反映商业边界**。改成显式清单：

```
/api/payments/      钱
/api/marketing/send/    /api/channels/send/    /api/emails/send/    发给顾客的东西
/api/store/qr-codes/    /api/reviews/reply/    对外发布出来的内容
```

即：**门禁管"对外可见 / 要花钱"的动作**，不管内部草稿写入
（欠费商家仍能更新自己的设置、运维仍能改配置）。这与任务 7 的口径一致。

### 4.5 证据

| 层 | 证据 |
|---|---|
| L1 | 迁移 SQL 已加入 `MIGRATION_FILES`（单一事实源） |
| L2 | `tests/subscription-entitlements.test.ts` **44 例** |
| L2 负向对照 | 把无订阅行分支改成"永远放行" → **44 例中 7 例变红**（含"写请求必须被拒"）；还原后逐字节一致 |
| L3 | 迁移已在真实库执行**两次**（幂等）：4 套餐 / 1 订阅 / 5 entitlement / 0 孤儿 `plan_id` |
| L3 | `_verify_phase16_core.mts`：trialing 放行 → suspended 被拒（402）→ 恢复后放行 |

真实库执行结果：

```
subscription_plans     {"n":4}
plans by slug          {"s":"free=0.00, internal=0.00, starter=29.00, growth=99.00"}
tenant_subscriptions   {"n":1}    subs by status {"s":"active:1"}
plan_id 都存在          {"n":0}    （0 = 没有指向不存在套餐的订阅）
无订阅的 tenant          {"n":0}    （0 = 没有租户会因缺行被误降级）
```

锚点租户（`000…000`）回填为 **internal / active**（平台自营，不计费）。

### 4.6 门禁暴露的一个真实缺陷（已修）

第一次端到端运行时，被停用的商户拿到的是 **401 `authentication failed`** ——
而它的凭据完全有效。根因：`mutation-guard.ts` 的 `scopeErrorResponse` 没有映射
订阅错误，于是 402 被吞成 401。**商家会以为密码错了去重置密码，真正的原因
永远不会显示。** 已修（`subscriptionRequiredResponse`）并纳入端到端断言。

---

## 5. 任务 3 —— 新客户第一天的路径

### 5.1 修法（二选一里选了"注册时建行"）

| 做法 | 取舍 |
|---|---|
| **注册时建 `settings` 行**（选定） | 只有一个事实来源；`/api/settings` 的写路径本来就靠 `settings.id` 是否存在决定 insert/update |
| 读的时候合成一行 | 会让 `settings.business` 在商家第一次保存前后语义不同（派生值 vs 真值） |

注册流程现在按序：tenant → business → **订阅** → auth user → public.users → **settings** → 登录。
订阅刻意放在建 auth 用户**之前**：门禁是 fail-closed 的，若先发凭据再发现订阅建不上，
用户会拿到一个"能登录但什么都做不了"的账号。

### 5.2 店铺名不再回落成字面量 "Store"

`/api/store/menu` 原为 `business.name ?? 'Store'`。现在 settings 行缺失时返回
**409 `store_profile_missing`**，而不是编一个店名 —— 一个假店名比一个空值更糟。

### 5.3 证据（真实服务）

```
settings.business = {"name":"Phase16 Cafe 1789736942514","industry":"restaurant"}
settings.locale   = {"currency":"CNY","language":"zh"}
菜单响应 store    = {name: "Phase16 Cafe 1789736942514", currency: "CNY", ...}
```

`_verify_phase16_core.mts`：注册建了 **1 行** settings；菜单返回**真实店名**；
货币是注册时选的 **CNY**（不是默认 USD）。

### 5.4 未做（如实记录）

| 项 | 状态 |
|---|---|
| `noPlatformProviderError` 三语 | **未做** —— 错误文案仍是中英混排。这是 i18n 工作量，不影响首日路径可用性 |
| 引导向导（`/[locale]/onboarding`） | **未做** —— 实测：208 行、**228 个中文字符**、`useTranslations` **0 次**，且没有任何导航入口 / 调用点。按"禁止无分析删除"的规矩，本轮**未删**；接进流程需整页三语化 + 修工作区归属（`onboarding/confirm` 不更新 `public.users.business_id` 与 JWT `app_metadata`）。因注册已建默认工作区，向导不是收入阻塞项 |

---

## 6. 任务 4 —— 群发邮件合规

### 6.1 修掉的四处（前两处是硬要求）

| # | 问题 | 修法 |
|---|---|---|
| 1 | 没有退订、没有 `List-Unsubscribe`、没有过滤 | 新表 `email_unsubscribes` + RFC 8058 双头 + 正文链接 + **发送前过滤** |
| 2 | UI 判定 ≠ worker 判定 | `src/lib/email/eligibility.ts` 单一事实源，两条路径共用 |
| 3 | 保存邮箱账号不验证 SMTP，"已连接"是无证据的断言 | 保存时**真连一次**，失败不落库；结果写 `last_test_ok/last_tested_at/last_test_error` |
| 4 | Outlook 预设用 465，Office 365 不接受 | `smtp-presets.ts`：Outlook/Gmail/iCloud = 587 STARTTLS |

### 6.2 退订的完整链路

```
入队（marketing/send）→ 每封信生成并落库 unsubscribe_token + unsubscribe_url
出件（outgoing.processEmailSendQueue）
  → 批量预取本批 (tenant,business) 的退订地址（一次查询，不逐封查库）
  → 命中退订 ⇒ 终态 skipped_optout（不重试，因为重试只会永远卡在队列里）
  → 未命中 ⇒ 发送时带 List-Unsubscribe + List-Unsubscribe-Post + 正文链接
退订入口
  → GET  /{locale}/unsubscribe?token=…   给人点（点一次即生效）
  → POST /api/email/unsubscribe?token=…  给邮件客户端一键退订（RFC 8058）
```

**fail-closed**：退订名单查不到时**不发**（保持 `queued` 等下一 tick），
宁可延迟也不违反退订。

地址归一化用 `lower(trim())`：不做归一化时 `Alice@x.com` 与 `alice@x.com`
是两个身份，退订后换个大小写就能继续发 —— 等于退订无效。

### 6.3 证据

| 层 | 证据 |
|---|---|
| L1 | 迁移已落地：`email_unsubscribes` 表 + 4 个索引 + `email_send_tasks` 2 列 + `email_accounts` 3 列 |
| L2 | `tests/email-compliance.test.ts` **32 例** |
| L3 | **真实 SMTP 抓包**：本地起 SMTP 服务，把一封信的原文抓下来 |

真实 SMTP 服务器收到的原文（节选）：

```
List-Unsubscribe: <https://app.example.com/api/email/unsubscribe?token=abc123>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
...
You are receiving this email from Sichuan House because you are a customer on record.
Unsubscribe: https://app.example.com/api/email/unsubscribe?token=abc123
```

并断言**正文链接与头指向同一个地址**（否则退订有两个入口、其中一个可能失效）。

### 6.4 仍未做（如实记录）

**发送仍在 HTTP 请求里串行做逐人 LLM 生成。** 本轮做了两件真事：
显式上限 `MAX_RECIPIENTS_PER_REQUEST = 25`，返回值如实回报
`processedThisRequest` / `remaining`（而不是假装全部完成）。
真正的解法是把生成搬进 worker —— 出件队列与 scheduler 已就绪，
但逐人生成需要把模型上下文一起入队，属下一阶段改动，**本轮不做**。

---

## 7. 任务 5 —— 扫码点餐

### 7.1 收款口径的决策

**本轮定为"到店付/后付"，不接"扫码即付"。**

理由：到店付不需要平台托管资金、不承担部分退款与超时未付的状态机，
且**不需要 Stripe 凭据就能端到端验证**。用户选择了"两者都要"，
其中"扫码即付"需要真实 Stripe 凭据（本环境无）才能给出 L3 证据，
因此明确记为第二阶段，不在本轮声称完成。

### 7.2 修掉的三处

| 问题 | 修法 |
|---|---|
| 唯一的客户端从不发 `Idempotency-Key` | 下单开始时生成一次，失败重试复用，成功后释放（`useRef`，不参与渲染） |
| 新订单不通知任何人 | `notifyNewOrder()` → `notification_outbox`（email + web_push），复用既有 worker |
| 二维码 URL 缺 locale 前缀 | `storeUrlFor()` → `/{locale}/store?token=…`（`localePrefix: 'always'`） |
| **同 key 不同内容被静默吞掉**（本轮新发现） | 指纹比对，不一致返回 **409 `idempotency_key_conflict`** |

最后一条是本轮**新发现**的问题：服务端原本对同 key 一律返回既有订单
（`idempotent: true`），无论内容是否相同。顾客改了菜再点一次（客户端复用 key）
会看到"下单成功"，而厨房永远收不到这一单。

### 7.3 证据

`_verify_phase16_core.mts`（真实 HTTP + 真实库）：

| 断言 | 结果 |
|---|---|
| 第一次下单成功且非幂等命中 | PASS |
| 第二次同 key 命中幂等，返回**同一张**订单 | PASS |
| 库中只有一单（真实落库计数，不是响应自述） | PASS |
| 同 key 改数量被拒（409） | PASS |
| 新订单写入商户通知 | PASS |

---

## 8. 任务 6 —— 团队邀请

### 8.1 修掉的四处

| 问题 | 实测 | 修法 |
|---|---|---|
| 不写 `app_metadata.tenant_id` | `auth.ts:219`、`auth-guard.ts:164` 都读它 | 补写 `tenant_id` + `business_id` + `role` |
| `redirectTo` 指向不存在的路由 | `<origin>/auth/callback` 无对应页面 | 改为 `/{locale}/auth/login` |
| `invite_url: null` | 注释写着"调用方用现有邮件通道发送 invite_url"，却返回 null | 返回 Supabase 的 `invite_link` |
| 没有 UI 入口 | 无调用点 | **未做**（见下） |
| `manager` 没有 `marketing:send` | `rbac.ts` | 已放开（对外动作仍受审批与门禁约束） |

### 8.2 诚实边界

**"被邀请人能通过 `resolveUserByToken`"这条 L3 验收未取得。**
原因：`inviteUserByEmail` 需要平台侧配置邮件服务，且验证"接受邀请后的身份解析"
需要一个真实的收件箱完成设密流程。本环境的 Supabase 项目**未配置自定义 SMTP**
（UNVERIFIED：未直接读取该项目 Auth 设置确认，仅依据本项目从未配置过该服务）。
因此本轮定位为 **L1 + L2**：

- L1：代码已修（tenant claim / redirect / invite_url）；
- L2：源码契约测试断言 `tenant_id` 与 `redirectTo` 的形状；
- **L3 未取得** —— 需要平台侧邮件服务或一次手工接受邀请。

---

## 9. 任务 7 —— 审批路径统一

### 9.1 决策

**对外可见的动作必须经审批；内部草稿写入保持直接写。**

范围（与任务 2 的门禁清单同源）：

| 必须经审批 | 保持直接写 |
|---|---|
| 发送营销邮件 / 渠道外发 / 回复邮件 | 生成内容、保存草稿 |
| 发布评论回复 | 评分、分类、打标签 |
| 社交发布（**该能力不存在**，见 §12） | 内部配置与设置 |

### 9.2 本轮实际改动与未做

本轮**没有**把 reviews 起草/发布与 `channels/send` 改到审批路径上。
理由：这是一次跨模块改造（需要 UI 侧改用审批入口 + 补齐审批后的执行回写），
在剩余预算内无法同时给出 L3 证据与不回退既有行为。
**如实记录为未完成**，而不是写"已统一口径"。

已落地的相邻事实：任务 2 的订阅门禁清单与上述范围**保持同一份语义**
（对外可见 / 要花钱），因此两者不会各自漂移成两套定义。

---

## 10. 任务 8 —— 延迟尾部

**未做。** 89 s 的 p99 成因（单次慢调用 / 冷启动 / 重试叠加）本轮**没有取证**，
因此不给出任何归因。任务书要求的"先取证再改"在本轮预算内未执行。

已有可复用工具（Phase 15 交付，未本轮未运行）：`scripts/_verify_latency_breakdown.mts`。

**UNVERIFIED：修复前后 p50/p90/p99 对比。**

---

## 11. 任务 9 —— 延续项

| 项 | 本轮状态 |
|---|---|
| 水平扩展：限流接共享后端 | 未做（跨模块改造：12 处同步调用改 await） |
| APM / 日志聚合 | 未做（需外部系统） |
| RAG 嵌入 provider 抽象 | 未做。**文档侧要求已满足**：本报告明确"知识库依赖平台运行时身份，不是自托管能力" |
| 插件沙箱 L4 | 未做（候选集为空，无可验证对象） |
| `gateway/` 死代码 | 未动（沿用 Phase 13 结论：活跃依赖） |
| 镜像体积 | 本轮 web 镜像仍为全量树（未启用 `output: 'standalone'`） |
| `agent_tasks` worker 命令策略 | **本轮取证，见 §13** |

---

## 12. 任务 10 —— 外部集成

| 集成 | 本轮实测 | 判定 |
|---|---|---|
| ERPNext | Phase 15 已改为 `connectivity_only`；本轮复核 UI：徽章由 `syncable` 决定，已配置但不可同步时显示"仅连通性"+ 明确说明数据不会同步；面板里**只有"测试连接"按钮，没有同步按钮** | **已满足任务要求**（去掉会失败的东西） |
| RAG / 知识库 | `src/lib/embedding.ts:6` 凭据来自平台运行时身份 | **未做**；已在 §11 与本节写明"依赖平台" |
| 社交发布 | **推翻任务书的措辞判断**，见下 | 已改措辞 |

### 12.1 社交发布：不是"措辞问题"，是空的 toolset

任务书的说法是"改掉 `capability_router.py` 的措辞，或记为承诺未交付"。
本轮**实测**后发现更严重的事实（容器内解析）：

```
marketing 声明的 toolsets = ['safe','memory','business','knowledge','search','web','media','social']
marketing 实际可用工具   = 15 个
  ['web_search','web_extract','memory','read_sales','read_orders','read_customers',
   'read_products','read_inventory','read_reviews','read_payments','read_business_profile',
   'analyze_churn_customers','send_customer_recovery_campaign','search_knowledge','text_to_speech']
不可用 = ['vision_analyze','image_generate','video_generate','xai_video_edit','xai_video_extend','x_search']
```

**没有任何发布到社交平台的工具。** 也就是说 `social`（以及 `media`）
是**声明了却解析不出工具的 toolset** —— 能力清单在承诺一个未交付的功能。

处置：把 `capability_router.py` 的 summary 从"社交发布（需审批）"改为
"社交平台发布**尚未实现**，本角色只能生成内容，不能代发"。
未改 toolset 列表（`social` 留空是既有设计，删它需要一个独立的可达性判断）。

---

## 13. 任务 11 —— 命令策略（HIGH）

### 13.1 推翻任务书的一条断言

任务书写"`ROVEAGENT_COMMAND_POLICY` 在仓库里 **0 引用**"。**不成立**：

```
roveagent/api/command_policy.py:187   实现与文档
roveagent/api/command_policy_test.py   5 处引用（含测试）
roveagent/enterprise/gate_hook.py:162  import 并调用 command_policy_enabled()
```

（任务书的检索很可能用了会漏掉 Python 的模式。）

### 13.2 实测：策略层**确实挂在执行链上**，但**默认强制关闭**

| 观测 | 实测 |
|---|---|
| `install_enterprise_gate` 被谁调用 | `api/app.py:42,71`、`kernel.py:56-57` —— **生产入口**，并注册进插件中间件链 |
| 命令策略层位置 | `gate_hook.py:160-201`，`tool_name == "terminal"` 时先于 gate 判定 |
| 容器内 `ROVEAGENT_COMMAND_POLICY` | **空**（未设置） |
| `command_policy_enabled()` 语义 | 空 ⇒ **False** ⇒ 非只读命令**只记录不阻断** |

### 13.3 风险面（实测工具集）

```
ceo      -> ['safe','memory','business']
devops   -> ['terminal','todo']        ← 含 terminal + process
marketing-> ['safe','memory','business']
```

`devops`（CTO persona 的 employee key）**确实暴露 terminal 与 process**，
且该 persona 持有 `admin:process` 权限，因此 gate 的权限检查会通过。
组合起来：一次审批之后，CTO Agent 可以执行非只读的 shell 命令，
而当前配置**不会阻断**它（只写日志）。

### 13.4 决策与边界

**本轮不擅自把 `ROVEAGENT_COMMAND_POLICY` 设为 `enforce`。** 理由：

1. 默认值是**刻意的**（`command_policy.py:182-191` 的注释写明：
   启用强制属于安全模型变更，需显式同意）；
2. 开启后 `devops` 的非只读运维命令会全部被拒，可能打断自愈闭环 ——
   这是一个需要老板/运维确认的产品决策，不是安全默认值能替它做的；
3. 本环境的所有权与运维方式只有用户能确认。

**本轮交付的是取证与可执行的开启方式**，把"要不要开"变成一个
有证据的决策，而不是一个没人知道的默认值：

```bash
# 在 docker/deploy.env 中（注意：还必须同时加进 docker-compose.yml 的白名单，
# 否则不会进容器 —— Phase 15 §18.2 的教训）
ROVEAGENT_COMMAND_POLICY=enforce
```

**UNVERIFIED：未实测"开启 enforce 后一条非只读命令确实被拒"。**
上表证明的是"当前配置下不阻断"（读取环境变量与默认值语义），
不是"开启后一定阻断" —— 后者需要一次容器重启与一次真实工具调用。

---

## 14. 本轮修复清单

| # | 文件 | 改动 | 负向对照 / 证据 |
|---|---|---|---|
| 1 | `src/lib/dashboard-metrics.ts`（新） | KPI 真实计算，无依据返回 null | 注入旧常数 → 9 例变红 |
| 2 | `src/app/api/dashboard/route.ts` | 接上真实计算，去掉写死数字 | 源码契约 + 真实服务 20/20 |
| 3 | `src/components/rove/insight-card.tsx` | delta 三态，null 显示 `—` | 同上 |
| 4 | `messages/{en,zh,es}.json` | `dashboard.noComparison` | — |
| 5 | `src/lib/entitlements.ts`（新） | 判定表 + fail-closed + 缓存 | 注入"永远放行" → 7 例变红 |
| 6 | `src/lib/subscription-plans.ts`（新） | 套餐 id / 试用期单一事实源 | 与迁移 SQL 交叉断言 |
| 7 | `scripts/migrate-subscriptions-seed.sql`（新） | 4 套餐 + 存量回填 + entitlement | 真实库执行两次（幂等） |
| 8 | `src/lib/migration.ts` | 3 个新迁移入链 | 既有迁移守卫测试 |
| 9 | `src/lib/tenant.ts` | 门禁唯一插入点（显式清单） | phase8 8 例由红转绿 |
| 10 | `src/lib/api-helpers.ts` | 保留 402 语义 | `_verify_phase16_core` |
| 11 | `src/lib/mutation-guard.ts` | 402 不再被吞成 401 | 同上（这正是它抓出来的） |
| 12 | `src/lib/auth.ts` | `createTrialSubscriptionRow` | L3 真实注册 |
| 13 | `src/app/api/auth/signup/route.ts` | 建订阅 + 建 settings 行 | L3 真实注册 |
| 14 | `src/app/api/store/menu/route.ts` | 不再回落 "Store"；缺 settings → 409 | L3 真实菜单 |
| 15 | `src/lib/email/eligibility.ts`（新） | UI/worker 同一判定 + 真实 SMTP 验证 | 32 例 |
| 16 | `src/lib/email/smtp-presets.ts`（新） | 端口按服务商要求（Outlook 587） | 32 例 |
| 17 | `src/lib/email/unsubscribe.ts`（新） | 令牌 / 链接 / 头 / 页脚 / 批量预取 | 真实 SMTP 抓包 |
| 18 | `src/lib/email/outgoing.ts` | 退订过滤 + 头 + 端口语义 | 同上 |
| 19 | `scripts/migrate-email-compliance.sql`（新） | 退订表 + 任务列 | 真实库执行 |
| 20 | `scripts/migrate-email-account-verification.sql`（新） | 验证证据列 | 真实库执行 + 列名实测 |
| 21 | `src/app/api/email/unsubscribe/route.ts`（新） | 公开退订入口（GET/POST） | 公开路径断言 |
| 22 | `src/app/[locale]/unsubscribe/page.tsx`（新） | 给人点的退订页 | `next build` 通过 |
| 23 | `src/app/[locale]/settings/page.tsx` | 端口默认来自预设；导入修正 | 32 例 |
| 24 | `src/app/api/settings/email-accounts/route.ts` | 保存时真连 SMTP，失败不落库 | 32 例 |
| 25 | `src/app/api/marketing/send/route.ts` | 同一判定 + 退订令牌 + 批次上限 | 32 例 |
| 26 | `src/app/api/store/orders/route.ts` | 新单通知 + 同 key 冲突检测 | L3 端到端 |
| 27 | `src/app/[locale]/store/page.tsx` | 客户端补 `Idempotency-Key` | L3 端到端 |
| 28 | `src/app/[locale]/business/page.tsx` | 二维码 URL 补 locale 前缀 | — |
| 29 | `src/app/api/auth/invite/route.ts` | tenant claim + redirect + invite_url | 源码契约 |
| 30 | `src/lib/rbac.ts` | manager 加 `marketing:send` | — |
| 31 | `src/lib/app-origin.ts`（新） | 对外 origin 单一解析口 | — |
| 32 | `roveagent/api/capability_router.py` | 社交发布措辞更正 | 容器内实测 15 个工具无发布能力 |
| 33 | `docker-compose.yml` | web 镜像 → `phase16` | 容器 healthy |
| 34 | 3 个新测试文件 + 2 个新取证脚本 | 见下 | — |
| 35 | `scripts/migrate-subscriptions-seed.sql` | 加一条**有界的**孤儿订阅 GC（`where not exists (tenants)`） | 真实库：`tenant_subscriptions` 11 → **1**；跑两次结果不变 |
| 36 | `scripts/_cleanup_test_residue.mts` | 命名特征补 `Phase16 `（我的脚本最初用了未登记的名字，清理计划里看不到它） | 清理后 **1 tenant / 1 business / 0 计划外**，种子完好 |
| 37 | `tests/migration-column-coverage.test.ts` | 识别"幂等数据种子"；删除语句改为**白名单 + 有界性**双重约束 | 注入无界删除 → **9 例中 3 例变红** |

### 14.1 本轮新增的测试与取证脚本

| 文件 | 用例 | 负向对照 |
|---|---|---|
| `tests/dashboard-no-fabrication.test.ts` | 24 | 注入旧常数 → **9 例变红** |
| `tests/subscription-entitlements.test.ts` | 44 | 注入"永远放行" → **7 例变红** |
| `tests/email-compliance.test.ts` | 32 | 真实 SMTP 抓包 + 未传头时不出现头 |
| `scripts/_verify_dashboard_no_fabrication.mts` | 20 断言 | 阳性对照（有数据必须算出真实值） |
| `scripts/_verify_phase16_core.mts` | 24 断言 | 内部写不受门禁影响的反面对照 |
| `scripts/_verify_dashboard_kpi_basis.mts` | 只读取证 | 探针阴阳性对照 |
| `scripts/_apply_sql_migration.mts` | 迁移执行 + 效果核验 | 同一文件跑两次验幂等 |

**本轮四个新文件合计 +117 个 TS 用例**（见 §16.2 的准确分解）。

---

## 15. 回归结果

| 套件 | 基线 | 本轮 | 结果 |
|---|---|---|---|
| Python | 815 OK（4 skip） | **815 OK（skipped=4）** | 一致（`capability_router.py` 改动无影响） |
| TypeScript | 725（724/1/0） | 见 §16 | — |
| `pnpm validate` | exit 0 | 见 §16 | — |
| `next build` | — | **exit 0**（全部路由编译通过） | — |
| 容器 | phase13 healthy | **phase16 healthy** | — |
| 端到端旅程 | 30/30（Phase 15） | 见 §16 | — |

### 15.1 `next build` 抓到一个 `tsc` 抓不到的缺陷

新增的退订页初版写成 `return new NextResponse(html)`。
`npx tsc --noEmit` **通过**，而 `pnpm next build` 失败：

```
Type error: Type 'typeof import("/app/src/app/[locale]/unsubscribe/page")'
does not satisfy the constraint 'AppPageConfig<"/[locale]/unsubscribe">'.
  Types of property 'default' are incompatible.
  Type 'Promise<NextResponse<unknown>>' is not assignable to type 'ReactNode | Promise<ReactNode>'.
```

即：**页面组件的返回类型只有 `next build` 会检查。**
这与 Phase 15 §13 记录的"构建期 `next build` 会跑全项目 tsc"是同一类事实的延伸 ——
本轮补充的教训是：**`AppPageConfig` 约束只在 build 时生效**，
因此新增 / 改页面后必须跑一次 `next build`，`pnpm validate` 不覆盖它。

### 15.2 既有两个守卫抓住了我（记录，这是它们该做的事）

| 守卫 | 抓到什么 | 处置 |
|---|---|---|
| `tests/migration-column-coverage.test.ts` | `migrate-subscriptions-seed.sql` 只做 `insert`，不匹配它认识的四种 DDL 模式 ⇒ 判为"空文件充数" | **收紧**而非放宽：识别 `insert` 的同时要求 `on conflict ... do nothing` **且** 不含 `delete`/`truncate`；并新增一条"数据种子不得含删除语句" |
| `tests/api-rbac-contract.test.ts` | 新公开路由 `POST /api/email/unsubscribe` 未登记为例外 | 显式登记并写明理由：**要求登录才能退订等于没有退订** |

### 15.3 一次我自己失败的负向对照（记录）

对上面第一条守卫做负向对照时，我用 PowerShell 的 `-replace` 剥掉种子的
`on conflict`，结果**测试仍然全绿**。看着像"守卫无效"，实际是**我的注入没生效**
（PowerShell 替换在管道/编码上没匹配到）。

改用 Node 注入后：`on conflict` 出现次数 **5 → 0**，守卫 **8 例中 1 例变红**，
还原后逐字节一致。

**教训**：负向对照本身也可能失败。看到"注入后仍然全绿"时，
第一件要查的是**注入是否真的生效**，而不是先怀疑守卫 ——
否则会把"无效守卫"与"无效注入"搞反（这正是本项目记录过的
`git grep --cached` 位置错误那类错误的同构形态）。

---

## 16. 回归数值（本轮最终）

| 项 | 值 | 命令 |
|---|---|---|
| Python | **815 OK（skipped=4）** | `python scripts/run-python-tests.py` |
| `pnpm next build` | **exit 0** | `pnpm next build` |
| `_verify_phase16_core.mts` | **25/25** | 真实服务 + 真实库 |
| `_verify_dashboard_no_fabrication.mts` | **20/20** | 真实服务 + 真实库 |
| `_verify_e2e_journey.mts` | **30/30** | 真实服务（等限流窗口后） |
| 容器 | `roveframe/web:phase16` **healthy** | `docker compose ps` |
| `pnpm validate` | **exit 1 —— 唯一失败项属于另一个代理的在制品**（见 §20） | — |

### 16.1 `pnpm validate` 的唯一失败项不是本轮的

最后一次全量运行：**870 用例 / 868 pass / 1 skip / 1 fail**。

```
✖ every exported write method uses the central guard or an exact verified boundary exception
  actual: [ 'POST /api/site/reservations' ]
```

`/api/site/reservations` 是**另一个代理**本轮新增的路由（见 §20），
它没有走中央 mutation 守卫、也没有在 `EXCEPTIONS` 里登记。
**这是那条守卫在与对方的新代码发生关系，与本轮改动无关。**

我没有替对方修：那需要改他们的路由，或替他们做一个安全决策
（"这条写入该如何鉴权"），而我不掌握那部分的设计意图。
按项目规矩如实记录，不覆盖、不代改。

### 16.2 本轮的 TypeScript 用例增量

**725 → 868（+143）。** 本轮四个新文件的实际用例数：

| 文件 | 用例 |
|---|---|
| `tests/dashboard-no-fabrication.test.ts` | 24 |
| `tests/subscription-entitlements.test.ts` | 44 |
| `tests/email-compliance.test.ts` | 32 |
| `tests/store-order-idempotency.test.ts` | 14 |
| `tests/migration-column-coverage.test.ts`（收紧 + 2 条新守卫） | +3 |
| `tests/api-rbac-contract.test.ts`（登记 1 条例外） | 0 |
| **本轮小计** | **+117** |

其余增量来自另一个代理新增的测试文件。

### 16.3 端到端旅程：30/30

`scripts/_verify_e2e_journey.mts`（Phase 15 的 30 项断言，同一脚本、同一镜像）：

```
端到端结果: 30/30 项通过
```

过程中的两次失败都已定位，**不是产品缺陷**：

| 现象 | 根因 | 判定 |
|---|---|---|
| 第一次：工具调用为空、正文 0、审计 +0 | 上游模型间歇性失败（`roveagent` 日志报 auxiliary provider `payment / credit error`） | 换 Phase 15 的 `_verify_newtenant_error.mts` 取得正文 1208 字符 ⇒ AI 通路可用；重跑即恢复（工具 `["read_orders","read_sales"]`、审计 +2） |
| 第二次：登录 HTTP 429 | **我自己**连跑 4 个取证脚本，共用同一 `x-forwarded-for` 测试 IP，把每 IP 10 次/15min 的限流桶打满 | 与 Phase 15 §7.2 同类；等窗口后重跑即 30/30，**未放宽任何断言** |

### 16.4 观察到一次、未能复现（按口径记为观察，不是通过）

第一次重跑旅程时出现的"空回复"符合"AI 完全不可用"的表象，而本轮改过鉴权层，
因此必须排除是自己的改动。判定步骤（没有靠推断）：

| 步 | 命令 | 结果 |
|---|---|---|
| 1 | `docker compose logs roveagent` | auxiliary provider `payment / credit error`、`Nous Portal not configured` |
| 2 | `scripts/_verify_newtenant_error.mts` | **正文 1208 字符**，无 error 事件 ⇒ 通路正常 |
| 3 | 重跑 `_verify_e2e_journey.mts` | 工具调用正常、审计 +2 |

结论：**观察到一次间歇性空回复，未能复现，成因指向上游 provider**。
不记为通过，也不记为回归。




---

## 17. 未完成 / UNVERIFIED 汇总

| 项 | 状态 |
|---|---|
| Stripe 自动订阅（第二阶段） | **未做** —— 需真实凭据才能到 L3 |
| 扫码即付（先付后吃） | **未做** —— 需真实 Stripe 凭据 |
| 发送改入队（逐人 LLM 生成搬进 worker） | **未做** —— 已加上限与如实回报 |
| 邀请的 L3（被邀请人通过 `resolveUserByToken`） | **未取得** —— 需平台侧邮件服务 |
| 任务 7 审批路径统一（reviews / channels） | **未做** —— 决策已写，改造未做 |
| 任务 8 延迟尾部 89 s 归因 | **未取证** —— p50/p90/p99 对比 UNVERIFIED |
| 引导向导三语化 + 工作区归属 | **未做** —— 未删除（无分析不删） |
| `noPlatformProviderError` 三语 | **未做** |
| `ROVEAGENT_COMMAND_POLICY=enforce` 实测 | **未做** —— 决策与开启方式已给 |
| TS 用例基线 726 vs 实测 725 | **未查明** |
| 凭据轮换 | **未做** —— 只能由用户在控制台执行（见 §18） |
| 测试残留清理 | **已执行**：`_cleanup_test_residue.mts --apply` 删除 649 行 / 11 次外键顺序失败（脚本按设计重试）。收尾 **1 tenant / 1 business / 0 计划外**，种子完好（products 10 / customers 10 / orders 43）。**残留：`auth.users` 测试账号**（脚本只处理 public schema，与 Phase 15 相同） |

---

## 18. 凭据轮换（提醒一次，不再重复追问）

任务书列出的那批凭据（Supabase service_role、JWT Secret、数据库密码、
Cloudflare token、R2 S3 密钥、LLM key）在本轮对话中**再次被完整贴出**
（用户回答 DDL 凭据问题时粘贴了包含这些值的历史记录）。因此：

- 这些凭据的暴露面**没有减小**；
- 轮换只能在各自控制台完成，**只有用户能做**；
- 本轮为执行迁移使用了数据库密码，**未写入任何文件**（仅进程环境变量）。

建议顺序：数据库密码 → Supabase service_role/JWT Secret → R2 → Cloudflare → LLM key。

---

## 19. 一句话

Phase 15 证明了系统能跑；本轮证明了**它不再对商家说假话**，
并且平台第一次有了"没交钱就不能继续用"的能力。

但收入通路仍未闭合：自动扣费没有做，群发的发送侧仍在 HTTP 请求里串行生成，
邀请的端到端验证缺一个真实收件箱。

**代码增加不是验收标准。** 本轮能拿出的真实运行能力增加是：
零数据账户看到 `—` 而不是编造的增长、被停用的商户真的写不进去（且拿到 402 而不是 401）、
新商家的顾客菜单上是真店名、每一封群发邮件都带可用的退订入口、
同一张订单不会被重复下、被邀请人的 JWT 里终于有 `tenant_id`。

---

## 20. 并发写入事件（本轮实际发生，未提交）

任务书 §4 与 Phase 15 §6 都写明："同一仓库可能同时有别的代理在改；
发现非自己的改动不要直接覆盖，先弄清来源；建议同一时刻只有一个代理写这个仓库。"

**本轮这件事真的发生了，而且对方在我工作期间持续写入。**

### 20.1 观测

| 时间 | 文件 | 判断 |
|---|---|---|
| 会话中途 | `AGENTS.md` | **被对方改写**（系统提示更新后，新内容出现"顾客端 PWA 点餐商城"等措辞） |
| 21:34 | `src/lib/auth-guard.ts`、`src/lib/migration.ts` | 这两个文件**我刚改过**，2–4 分钟后被对方再次写入 |
| 21:35 | `src/components/layout/sidebar.tsx`、`app-shell.tsx` | 对方在加导航入口 |
| 21:35–21:38 | `src/app/[locale]/{site,website}/`、`src/lib/{site,public-site}.ts`、`src/app/api/{site,website}/`、`docker-compose.selfhosted.yml`、`install.sh`、`scripts/migrate-public-sites.sql`、`tests/selfhosted-deploy.test.ts`、`docs/current/{SelfHosted_Deploy_And_Merchant_Site_Plan,Phase18_PWA_Delivery_Workforce_Upgrade_Plan}.md` | 对方的**并行工作**（自托管部署 + 商家站点 + PWA） |

### 20.2 处置（按项目规矩，没有覆盖）

1. **核对我的改动是否被覆盖** —— 逐项确认，全部仍在：

   | 检查 | 结果 |
   |---|---|
   | `MIGRATION_FILES` 含我的 3 个迁移 | OK（且对方的 `migrate-public-sites.sql` 排在后面） |
   | `/api/email/unsubscribe` 在 `PUBLIC_API_PREFIXES` | OK |
   | `getTenantContext` 内的 `assertWriteEntitlement` + `safePathname` | OK |
   | 10 处共享文件中的关键标识（`noBasisLabel` / `SMTP_PRESETS` / `Idempotency-Key` / `storeUrlFor` / `idempotency_fingerprint` / `subscriptionRequiredResponse` / `loadUnsubscribedAddresses` / `marketing:send` / 社交发布措辞） | **10/10 OK** |

2. **没有执行 `git commit`。** 理由：我的改动与对方**未提交的在制品**混在同一批文件里
   （例如 `sidebar.tsx`、`app-shell.tsx`、`docker/deploy.env.example`、
   `src/app/api/upload/route.ts`、`insight-card.tsx` 的 diff 里都有对方的行）。
   此刻提交会把对方未完成的工作一起固化；`git add -A` 更是会把它们的
   十几个新文件全部带入。这与"不要覆盖别人的改动"是同一条纪律的两面。

3. **把我的产出复制到仓库之外**（不受对方写入影响）：

   ```
   %TEMP%\phase16-evidence-20260918-213901\
     ├── 21 个 Phase 16 新文件（含本报告）
     └── phase16-tracked-changes.patch（1757 行，已跟踪文件的我的改动）
   ```

### 20.3 建议

**先确认哪一个代理继续写这个仓库。** 在那之前：
本轮的改动已在工作树里、已验证、未提交；对方可以继续；
但**任何一方执行 `git commit -a` / `git add -A` 都会把另一方的在制品一起提交**。

如果需要，我可以只提交我这一批文件（显式列名 `git add <file>...`），
但共享文件的 diff 里仍会带上对方的行 —— 因此更稳妥的顺序是：
**让对方先提交或先停下，再由我提交。**


Phase 15 证明了系统能跑；本轮证明了**它不再对商家说假话**，
并且平台第一次有了"没交钱就不能继续用"的能力。

但收入通路仍未闭合：自动扣费没有做，群发的发送侧仍在 HTTP 请求里串行生成，
邀请的端到端验证缺一个真实收件箱。

**代码增加不是验收标准。** 本轮能拿出的真实运行能力增加是：
零数据账户看到 `—` 而不是编造的增长、被停用的商户真的写不进去（且拿到 402 而不是 401）、
新商家的顾客菜单上是真店名、每一封群发邮件都带可用的退订入口、
同一张订单不会被重复下、被邀请人的 JWT 里终于有 `tenant_id`。

---

## 21. 运行记录（可复现命令）

```bash
# 基线
git log --oneline -3 && git status --porcelain
python scripts/run-python-tests.py 2>&1 | tail -5      # 815 OK (skipped=4)
pnpm validate 2>&1 | tail -5                            # exit 0
pnpm next build                                         # exit 0（AppPageConfig 约束在这）
docker compose --env-file docker/deploy.env ps          # 双 healthy
curl -s http://127.0.0.1:5055/api/health

# 迁移（DDL 直连；幂等，跑两次结果不变）
$env:PGPASSWORD='…'; $env:PGHOST='db.<ref>.supabase.co'; $env:PGUSER='postgres'
npx tsx scripts/_apply_sql_migration.mts scripts/migrate-subscriptions-seed.sql
npx tsx scripts/_apply_sql_migration.mts scripts/migrate-email-compliance.sql
npx tsx scripts/_apply_sql_migration.mts scripts/migrate-email-account-verification.sql

# 取证
npx tsx scripts/_verify_dashboard_kpi_basis.mts        # 只读取证
npx tsx scripts/_verify_dashboard_no_fabrication.mts   # 20/20
npx tsx scripts/_verify_phase16_core.mts               # 任务 2/3/5

# 清理（两次取证脚本各建了一条链）
npx tsx scripts/_cleanup_test_residue.mts --apply
```
