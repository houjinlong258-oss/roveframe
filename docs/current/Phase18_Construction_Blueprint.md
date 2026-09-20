# Phase 18 施工图 —— 三端 PWA、外卖、员工端、员工关怀

状态：**待评审，未动代码。**
上游：`docs/current/Phase18_PWA_Delivery_Workforce_Upgrade_Plan.md`（方案层）
本文档：施工层。每一阶段给出 DDL / 接口契约 / 文件清单 / 测试与负向对照 / 验收命令。

---

## 0. 本图纸依据的已核实契约（不是推断）

| 契约 | 出处 | 内容 |
|---|---|---|
| 登录 | `src/app/api/auth/login/route.ts:26-68` | `POST {email,password}` → `{access_token,user_id,tenant_id,business_id,role}` + `Set-Cookie`；**与角色无关** |
| 权限判定 | `src/lib/rbac.ts:40-47` | 精确匹配 → `entity:*` 通配。`orders:read` **不**蕴含 `orders:write` |
| 现有角色 | `src/lib/rbac.ts:3-37` | `RoleKey = 'owner'\|'manager'\|'staff'`；staff 仅 `orders:read / customers:read / agent:use / healing:write` |
| 租户上下文 | `src/lib/tenant.ts:52,89,101` | `getTenantContext(request)` / `requirePermission(ctx, action)` / `requireBusinessContext(ctx)` |
| 变更守卫 | `src/lib/mutation-guard.ts:140` | `protectBusinessMutation({permission,action,entity}, handler)`：鉴权 + 作用域 + 权限 + 审计。**不经过 EnterpriseToolGate**，因此自定义 action 名不会被拒 |
| 点餐定位 | `src/lib/storefront.ts:16-31` | `store_qr_codes.public_token` 且 `is_active`；无 token ⇒ 404 |
| 通知出件 | `src/lib/notifications/outbox.ts:25` | `enqueueNotification({tenantId,businessId,userId,channel,notificationType,title,content,priority,idempotencyKey})`，同时写 `notifications` + `notification_outbox` |
| 推送通道 | `src/lib/notifications/outbox.ts:6` | `'web_push'\|'email'\|'whatsapp'\|'telegram'\|'sms'` |
| 调度器 | `src/lib/scheduler.ts:474,567` | `runScheduledJobsInner()` 已含任务轮询 / 邮件队列 / 通知派发 / 按租户循环；`startScheduler(60_000)` |
| 订单通道 | schema.ts `orders.channel` | `varchar(20) not null default 'dine_in'`，`'delivery'` 是合法值，**无需 DDL** |
| 订单无配送列 | schema.ts `orders` | 只有 items/total/channel/status/source/table_no/external_id |
| 员工表 | schema.ts `staff` | id/tenant_id/business_id/name/role/photo_url/is_active/created_at。**无 user_id** |
| PWA | `src/app/manifest.ts`、`src/app/sw.ts`、`public/icons/*` | 单份通用 manifest，`scope:'/'` |

---

## 1. 全局设计决定（需要你确认的三条）

### 1.1 顾客端 PWA 的 scope 必须按商家分，不能共用 `/store`

`scope` 决定"装到桌面的是哪个 App"。若两个商家的 manifest 都是 `scope:/store`，
顾客装了 A 再装 B 会**覆盖同一个图标**——因为浏览器认为它们是同一个 App。

因此顾客端下单页从 `/{locale}/store` 迁到 `/{locale}/site/{slug}/order`：

| 项 | 值 |
|---|---|
| manifest URL | `/{locale}/site/{slug}/manifest.webmanifest` |
| `id` | `/{locale}/site/{slug}/` ← 这个字段才是区分 App 的关键 |
| `scope` | `/{locale}/site/{slug}/` |
| `start_url` | `/{locale}/site/{slug}/order` |
| 名称 / 图标 / 主题色 | 商家名称 / 商家 logo / 商家主色 |

`/{locale}/store` **保留**（老二维码、老链接不能失效），但它不再挂 manifest。
两者渲染同一个组件，所以行为完全一致。

### 1.2 员工端不放开 `orders:write`，改为新增窄权限

把 `orders:write` 给 staff，等于"任何员工可改任意订单金额"。
图纸新增 5 个窄权限，`ROLE_PERMISSIONS` 精确授予：

| 新增权限 | 用途 | owner | manager | staff |
|---|---|---|---|---|
| `workforce:self` | 自己的班次/考勤/打卡/关怀资源 | `*` | ✓ | ✓ |
| `workforce:manage` | 员工档案、排班、考勤复核 | `*` | ✓ | ✗ |
| `workforce:care` | 建立关怀记录与待办 | `*` | ✓ | ✗ |
| `delivery:claim` | 认领/推进外卖单（**只能动自己的单**） | `*` | ✓ | ✓ |
| `delivery:dispatch` | 指派给他人、取消、改配送费 | `*` | ✓ | ✗ |
| `reservations:confirm` | 确认预约、排桌 | `*` | ✓ | ✓ |
| `products:read` | 看菜单（**新授予 staff**） | `*` | ✓ | ✓ |

`staff` 最终权限集：`orders:read, customers:read, agent:use, healing:write, products:read,
workforce:self, delivery:claim, reservations:confirm`。仍然看不到营业额、客户、营销、财务、设置。

**越权第二道锁**：`delivery:claim` 只是"允许接单"。接口还必须断言
`delivery_orders.rider_staff_id` 等于**会话解析出的** staff id —— 客户端传的 id 一律忽略。

### 1.3 关怀数据不靠角色授权，靠行级规则

按方案的边界表，**老板也不能读关怀记录内容**。这不是权限矩阵能表达的
（owner 有 `*`），必须在接口与查询里写死：

```
可见性 = (author_user_id = 我) OR (staff.user_id = 我)
```

并且每次读取写 `audit_events`。这条会有一个专门的负向对照测试：
**以 owner 身份调用读取他人关怀记录的接口，必须 403。**

---

## 2. 迁移清单（5 个文件，每个只负责一件事）

| 顺序 | 文件 | 阶段 | 内容 |
|---|---|---|---|
| 1 | `scripts/migrate-staff-identity.sql` | P18-1 | `staff.user_id` + 唯一索引 |
| 2 | `scripts/migrate-delivery-orders.sql` | P18-4 | `delivery_orders` |
| 3 | `scripts/migrate-workforce.sql` | P18-6 | `staff` 档案列 + `staff_shifts` + `staff_attendance` |
| 4 | `scripts/migrate-workforce-care.sql` | P18-7 | `staff_care_notes` + `staff_care_tasks` |
| 5 | `scripts/migrate-customer-accounts.sql` | P18-9 | `customer_accounts` + `customer_sessions` + `customer_addresses` |

全部追加进 `src/lib/migration.ts` 的 `MIGRATION_FILES`。
已存在的守卫会自动生效：`tests/migration-column-coverage.test.ts` 要求
"清单内每个文件都真的创建/修改了对象"，`scripts/verify-migrations.mjs` 要求
schema.ts 的表名都被覆盖。**因此每加一张表，必须同时在 `schema.ts` 加 pgTable。**

### 2.1 `migrate-staff-identity.sql`

```sql
alter table public.staff add column if not exists user_id varchar(36);
create unique index if not exists staff_user_id_key
  on public.staff (user_id) where user_id is not null;
create index if not exists staff_user_idx on public.staff (tenant_id, business_id, user_id);
```

不带外键：`users` 行可能先于员工档案删除，外键会把"删账号"变成不可操作。
关联有效性由 `GET /api/staff/me` 在读取时判定（查不到即 409，见 §4.3）。

### 2.2 `migrate-delivery-orders.sql`

```sql
create table if not exists public.delivery_orders (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null,
  business_id varchar(36) not null,
  order_id varchar(36) not null,
  customer_account_id varchar(36),
  recipient_name varchar(80) not null,
  recipient_phone varchar(40) not null,
  address_line varchar(240) not null,
  address_note varchar(240),
  lat numeric(9,6),
  lng numeric(9,6),
  fee numeric(10,2) not null default 0,
  min_order_amount numeric(10,2) not null default 0,
  promised_at timestamptz,
  rider_staff_id varchar(36),
  rider_status varchar(20) not null default 'pending',
  claimed_at timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  cancelled_reason varchar(200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists delivery_orders_order_key on public.delivery_orders (order_id);
create index if not exists delivery_orders_queue_idx
  on public.delivery_orders (tenant_id, business_id, rider_status, created_at);
create index if not exists delivery_orders_rider_idx
  on public.delivery_orders (rider_staff_id, rider_status);
```

`rider_status ∈ pending | claimed | picked_up | delivered | cancelled`。
约束用**代码侧白名单**而不是 check 约束：改状态机不应要求 DDL。
（与仓库既有做法一致，例如 `reservations.status`。）

### 2.3 `migrate-workforce.sql`

```sql
alter table public.staff add column if not exists phone varchar(40);
alter table public.staff add column if not exists email varchar(255);
alter table public.staff add column if not exists position varchar(60);
alter table public.staff add column if not exists employment_type varchar(20) not null default 'full_time';
alter table public.staff add column if not exists hourly_rate numeric(10,2);
alter table public.staff add column if not exists hired_at date;
alter table public.staff add column if not exists birthday date;
alter table public.staff add column if not exists emergency_contact varchar(160);
alter table public.staff add column if not exists status varchar(20) not null default 'active';

create table if not exists public.staff_shifts (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null,
  business_id varchar(36) not null,
  staff_id varchar(36) not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  role varchar(60),
  note varchar(240),
  created_by varchar(36),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists staff_shifts_window_idx
  on public.staff_shifts (tenant_id, business_id, starts_at);

create table if not exists public.staff_attendance (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null,
  business_id varchar(36) not null,
  staff_id varchar(36) not null,
  shift_id varchar(36),
  clock_in_at timestamptz not null default now(),
  clock_out_at timestamptz,
  clock_in_source varchar(20) not null default 'staff_pwa',
  note varchar(240),
  created_at timestamptz not null default now()
);
create index if not exists staff_attendance_staff_idx
  on public.staff_attendance (tenant_id, business_id, staff_id, clock_in_at desc);
-- 一个员工同一时刻只能有一条未结束的考勤
create unique index if not exists staff_attendance_open_key
  on public.staff_attendance (staff_id) where clock_out_at is null;
```

那条部分唯一索引是**并发安全的关键**：员工连点两次打卡，第二次会撞索引而不是
产生两条进行中的记录。这比"先查再插"可靠（先查再插在并发下必然漏）。

### 2.4 `migrate-workforce-care.sql`

```sql
create table if not exists public.staff_care_notes (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null,
  business_id varchar(36) not null,
  staff_id varchar(36) not null,
  author_user_id varchar(36) not null,
  kind varchar(30) not null default 'one_on_one',
  content text not null,
  visibility varchar(20) not null default 'private',
  created_at timestamptz not null default now()
);
create index if not exists staff_care_notes_subject_idx
  on public.staff_care_notes (tenant_id, business_id, staff_id, created_at desc);

create table if not exists public.staff_care_tasks (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null,
  business_id varchar(36) not null,
  staff_id varchar(36) not null,
  kind varchar(40) not null,
  title varchar(160) not null,
  detail varchar(600),
  due_at timestamptz,
  status varchar(20) not null default 'open',
  suggested_by varchar(20) not null default 'agent',
  signal_key varchar(120),
  decided_by varchar(36),
  decided_at timestamptz,
  decision_note varchar(240),
  created_at timestamptz not null default now()
);
create unique index if not exists staff_care_tasks_signal_key
  on public.staff_care_tasks (tenant_id, business_id, signal_key)
  where signal_key is not null;
create index if not exists staff_care_tasks_open_idx
  on public.staff_care_tasks (tenant_id, business_id, status, due_at);
```

`signal_key` 上的唯一索引保证**同一天同一个信号只产生一条待办**——
调度器每分钟跑一次，没有它老板会被同一个生日提醒刷屏。

### 2.5 `migrate-customer-accounts.sql`

```sql
create table if not exists public.customer_accounts (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null,
  business_id varchar(36) not null,
  email varchar(255),
  phone varchar(40),
  password_hash text not null,
  password_salt varchar(64) not null,
  display_name varchar(80),
  locale varchar(5) not null default 'en',
  device_id varchar(64),
  marketing_opt_in boolean not null default false,
  status varchar(20) not null default 'active',
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);
-- 账号按商家隔离：同一邮箱在不同商家是两个账号
create unique index if not exists customer_accounts_email_key
  on public.customer_accounts (tenant_id, business_id, lower(email)) where email is not null;
create unique index if not exists customer_accounts_phone_key
  on public.customer_accounts (tenant_id, business_id, phone) where phone is not null;

create table if not exists public.customer_sessions (
  id varchar(36) primary key default gen_random_uuid(),
  account_id varchar(36) not null,
  token_hash varchar(64) not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent varchar(240),
  created_at timestamptz not null default now()
);
create unique index if not exists customer_sessions_token_key on public.customer_sessions (token_hash);
create index if not exists customer_sessions_account_idx on public.customer_sessions (account_id, expires_at);

create table if not exists public.customer_addresses (
  id varchar(36) primary key default gen_random_uuid(),
  account_id varchar(36) not null,
  tenant_id varchar(36) not null,
  business_id varchar(36) not null,
  label varchar(40),
  recipient_name varchar(80) not null,
  recipient_phone varchar(40) not null,
  address_line varchar(240) not null,
  address_note varchar(240),
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists customer_addresses_account_idx on public.customer_addresses (account_id);
```

**口令哈希用 Node 内置 `crypto.scrypt`**（零新增依赖），存储 `salt` + `hash`，
校验用 `timingSafeEqual`。不用 GoTrue：顾客与商家混进同一个用户池是这个项目
已经踩过的坑（AGENTS.md 陷阱 8）。

**会话 token**：32 字节随机 → 只存 `sha256(token)`。数据库被读走也无法直接冒充登录。

---

## 3. 权限矩阵变更（`src/lib/rbac.ts`）

只改一处：`ROLE_PERMISSIONS`。

```ts
manager: [ ...现有..., 'workforce:self','workforce:manage','workforce:care',
           'delivery:claim','delivery:dispatch','reservations:confirm' ],
staff:   ['orders:read','customers:read','agent:use','healing:write',
           'products:read','workforce:self','delivery:claim','reservations:confirm'],
```

`owner` 保持 `['*']`。

**测试**：`tests/rbac-workforce.test.ts` 断言
`hasPermission('staff','orders:write') === false`、
`hasPermission('staff','delivery:dispatch') === false`、
`hasPermission('staff','workforce:manage') === false`。
**负向对照**：把 `'orders:write'` 加进 staff 列表，第一条必须变红。

---

## 4. 逐阶段施工

### P18-1 员工身份与登录分离

**交付物**

| 文件 | 动作 |
|---|---|
| `scripts/migrate-staff-identity.sql` | 新增 |
| `src/lib/migration.ts` | 追加到 `MIGRATION_FILES` |
| `src/storage/database/shared/schema.ts` | `staff` 加 `user_id` |
| `src/lib/workforce.ts` | 新增：`resolveStaffForUser(userId)` |
| `src/app/[locale]/staff/login/page.tsx` | 新增 |
| `src/app/[locale]/staff/layout.tsx` | 新增（员工端外壳，不复用 AppShell） |
| `src/app/[locale]/staff/today/page.tsx` | 新增（先放占位，P18-3 填内容） |
| `src/components/layout/app-shell.tsx` | 加 `/staff` 旁路 |
| `src/lib/workforce-redirect.ts` | 新增：登录后按 `role` 决定落地页 |

**接口**

| 方法 | 路径 | 鉴权 | 请求 | 响应 | 错误 |
|---|---|---|---|---|---|
| POST | `/api/auth/login` | 公开（**复用现有**） | `{email,password}` | 现有结构 | 现有 |
| GET | `/api/staff/me` | 会话 | — | `{staff:{id,name,position}, business:{id,name}, role}` | 401 无会话；403 无 `workforce:self`；409 会话有效但无关联员工档案 |

409 是**必须**的：账号存在、员工档案不存在，是最常见的配置错误。
返回 200 + 空对象会让员工端显示一片空白而无从排查。

**验收命令**

```
curl -c c.txt -X POST localhost:5000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"<staff>","password":"..."}'
curl -b c.txt localhost:5000/api/staff/me
```
负向对照：把 `staff.user_id` 置空，`/api/staff/me` 必须 409 而不是 200。

---

### P18-2 三端 PWA manifest

**交付物**

| 文件 | 动作 |
|---|---|
| `src/app/[locale]/site/[slug]/manifest.webmanifest/route.ts` | 新增（顾客端，动态） |
| `src/app/[locale]/staff/manifest.webmanifest/route.ts` | 新增（员工端） |
| `src/app/manifest.ts` | 修改：`shortcuts` 指向新路径 |
| `src/components/site/pwa-head.tsx` | 新增：按端注入 `<link rel="manifest">` |

Next 16 里 `route.ts` 放在带点号的目录名下会生成对应路径；若该写法在本版本
不成立，退路是 `/{locale}/site/[slug]/manifest/route.ts`（路径多一段，其它不变）。
**这一点必须在写代码前用最小样例实测**，不要假设。

**`id` 字段是区分 App 的关键**，不是 `scope`。两个商家的 `id` 不同，
顾客可以同时安装两家的 App。

**验收**：`curl .../en/site/<slug>/manifest.webmanifest | jq .id` 等于
`/en/site/<slug>/`；未发布的商家返回 404。

---

### P18-3 员工端 PWA 骨架

**交付物**

| 文件 | 动作 |
|---|---|
| `src/components/staff/staff-shell.tsx` | 新增（底部导航，移动优先） |
| `src/app/[locale]/staff/today/page.tsx` | 填充：今日班次 + 打卡按钮 + 待办计数 |
| `src/app/[locale]/staff/clock/page.tsx` | 新增 |
| `src/app/[locale]/staff/shifts/page.tsx` | 新增（我的排班） |
| `src/app/[locale]/staff/me/page.tsx` | 新增（我的资料 / 隐私开关 / 关怀资源） |
| `src/hooks/use-staff-session.ts` | 新增 |

**接口**

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/staff/shifts?from&to` | `workforce:self` | 只返回 `staff_id = 我` |
| GET | `/api/staff/attendance?from&to` | `workforce:self` | 同上 |
| POST | `/api/staff/attendance` | `workforce:self` | 无参。服务端判定方向：有未结束记录 → 签退；否则签到 |

打卡方向由**服务端**判定，客户端不传 `direction`。理由是客户端判定会在
两个标签页同时打开时产生错误状态。

**验收**：连点两次打卡 → 第一次 200 写入，第二次 200 更新 `clock_out_at`，
`staff_attendance` 里始终只有一行。**负向对照**：去掉那条部分唯一索引，
并发两次签到会产生两行未结束记录（用两个并行 curl 可复现）。

---

### P18-4 外卖系统

**交付物**

| 文件 | 动作 |
|---|---|
| `scripts/migrate-delivery-orders.sql` | 新增 |
| `src/storage/database/shared/schema.ts` | 加 `deliveryOrders` |
| `src/lib/delivery.ts` | 新增：配送规则读取、费用与起送价校验、状态机 |
| `src/components/store/storefront.tsx` | **从 `src/app/[locale]/store/page.tsx` 抽出**，加 `mode` 支持 |
| `src/app/[locale]/store/page.tsx` | 改为薄壳，渲染上面的组件（老链接与老二维码不变） |
| `src/app/[locale]/site/[slug]/order/page.tsx` | 新增：按 slug 解析 token 后渲染同一组件 |
| `src/app/api/store/delivery-orders/route.ts` | 新增（公开，token 定租户） |
| `src/app/api/settings/route.ts` | 加 `delivery` 分组读写 |

**配送规则**（存 `settings.delivery` jsonb，不新建表）：

```json
{
  "enabled": true,
  "minOrderAmount": 20,
  "fee": 3,
  "freeDeliveryAbove": 50,
  "radiusKm": 5,
  "prepMinutes": 35,
  "hours": "11:00-21:30"
}
```

**接口契约**：`POST /api/store/delivery-orders`

```
请求 { token, items:[{product_id,qty}], recipient_name, recipient_phone,
       address_line, address_note?, customer_address_id? }
响应 201 { order_id, order_no, subtotal, fee, total, promised_at }
错误 400 字段校验失败 / 起送价不足
     404 token 无效
     409 商家未开启外卖
```

价格、配送费、起送价**全部服务端计算**；客户端传 `fee`/`total` 一律忽略。

**回归守卫（因为这是一次重构）**：`tests/storefront-parity.test.ts` 断言
`/{locale}/store` 与 `/{locale}/site/{slug}/order` 在相同 token 下渲染出的
商品与价格集合完全一致。**负向对照**：把抽取后的组件漏掉小费计算，该测试必须变红。

---

### P18-5 员工派单与提醒

**交付物**

| 文件 | 动作 |
|---|---|
| `src/app/[locale]/staff/deliveries/page.tsx` | 新增 |
| `src/app/[locale]/staff/reservations/page.tsx` | 新增 |
| `src/app/api/staff/deliveries/route.ts` | GET 待接 + 我的 |
| `src/app/api/staff/deliveries/claim/route.ts` | POST 原子接单 |
| `src/app/api/staff/deliveries/[id]/status/route.ts` | POST picked_up / delivered |
| `src/app/api/staff/reservations/route.ts` | GET 当日 |
| `src/app/api/staff/reservations/[id]/confirm/route.ts` | POST 确认 |
| `src/lib/staff-notify.ts` | 新增：`notifyStaff(...)` 包装 `enqueueNotification` |
| `src/app/api/store/delivery-orders/route.ts` | 落单后通知在岗员工 |

**原子接单（这一段是整份图纸里最容易写错的地方）**

```sql
update delivery_orders
   set rider_staff_id = $staffId, rider_status = 'claimed',
       claimed_at = now(), updated_at = now()
 where id = $id and tenant_id = $tenantId and business_id = $businessId
   and rider_status = 'pending'
returning id;
```

影响行数 0 ⇒ 已被别人接走，返回 **409 `already_claimed`**。
不要先 `select` 再 `update`：那中间的窗口就是两个人接同一单的原因。

**验收（并发实测）**：两个并行 `curl` 同一单，断言恰好一个 200、一个 409，
且库里 `rider_staff_id` 只有一个值。

---

### P18-6 员工管理与考勤（老板端）

**交付物**

| 文件 | 动作 |
|---|---|
| `scripts/migrate-workforce.sql` | 新增 |
| `src/app/[locale]/team/page.tsx` | 新增（员工列表 / 排班 / 考勤 三 Tab） |
| `src/app/api/team/route.ts` | GET/POST/PATCH 员工档案 |
| `src/app/api/team/shifts/route.ts` | GET/POST/DELETE 排班 |
| `src/app/api/team/attendance/route.ts` | GET 考勤（复核）+ PATCH 补卡（有审计） |
| `src/app/api/team/invite/route.ts` | POST 邀请员工开通账号 |
| `src/components/layout/sidebar.tsx` | 加入口 |

**邀请必须先修既有缺陷**：现在 `invite_url` 返回 `null`、不放 `app_metadata.tenant_id`、
`redirectTo` 指向不存在的 `/auth/callback`，被邀请人**永远无法登录**。
不修这个，员工账号根本开不出来。修复范围单独列出，不在本阶段夹带。

**验收**：老板建排班 → 员工端能查到；员工打卡 → 老板端考勤页看得到；
**越权对照**：经理调 `GET /api/team/attendance` 返回自己门店以外的数据必须为空
（按 tenant_id + business_id 双重过滤）。

---

### P18-7 员工关怀信号与提醒

**交付物**

| 文件 | 动作 |
|---|---|
| `scripts/migrate-workforce-care.sql` | 新增 |
| `src/lib/workforce-signals.ts` | 新增：6 类信号的纯函数计算 |
| `src/lib/scheduler.ts` | 在 `runScheduledJobsInner()` 的租户循环内加一次调用 |
| `src/app/api/team/care/signals/route.ts` | GET 待办 |
| `src/app/api/team/care/tasks/[id]/route.ts` | POST 采纳/忽略（走审批） |
| `src/app/api/team/care/notes/route.ts` | GET/POST 关怀记录（行级可见性） |
| `src/app/[locale]/team/care/page.tsx` | 新增 |
| `src/app/api/staff/care-resources/route.ts` | GET 员工端资源转介 |

**6 类信号与阈值**（阈值存 `settings.wellbeing`，可关）

| signal_key 形态 | 触发 | 产出 |
|---|---|---|
| `birthday:<staff_id>:<YYYY>` | 生日在未来 7 天内 | 待办：是否给予福利 |
| `rest:<staff_id>:<YYYY-WW>` | 连续上班 ≥6 天 | 待办：安排休息 |
| `overtime:<staff_id>:<YYYY-WW>` | 本周工时 > 48h | 待办：核查排班 |
| `long_shift:<attendance_id>` | 单班 > 10h | 待办：疑似违反当地劳动法 |
| `anniversary:<staff_id>:<YYYY>` | 入职满 1/3/5 年 | 待办：是否需要奖励 |
| `missing_punch:<staff_id>:<YYYY-MM-DD>` | 有排班无打卡 | 待办：与本人确认 |

`signal_key` 唯一索引保证同一天同一信号只产生一条待办（幂等）。
调度器每分钟跑，**必须**幂等。

**硬约束写进代码**：
- 只做资源转介（EAP 热线、自助材料）。**不诊断、不存健康信息、不评分。**
- 不做后台定位、不做屏幕/操作监控。
- 考勤异常**不产生**任何自动扣薪或处分动作，只产生待核对项。

**必测的负向对照**：以 owner 身份 `GET /api/team/care/notes?staff_id=<他人>`
→ 必须 403，即使 owner 有 `*`。这条是方案 §8.3 表格的代码化，
没有它那张表就是一句声明。

---

### P18-8 隐私能力

| 交付物 | 说明 |
|---|---|
| `GET /api/staff/export` | 员工导出自己的档案 + 考勤 + 关怀记录（JSON） |
| `POST /api/staff/erasure-request` | 删除申请 → 待办 → 审批 → 保留期后清理 |
| `settings.wellbeing.retentionMonths` | 保留期，默认 24 |
| `src/lib/scheduler.ts` | 到期清理任务（写审计） |
| `tests/workforce-privacy.test.ts` | 5 条断言 |

**默认值**：关怀提醒（对老板）默认**开**；个性化数据收集（生日、通讯录）默认**关**，
由员工本人在 `/staff/me` 开启。默认收集是这条线最容易越界的地方。

---

### P18-9 顾客账号（最后做，风险最高）

**交付物**

| 文件 | 动作 |
|---|---|
| `scripts/migrate-customer-accounts.sql` | 新增 |
| `src/lib/customer-auth.ts` | scrypt 哈希/校验 + 会话签发/校验 |
| `src/app/api/customer/auth/{register,login,logout}/route.ts` | 新增 |
| `src/app/api/customer/orders/route.ts` | 订单历史 |
| `src/app/api/customer/addresses/route.ts` | 地址簿 |
| `src/app/api/store/delivery-orders/route.ts` | 落单时可选绑定账号 |
| `src/components/store/customer-auth-sheet.tsx` | 新增 |

**隔离要求（逐条可测）**

| 要求 | 测试 |
|---|---|
| cookie 名不与商家会话冲突 | 断言 cookie 名为 `roveframe_customer_session` |
| 顾客 token 不能被 `/api/auth/me` 接受 | 拿顾客 cookie 调 `/api/auth/me` 必须 401 |
| 商家会话不能被顾客接口接受 | 反向同理 |
| 顾客只能看自己的订单 | 用 A 的 cookie 查 B 的 order_id 必须 404 |
| 游客下单仍然可用 | 无 cookie 调 `/api/store/delivery-orders` 必须 200/201 |

第四条的 **404 而不是 403** 是刻意的：403 会泄漏"这个订单存在"。

---

## 5. 不做的事（明确排除，避免范围蔓延）

| 不做 | 原因 |
|---|---|
| 后台定位 / 屏幕监控 / 效率评分 | 与 §8.3 边界冲突 |
| 考勤自动扣薪、自动处分 | 系统只呈现事实 |
| 心理诊断、健康数据存储 | 只做资源转介 |
| 员工端可见营业额 / 客户 / 财务 | 现有 RBAC 本就不给，不放开 |
| 短信 OTP 注册 | 需要短信通道（成本 + 合规），另立项目 |
| 骑手路线规划 / 地图 | 需要地图服务，本期只存经纬度与地址文本 |
| 把顾客并入 GoTrue | 复用会重演 AGENTS.md 陷阱 8 |

---

## 6. 施工顺序与并行性

```
P18-1 ──┬─→ P18-2
        ├─→ P18-3 ──┐
        └─→ P18-6 ──┼─→ P18-7 ──→ P18-8
P18-4 ──────────────┴─→ P18-5
P18-9（独立，最后）
```

- P18-1 是所有员工功能的前置，必须最先。
- P18-4（外卖）与员工体系无依赖，可并行。
- P18-5 同时依赖 P18-3 与 P18-4。
- P18-9 独立且风险最高，放最后；即使失败也不影响前面全部功能。

---

## 7. 每阶段完成的定义（四层口径）

一个阶段只有同时满足下面四层才算完成。这是项目既有口径，不因新功能放宽：

| 层 | 含义 | 证据形式 |
|---|---|---|
| 1 代码存在 | 文件、类型、导出齐全 | `pnpm ts-check` 退出 0 |
| 2 测试通过 | 单测 + 守卫测试 | `pnpm test` 全绿 |
| 3 真实调用 | 起服务，真 HTTP 打一遍 | curl 输出（含 4xx 负向） |
| 4 迁移落地 | DDL 应用到真实库并核验列 | 直查 `information_schema` 输出 |

每个守卫都必须做**负向对照**：把修复回退，断言必须变红。没有负向对照的
"通过"结论一律不算证据。
