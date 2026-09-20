-- ---------------------------------------------------------------------------
-- Phase 18 / P18-4 —— 外卖配送（PWA 顾客端下单 + 员工端派单）
--
-- 设计要点：
--
-- 1. **不改 `orders` 的语义**。`orders.channel` 已经是 varchar(20) 且允许
--    'delivery'，无需 DDL；配送地址/电话/配送费/骑手放进本表。
--    这样经营报表、仪表盘的既有聚合一行都不用改。
--
-- 2. **本表只承载"配送"这件事**，金额与商品仍在 `orders` 里，
--    以 `order_id` 一对一。金额不复制：复制就会漂移。
--
-- 3. `rider_status` 的取值用代码白名单而不是 check 约束 ——
--    状态机演进不应要求 DDL。与仓库既有做法一致（如 reservations.status）。
--
-- 4. 外键 `on delete cascade`：`/api/settings/wipe` 会清空业务数据，
--    没有 cascade 会让"清空数据"直接失败。有 cascade，清空订单时配送单一起走干净。
--
-- 5. `settings.delivery` 是 settings 单行 jsonb 的新增列（配送规则：起送价、
--    配送费、免配送门槛、备餐分钟数）。规则是配置不是事实数据，不建表。
-- ---------------------------------------------------------------------------

alter table public.settings
  add column if not exists delivery jsonb not null default '{}'::jsonb;

create table if not exists public.delivery_orders (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null,
  business_id varchar(36) not null,
  order_id varchar(36) not null references public.orders(id) on delete cascade,

  recipient_name varchar(80) not null,
  recipient_phone varchar(40) not null,
  address_line varchar(240) not null,
  address_note varchar(240),

  -- 配送费与起送价是**下单那一刻的快照**：商家事后改规则不应改写历史订单的金额。
  fee numeric(10,2) not null default 0,
  min_order_amount numeric(10,2) not null default 0,

  promised_at timestamptz,

  rider_staff_id varchar(36),
  -- pending | claimed | picked_up | delivered | cancelled
  rider_status varchar(20) not null default 'pending',
  claimed_at timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  cancelled_reason varchar(200),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 一张订单只能有一条配送记录
create unique index if not exists delivery_orders_order_key
  on public.delivery_orders (order_id);

-- 待接单队列：`pending` 的查询走这条
create index if not exists delivery_orders_queue_idx
  on public.delivery_orders (tenant_id, business_id, rider_status, created_at);

-- 员工端"我的配送中"
create index if not exists delivery_orders_rider_idx
  on public.delivery_orders (rider_staff_id, rider_status);

-- ---------------------------------------------------------------------------
-- 外卖的下单幂等。
--
-- 既有的 `orders_qr_idempotency_idx` 带 `where source = 'qr'`
-- （scripts/migrate-business-tables.sql:496-498），外卖用 source='web' 落不进去 ——
-- 没有这条索引，并发同 key 双插会**落两张单**，而路由的 23505 竞态兜底
-- 永远不会触发（它等的就是这个冲突）。
-- ---------------------------------------------------------------------------
drop index if exists public.orders_web_idempotency_idx;
create unique index orders_web_idempotency_idx
  on public.orders (tenant_id, business_id, external_id)
  where source = 'web' and external_id is not null;
