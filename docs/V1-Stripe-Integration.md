# RoveFrame V1 · Stripe 集成设计

> 起草：2026-09-03 (Mavis, release-manager)
> 目的：V1 商业化闭环（老板付钱 → 我们收钱 → 账户激活）
> 状态：**待决策 + 待实施**

---

## 0. 一句话目标

让海外华人餐厅老板在「设置 → 订阅」页点 **Subscribe Now**,跳到 Stripe Checkout 付月费/年费,回到「设置 → 订阅」看到 Pro 激活,所有 P0/P1 功能立即可用。

---

## 1. 现状盘点

### 1.1 已就位

- `tenants.plan varchar(20) default 'free'` —— 已经有 plan 字段
- `tenants.status varchar(20) default 'active'` —— 已经有 status 字段
- `api/auth/signup` 自动建 tenant + business + owner user,plan='free'
- `lib/crypto` AES-256-GCM 加密 —— Stripe API Key 加密存储基础设施已有
- `lib/api-helpers` json / jsonError / getErrorMessage
- 8 commit P0-S2 完整版代码,所有 typecheck 0 error

### 1.2 完全没接

- **Stripe SDK**(`stripe` npm 包)—— `package.json` 里没装
- **任何 `/api/billing/*` 端点**
- **Webhook 验签逻辑**
- **Stripe Customer 关联 tenants**
- **设置页「订阅」Tab**
- **价格 / Product / Price** 配置

### 1.3 已有的相关模型

- `tenants.id` (`00000000-...-0000` 默认租户 ID)
- `lib/auth.ts: createTenantRow({ name })` —— 自动 slug

---

## 2. 4 个必须由你拍的决策

### 决策 1:价格模型

| 模式 | 你的文档草稿 | 我的建议 |
|---|---|---|
| **单一价格** | $999/year | ❌ 太高,SaaS 早期价格要低 |
| **按月 / 按年** | (未列) | ✅ V1 起步:**$49/月 + $499/年(节省 17%)** |
| **试用 14 天** | (未列) | ✅ 强烈推荐,转化率 +20% |
| **enterprise tier** | (未列) | V2 再加,大连锁才 $299+/月 |

**我的提案**:**$49/月(默认) + $499/年(节省 17%) + 14 天试用**。Stripe 后期可加 Pro/Enterprise tier。

### 决策 2:Checkout 模式

| 模式 | 体验 | 实施 |
|---|---|---|
| **Hosted Checkout**(Stripe 托管页) | 用户跳 stripe.com → 付 → 跳回 | ✅ 推荐:V1 简单,PCI 合规 Stripe 全管 |
| **Embedded Checkout**(嵌入我站) | 用户在我站付,不跳走 | 需多前端代码,PCI SAQ-A |
| **Custom UI** | 完全自定义卡号表单 | ❌ PCI DSS 自承担,V1 不做 |

**我的提案**:**Hosted Checkout**。`stripe.checkout.sessions.create({ mode: 'subscription', ... })`。

### 决策 3:Webhook 安全 + 端点

| 项 | 设计 |
|---|---|
| 端点 | `POST /api/billing/webhook` |
| 验签 | `stripe.webhooks.constructEvent(rawBody, sig, webhookSecret)` |
| 关键事件 | `customer.subscription.{created,updated,deleted}` + `invoice.payment_succeeded` + `invoice.payment_failed` |
| Tenant 映射 | 用 `subscription.metadata.tenant_id`(Checkout 创建时塞入) |
| **不带 tenant 过滤** | 这是平台表(tenants)操作,不是业务表;走 `plainUpdate` / `plainInsert` |
| 幂等 | `tenants.subscription_id` UNIQUE,重复 webhook upsert 不重复 |
| 重试 | Stripe 自动重试 3 天,我们只接受事件一次(Subscription ID UNIQUE 兜底) |

### 决策 4:tenants 表新字段

```sql
alter table public.tenants
  add column if not exists stripe_customer_id varchar(64) unique,
  add column if not exists subscription_id varchar(64) unique,
  add column if not exists subscription_status varchar(20) default 'free',
  add column if not exists current_period_end timestamptz,
  add column if not exists cancel_at timestamptz;
```

- `stripe_customer_id` —— 第一次 Checkout 时建,后续所有订阅挂在上面
- `subscription_id` —— 当前活跃订阅 ID
- `subscription_status` —— `trialing | active | past_due | canceled | incomplete`
- `current_period_end` —— 当前计费周期结束(用于显示「X 天后到期」)
- `cancel_at` —— 用户点了 cancel 但周期未结束(用 Stripe 的「期末取消」语义)

---

## 3. 实施步骤(明天 5 commit 计划)

### C-S1: 数据库 + 加密基建(1h)

- `scripts/migrate-billing.sql` 新建,只加上面 5 个 ALTER(可空,idempotent)
- `lib/stripe.ts` 新建:
  - `getStripeClient()` 读 `STRIPE_SECRET_KEY` 加密 env → 解密 → `new Stripe()`
  - `STRIPE_WEBHOOK_SECRET` 单独 env(签名验签用)
  - `getPriceIds()` 返回 `{ monthly: 'price_xxx', yearly: 'price_yyy' }` 从 env

### C-S2: Checkout 创建端点(2h)

- `api/billing/checkout/route.ts` `POST`:
  - 接收 `{ plan: 'monthly' | 'yearly' }`
  - `getTenantContext(request)` 拿 tenantId
  - 查 `tenants.stripe_customer_id`,没就 `stripe.customers.create`
  - `stripe.checkout.sessions.create({ customer, mode: 'subscription', line_items: [priceId], metadata: { tenant_id } })`
  - 返回 `{ url }`,前端 `window.location = url`
- 不带 tenant 过滤(平台层,plainUpdate)

### C-S3: Webhook 端点(3h)

- `api/billing/webhook/route.ts` `POST`:
  - 关键:**必须读 `request.text()` raw body,不能用 `request.json()`**(Stripe 签名验签需要 raw body)
  - `stripe.webhooks.constructEvent(rawBody, sigHeader, webhookSecret)`
  - 关键事件处理:
    - `customer.subscription.created/updated` → upsert tenants(`subscription_id` UNIQUE 兜底)
    - `customer.subscription.deleted` → plan='free', status='canceled'
    - `invoice.payment_succeeded` → 续期,`current_period_end` 更新
    - `invoice.payment_failed` → `subscription_status='past_due'`,发邮件提醒(已有 `lib/email`)
  - 写 `audit_logs`(P0 平台层,plainInsert)

### C-S4: 订阅查询端点(1h)

- `api/billing/subscription/route.ts` `GET`:
  - 拿 tenantId,查 `tenants` 的 5 个 billing 字段
  - 返回 `{ plan, status, currentPeriodEnd, cancelAt, manageUrl }`
  - `manageUrl` = Stripe Billing Portal session URL(让用户自己管订阅 / 改卡 / 取消)

### C-S5: 前端订阅页(2h)

- `src/app/[locale]/settings/billing/page.tsx` 新建
- 顶部:当前 plan + status + 续期时间
- 中部:升级按钮(monthly / yearly),跳 Checkout
- 底部:Manage Subscription 按钮(跳 Stripe Billing Portal)
- i18n 加 `settings.billing.*` 命名空间(14 keys × 3 语种)

### C-S6: 注册流程试用户钩(可选,1h)

- `api/auth/signup` 完成后:
  - **试用 14 天**:`tenants.subscription_status='trialing', current_period_end=now+14d`
  - Stripe 不实际建 customer,等用户点订阅才建
- 这步让新用户立即有 Pro 体验(AI COO / Review AI / 营销),14 天后才卡住

### 总估时

- **最低 5 commit** = 9-10 小时
- **含 C-S6** = 11-12 小时
- 可分 2 天:C-S1-S3(第 1 天 6h),C-S4-S6(第 2 天 4h)

---

## 4. 风险与缓解

### 风险 1:Webhook 漏接导致订阅状态不同步

**缓解**:
- Stripe 失败 24h 后会 retry,我们的 `tenants.subscription_id` UNIQUE 兜底幂等
- 加 `cron_state` 表记录「上次 webhook 处理时间」,UI 上「管理订阅」按钮可强制 sync

### 风险 2:价格改了老订阅怎么办

**缓解**:
- Stripe Product / Price ID 不变(只改 display name / amount),老订阅不受影响
- 我们代码里读 `STRIPE_PRICE_MONTHLY` env 变量,改 env 即可

### 风险 3:多 tenant 订阅交叉

**缓解**:
- 每次 `stripe.checkout.sessions.create` 都 `metadata.tenant_id = current_tenant`
- Webhook 处理时读 metadata,**不**从 user_id 推断 tenant
- `tenants.stripe_customer_id` UNIQUE,一个 customer 只能绑一个 tenant

### 风险 4:本地开发收不到 webhook

**缓解**:
- 用 `stripe listen --forward-to http://localhost:5000/api/billing/webhook`(Stripe CLI)
- 或在 dev 跳过 webhook 验签(SKIP_WEBHOOK_VERIFY=true env),但生产必须验

### 风险 5:PCI 合规

**缓解**:
- Hosted Checkout = Stripe 全管 PCI,我们 0 责任 ✓
- **绝对不要**自己接卡号(不写 Custom UI)
- Webhook 端点不需要 PCI(Stripe 调)

### 风险 6:多币种

**缓解**:
- V1 **仅 USD**(目标市场海外)
- 设置页 `businesses.currency` 已有默认 USD,V1 不动
- V2 加 EUR / GBP / CNY(Stripe 支持)

---

## 5. 部署/配置依赖(必须由你做)

1. **注册 Stripe 账号**(https://dashboard.stripe.com/register)
2. **创建 Product**:`RoveFrame Pro`
3. **创建 2 个 Price**:
   - `RoveFrame Pro Monthly` = $49/月 recurring
   - `RoveFrame Pro Yearly` = $499/年 recurring
4. **记 Price ID**:`price_xxx_monthly` / `price_xxx_yearly`
5. **加 Webhook Endpoint**:
   - URL: `https://app.roveframe.com/api/billing/webhook`(等 Coze 平台 deploy 后才有)
   - 事件:`customer.subscription.created/updated/deleted` + `invoice.payment_succeeded/failed`
6. **记 Webhook Signing Secret**:`whsec_xxx`
7. **写 .env**(给我们):
   ```
   STRIPE_SECRET_KEY=sk_live_xxx(用 lib/crypto 加密存 settings 表,不要明文 env)
   STRIPE_WEBHOOK_SECRET=whsec_xxx
   STRIPE_PRICE_MONTHLY=price_xxx
   STRIPE_PRICE_YEARLY=price_xxx
   ```
8. **在 Stripe Dashboard 开启 Customer Portal**(用户管理订阅的页面)

---

## 6. 实施 commit 清单(预演)

明天开干时:
```
docs/V1-Stripe-Integration.md  ← 本文档,已 commit
scripts/migrate-billing.sql      ← C-S1,新文件
src/lib/stripe.ts                 ← C-S1,新文件
src/app/api/billing/checkout/...  ← C-S2
src/app/api/billing/webhook/...   ← C-S3
src/app/api/billing/subscription/ ← C-S4
src/app/app/[locale]/settings/billing/page.tsx  ← C-S5
src/app/api/auth/signup/route.ts  ← C-S6 改
src/messages/{en,zh,es}.json     ← C-S5 i18n
```

每个 commit 独立 typecheck 验证。

---

## 7. 验收清单(完成时跑)

- [ ] `pnpm ts-check` 0 error
- [ ] 本地 `stripe listen` 收测试事件 → webhook 处理成功
- [ ] Stripe CLI 跑 `stripe trigger customer.subscription.created` → tenants 表更新
- [ ] Stripe CLI 跑 `stripe trigger invoice.payment_succeeded` → current_period_end 更新
- [ ] UI 流程:点 Subscribe → 跳 Stripe → 付 → 跳回 → plan=Pro 显示
- [ ] 取消订阅流程:Manage → Stripe Portal → 取消 → 期末降级到 free
- [ ] 多 tenant 隔离:tenant A 订阅不影响 tenant B
- [ ] 14 天试用:新注册自动 trialing, 14 天后 plan=free

---

## 8. 不在本设计范围(明确 V1 不做)

- ❌ 多币种(只 USD)
- ❌ 优惠券 / referral code
- ❌ 发票 / billing portal 自定义
- ❌ Stripe Tax(自动收税)
- ❌ Stripe Connect(分账,留 V2)
- ❌ Enterprise tier 定价
- ❌ 年付/月付切换中途迁移

---

*本文档是 V1 Stripe 集成的"先分析后改造"产出。明天开工时按 §3 步骤 + §5 准备 6 个 env 即可。*
