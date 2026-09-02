-- RoveFrame 增量迁移（本文件对应「社交通讯 / 小费 / 长期记忆」等功能已写的代码）
-- 在 Supabase SQL Editor 一次性执行即可（幂等，可重复运行）
--
-- 注意：gen_random_uuid() 需要 pgcrypto 扩展（Supabase 默认已启用）。

-- 1) 定时任务状态（scheduler 水位线，key/value）
create table if not exists public.cron_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 2) 员工（小费归因，顾客下单后选择服务员工）
create table if not exists public.staff (
  id varchar(36) primary key default gen_random_uuid(),
  name varchar(128) not null,
  role varchar(50),
  photo_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 3) 企业长期记忆（AI COO 沉淀的经营事实/经验）
create table if not exists public.business_memories (
  id varchar(36) primary key default gen_random_uuid(),
  content text not null,
  created_at timestamptz not null default now()
);

-- 4) 订单增加小费相关列
alter table public.orders
  add column if not exists tip numeric(10,2) not null default 0,
  add column if not exists tip_percent numeric(5,2),
  add column if not exists tip_staff_id varchar(36);

-- ============ P0 多租户 ============
create table if not exists public.tenants (
  id varchar(36) primary key default gen_random_uuid(),
  name varchar(128) not null,
  slug varchar(64) unique not null,
  plan varchar(20) not null default 'free',
  status varchar(20) not null default 'active',
  created_at timestamptz not null default now()
);
create table if not exists public.businesses (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null references tenants(id),
  name varchar(128) not null,
  industry varchar(30) not null default 'restaurant',
  location varchar(128),
  language varchar(8) not null default 'en',
  currency varchar(8) not null default 'USD',
  brand_style jsonb not null default '{}',
  schema_config jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create table if not exists public.users (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null references tenants(id),
  business_id varchar(36) references businesses(id),
  email varchar(255) not null,
  name varchar(128),
  created_at timestamptz not null default now()
);
create table if not exists public.roles (
  id varchar(36) primary key default gen_random_uuid(),
  name varchar(30) not null,
  permissions jsonb not null default '[]'
);
create table if not exists public.user_roles (
  user_id varchar(36) not null references users(id),
  role_id varchar(36) not null references roles(id),
  primary key (user_id, role_id)
);
create table if not exists public.audit_logs (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null,
  actor_id varchar(36),
  action varchar(40) not null,
  entity varchar(40) not null,
  entity_id varchar(36),
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

-- 默认租户 + 默认企业（回填现有单租户数据）
insert into public.tenants (id, name, slug, plan)
values ('00000000-0000-0000-0000-000000000000', 'Default', 'default', 'free')
on conflict (id) do nothing;
insert into public.businesses (id, tenant_id, name, industry)
values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'Sichuan House 四川人家', 'restaurant')
on conflict (id) do nothing;

-- 现有业务表加 tenant_id
alter table public.products add column if not exists tenant_id varchar(36);
alter table public.orders add column if not exists tenant_id varchar(36);
alter table public.customers add column if not exists tenant_id varchar(36);
alter table public.reviews add column if not exists tenant_id varchar(36);
alter table public.staff add column if not exists tenant_id varchar(36);
alter table public.business_memories add column if not exists tenant_id varchar(36);
alter table public.reservations add column if not exists tenant_id varchar(36);
alter table public.inventory_items add column if not exists tenant_id varchar(36);
alter table public.store_qr_codes add column if not exists tenant_id varchar(36);
alter table public.chat_sessions add column if not exists tenant_id varchar(36);
alter table public.chat_messages add column if not exists tenant_id varchar(36);
alter table public.knowledge_docs add column if not exists tenant_id varchar(36);
alter table public.doc_chunks add column if not exists tenant_id varchar(36);
alter table public.marketing_contents add column if not exists tenant_id varchar(36);
alter table public.emails add column if not exists tenant_id varchar(36);
alter table public.email_accounts add column if not exists tenant_id varchar(36);
alter table public.email_send_tasks add column if not exists tenant_id varchar(36);
alter table public.alerts add column if not exists tenant_id varchar(36);
alter table public.integration_configs add column if not exists tenant_id varchar(36);
alter table public.model_configs add column if not exists tenant_id varchar(36);
alter table public.settings add column if not exists tenant_id varchar(36);

-- 回填现有数据到默认租户
update public.products set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.orders set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.customers set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.reviews set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.staff set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.business_memories set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.reservations set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.inventory_items set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.store_qr_codes set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.chat_sessions set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.chat_messages set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.knowledge_docs set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.doc_chunks set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.marketing_contents set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.emails set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.email_accounts set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.email_send_tasks set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.alerts set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.integration_configs set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.model_configs set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.settings set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;