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

-- 4) 订单增加小费相关列（业务表可能由 migrate-business-tables.sql 稍后创建）
do $$ begin
  if to_regclass('public.orders') is not null then
    alter table public.orders
      add column if not exists tip numeric(10,2) not null default 0,
      add column if not exists tip_percent numeric(5,2),
      add column if not exists tip_staff_id varchar(36);
  end if;
end $$;

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
  role varchar(20) not null default 'owner' check (role in ('owner', 'manager', 'staff')),
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

-- Agent 工具执行审计（只记录脱敏参数与结果摘要，不保存完整敏感 payload）
create table if not exists public.agent_actions (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null references tenants(id),
  business_id varchar(36) not null references businesses(id),
  user_id varchar(36),
  session_id varchar(128),
  turn_id varchar(128),
  tool_call_id varchar(128),
  agent varchar(64) not null default 'business-agent',
  tool varchar(128) not null,
  action varchar(128) not null,
  input jsonb,
  result_summary text,
  status varchar(24) not null,
  error_code varchar(64),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists agent_actions_tenant_business_idx
  on public.agent_actions (tenant_id, business_id, created_at desc);
create index if not exists agent_actions_session_idx
  on public.agent_actions (session_id, created_at desc);

-- Payments are separate from orders so deposits, refunds and reconciliation
-- retain an immutable provider lifecycle.
create table if not exists public.payments (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null references tenants(id),
  business_id varchar(36) not null references businesses(id),
  provider varchar(20) not null,
  external_id varchar(255), provider_payment_id varchar(255), amount numeric(14,3) not null, amount_minor bigint not null,
  currency varchar(3) not null default 'USD', status varchar(32) not null default 'pending',
  description varchar(200), reservation_id varchar(36), order_id varchar(36), checkout_url text,
  failure_reason text, refunded_amount_minor bigint not null default 0, reconciled_at timestamptz,
  created_by varchar(36), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.payments add column if not exists business_id varchar(36) references businesses(id);
alter table public.payments add column if not exists provider_payment_id varchar(255);
alter table public.payments add column if not exists refunded_amount_minor bigint not null default 0;
alter table public.payments add column if not exists reconciled_at timestamptz;
alter table public.payments alter column amount type numeric(14,3);
drop index if exists public.payments_provider_external_idx;
create unique index payments_provider_external_idx
  on public.payments (tenant_id, business_id, provider, external_id) where external_id is not null;
create index if not exists payments_tenant_status_idx on public.payments (tenant_id, business_id, status, created_at desc);
create unique index if not exists payments_provider_payment_idx
  on public.payments (tenant_id, business_id, provider, provider_payment_id) where provider_payment_id is not null;
create table if not exists public.payment_events (
  id varchar(36) primary key default gen_random_uuid(), tenant_id varchar(36) not null references tenants(id),
  business_id varchar(36) not null references businesses(id),
  provider varchar(20) not null, external_event_id varchar(255) not null, event_type varchar(100) not null,
  payload jsonb not null default '{}'::jsonb, processed_at timestamptz, last_error text,
  created_at timestamptz not null default now()
);
alter table public.payment_events add column if not exists business_id varchar(36) references businesses(id);
alter table public.payment_events add column if not exists processed_at timestamptz;
alter table public.payment_events add column if not exists last_error text;
drop index if exists public.payment_events_provider_event_idx;
create unique index payment_events_provider_event_idx
  on public.payment_events (tenant_id, business_id, provider, external_event_id);
create table if not exists public.integration_events (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null references tenants(id),
  business_id varchar(36) not null references businesses(id),
  provider varchar(30) not null, external_event_id varchar(255) not null,
  event_type varchar(100) not null, payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz, created_at timestamptz not null default now()
);
create unique index if not exists integration_events_provider_event_idx
  on public.integration_events (tenant_id, business_id, provider, external_event_id);
do $$ begin
  if to_regclass('public.emails') is not null then
    create unique index if not exists emails_mailbox_external_idx
      on public.emails (tenant_id, business_id, mailbox_id, external_id) where external_id is not null;
  end if;
end $$;

-- 默认租户 + 默认企业（回填现有单租户数据）
insert into public.tenants (id, name, slug, plan)
values ('00000000-0000-0000-0000-000000000000', 'Default', 'default', 'free')
on conflict (id) do nothing;
insert into public.businesses (id, tenant_id, name, industry)
values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'Sichuan House 四川人家', 'restaurant')
on conflict (id) do nothing;

-- 现有业务表加 tenant_id；不存在的表由 migrate-business-tables.sql 创建后再补列
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'products', 'orders', 'customers', 'reviews', 'staff', 'business_memories',
    'reservations', 'inventory_items', 'store_qr_codes', 'chat_sessions',
    'chat_messages', 'knowledge_docs', 'doc_chunks', 'marketing_contents',
    'emails', 'email_accounts', 'email_send_tasks', 'alerts',
    'integration_configs', 'model_configs', 'settings', 'payments',
    'payment_events', 'integration_events', 'agent_actions', 'agent_approvals', 'agent_tasks',
    'agent_task_runs', 'agent_events', 'notification_outbox', 'notifications',
    'push_subscriptions'
  ] loop
    if to_regclass(format('public.%I', table_name)) is not null then
      execute format('alter table public.%I add column if not exists tenant_id varchar(36)', table_name);
    end if;
  end loop;
end $$;

-- A customer retry must not create a second QR order for the same tenant.
do $$ begin
  if to_regclass('public.orders') is not null then
    alter table public.orders add column if not exists source varchar(20) not null default 'native';
    alter table public.orders add column if not exists external_id varchar(128);
  end if;
  if to_regclass('public.products') is not null then
    alter table public.products add column if not exists source varchar(20) not null default 'native';
    alter table public.products add column if not exists external_id varchar(128);
  end if;
  if to_regclass('public.customers') is not null then
    alter table public.customers add column if not exists source varchar(20) not null default 'native';
    alter table public.customers add column if not exists external_id varchar(128);
  end if;
end $$;

-- Every operational table is tenant + business scoped. During backfill, rows
-- are assigned automatically only when their tenant has exactly one business.
-- Multi-business legacy rows remain null and the migration fails closed below,
-- requiring an explicit operator mapping instead of guessing a business.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'products', 'orders', 'customers', 'reviews', 'staff', 'business_memories',
    'reservations', 'inventory_items', 'store_qr_codes', 'chat_sessions',
    'chat_messages', 'knowledge_docs', 'doc_chunks', 'marketing_contents',
    'emails', 'email_accounts', 'email_send_tasks', 'alerts',
    'integration_configs', 'model_configs', 'settings', 'payments',
    'payment_events', 'integration_events', 'agent_actions', 'agent_approvals', 'agent_tasks',
    'agent_task_runs', 'agent_events', 'notification_outbox', 'notifications',
    'push_subscriptions'
  ] loop
    if to_regclass(format('public.%I', table_name)) is not null then
      execute format('alter table public.%I add column if not exists business_id varchar(36) references public.businesses(id)', table_name);
      execute format(
        'update public.%I row set business_id = only_business.id from '
        '(select tenant_id, min(id) as id from public.businesses group by tenant_id having count(*) = 1) only_business '
        'where row.business_id is null and only_business.tenant_id = row.tenant_id',
        table_name
      );
    end if;
  end loop;
  if to_regclass('public.orders') is not null then
    drop index if exists public.orders_qr_idempotency_idx;
    create unique index orders_qr_idempotency_idx
      on public.orders (tenant_id, business_id, external_id)
      where source = 'qr' and external_id is not null;
    create index if not exists orders_tenant_business_created_idx on public.orders (tenant_id, business_id, created_at desc);
    create unique index if not exists orders_adapter_external_idx
      on public.orders (tenant_id, business_id, source, external_id);
  end if;
  if to_regclass('public.reservations') is not null then
    -- P0-6：预约权威应缴金额（checkout 服务端比对用；为空则拒绝预约支付模式）
    alter table public.reservations add column if not exists due_amount numeric(10,2);
  end if;
  if to_regclass('public.products') is not null then
    create index if not exists products_tenant_business_idx on public.products (tenant_id, business_id);
    create unique index if not exists products_adapter_external_idx
      on public.products (tenant_id, business_id, source, external_id);
  end if;
  if to_regclass('public.customers') is not null then
    create unique index if not exists customers_adapter_external_idx
      on public.customers (tenant_id, business_id, source, external_id);
  end if;
  if to_regclass('public.reviews') is not null then
    create index if not exists reviews_tenant_business_created_idx on public.reviews (tenant_id, business_id, created_at desc);
  end if;
  if to_regclass('public.customers') is not null then
    create index if not exists customers_tenant_business_idx on public.customers (tenant_id, business_id);
  end if;
  if to_regclass('public.inventory_items') is not null then
    create index if not exists inventory_tenant_business_idx on public.inventory_items (tenant_id, business_id);
  end if;
  if to_regclass('public.store_qr_codes') is not null then
    create index if not exists store_qr_codes_tenant_business_idx on public.store_qr_codes (tenant_id, business_id);
  end if;
  if to_regclass('public.business_memories') is not null then
    create index if not exists business_memories_tenant_business_idx on public.business_memories (tenant_id, business_id, created_at desc);
  end if;
  if to_regclass('public.chat_sessions') is not null then
    create index if not exists chat_sessions_tenant_business_idx on public.chat_sessions (tenant_id, business_id, updated_at desc);
  end if;
  if to_regclass('public.chat_messages') is not null then
    create index if not exists chat_messages_tenant_business_idx on public.chat_messages (tenant_id, business_id, created_at);
  end if;
  if to_regclass('public.alerts') is not null then
    create index if not exists alerts_tenant_business_idx on public.alerts (tenant_id, business_id, created_at desc);
  end if;
end $$;

-- Conversation ownership and bounded rolling summaries.
do $$
declare missing_user bigint;
begin
  if to_regclass('public.chat_sessions') is not null then
    alter table public.chat_sessions add column if not exists user_id varchar(36) references public.users(id);
    alter table public.chat_sessions add column if not exists summary text not null default '';
    alter table public.chat_sessions add column if not exists summarized_message_count integer not null default 0;
    update public.chat_sessions session_row
    set user_id = only_user.id
    from (
      select tenant_id, business_id, min(id) as id
      from public.users
      where business_id is not null
      group by tenant_id, business_id
      having count(*) = 1
    ) only_user
    where session_row.user_id is null
      and only_user.tenant_id = session_row.tenant_id
      and only_user.business_id = session_row.business_id;
    select count(*) into missing_user from public.chat_sessions where user_id is null;
    if missing_user > 0 then
      raise exception 'conversation user backfill required for chat_sessions.% rows', missing_user;
    end if;
    alter table public.chat_sessions alter column user_id set not null;
    create index if not exists chat_sessions_tenant_business_user_idx
      on public.chat_sessions (tenant_id, business_id, user_id, updated_at desc);
  end if;

  if to_regclass('public.chat_messages') is not null then
    alter table public.chat_messages add column if not exists user_id varchar(36) references public.users(id);
    update public.chat_messages message_row
    set user_id = session_row.user_id
    from public.chat_sessions session_row
    where message_row.user_id is null
      and session_row.id = message_row.session_id
      and session_row.tenant_id = message_row.tenant_id
      and session_row.business_id = message_row.business_id;
    select count(*) into missing_user from public.chat_messages where user_id is null;
    if missing_user > 0 then
      raise exception 'conversation user backfill required for chat_messages.% rows', missing_user;
    end if;
    alter table public.chat_messages alter column user_id set not null;
    create index if not exists chat_messages_tenant_business_user_idx
      on public.chat_messages (tenant_id, business_id, user_id, created_at);
  end if;
end $$;

-- 回填现有数据到默认租户；新环境中尚未创建的表跳过
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'products', 'orders', 'customers', 'reviews', 'staff', 'business_memories',
    'reservations', 'inventory_items', 'store_qr_codes', 'chat_sessions',
    'chat_messages', 'knowledge_docs', 'doc_chunks', 'marketing_contents',
    'emails', 'email_accounts', 'email_send_tasks', 'alerts',
    'integration_configs', 'model_configs', 'settings', 'payments',
    'payment_events', 'integration_events', 'agent_actions', 'agent_approvals', 'agent_tasks',
    'agent_task_runs', 'agent_events', 'notification_outbox', 'notifications',
    'push_subscriptions'
  ] loop
    if to_regclass(format('public.%I', table_name)) is not null then
      execute format('update public.%I set tenant_id = %L where tenant_id is null', table_name, '00000000-0000-0000-0000-000000000000');
    end if;
  end loop;
end $$;

-- Auth routes read/write users.role. Bring pre-existing installations into the
-- same shape as a new install before enforcing it.
alter table public.users add column if not exists role varchar(20);
update public.users set role = 'owner' where role is null or role not in ('owner', 'manager', 'staff');
alter table public.users alter column role set default 'owner';
alter table public.users alter column role set not null;
do $$ begin
  alter table public.users add constraint users_role_check check (role in ('owner', 'manager', 'staff'));
exception when duplicate_object or duplicate_table then null;
end $$;

-- Every operational row must be scoped after the safe single-business
-- backfill. Abort rather than silently assigning ambiguous multi-business data.
do $$
declare table_name text;
declare missing_business bigint;
begin
  foreach table_name in array array[
    'products', 'orders', 'customers', 'reviews', 'staff', 'business_memories',
    'reservations', 'inventory_items', 'store_qr_codes', 'chat_sessions',
    'chat_messages', 'knowledge_docs', 'doc_chunks', 'marketing_contents',
    'emails', 'email_accounts', 'email_send_tasks', 'alerts',
    'integration_configs', 'model_configs', 'settings', 'payments',
    'payment_events', 'integration_events', 'agent_actions', 'agent_approvals', 'agent_tasks',
    'agent_task_runs', 'agent_events', 'notification_outbox', 'notifications',
    'push_subscriptions'
  ] loop
    if to_regclass(format('public.%I', table_name)) is not null then
      execute format('select count(*) from public.%I where business_id is null', table_name) into missing_business;
      if missing_business > 0 then
        raise exception 'business scope backfill required for %.% rows', table_name, missing_business;
      end if;
      execute format('alter table public.%I alter column tenant_id set not null', table_name);
      execute format('alter table public.%I alter column business_id set not null', table_name);
      execute format('create index if not exists %I on public.%I (tenant_id)', table_name || '_tenant_id_idx', table_name);
      execute format('create index if not exists %I on public.%I (tenant_id, business_id)', table_name || '_tenant_business_idx', table_name);
    end if;
  end loop;
end $$;

-- Config provider names and table labels are only unique inside one tenant.
do $$ begin
  if to_regclass('public.store_qr_codes') is not null then
    alter table public.store_qr_codes add column if not exists public_token varchar(64);
    update public.store_qr_codes
    set public_token = encode(gen_random_bytes(24), 'hex')
    where public_token is null or public_token = '';
    alter table public.store_qr_codes alter column public_token set not null;
    alter table public.store_qr_codes drop constraint if exists store_qr_codes_table_no_key;
    alter table public.store_qr_codes drop constraint if exists store_qr_codes_tenant_table_no_key;
    begin
      alter table public.store_qr_codes add constraint store_qr_codes_tenant_business_table_no_key unique (tenant_id, business_id, table_no);
    exception when duplicate_object or duplicate_table then null;
    end;
    begin
      alter table public.store_qr_codes add constraint store_qr_codes_public_token_key unique (public_token);
    exception when duplicate_object or duplicate_table then null;
    end;
    create index if not exists store_qr_codes_public_token_idx on public.store_qr_codes (public_token) where is_active;
  end if;
end $$;

do $$ begin
  if to_regclass('public.model_configs') is not null then
    alter table public.model_configs drop constraint if exists model_configs_provider_key;
    drop index if exists public.model_configs_tenant_provider_key;
    drop index if exists public.model_configs_tenant_business_provider_key;
    create unique index model_configs_tenant_business_provider_key on public.model_configs (tenant_id, business_id, provider);
  end if;
  if to_regclass('public.integration_configs') is not null then
    alter table public.integration_configs drop constraint if exists integration_configs_provider_key;
    drop index if exists public.integration_configs_tenant_provider_key;
    create unique index integration_configs_tenant_business_provider_key on public.integration_configs (tenant_id, business_id, provider);
  end if;
  if to_regclass('public.settings') is not null then
    drop index if exists public.settings_tenant_id_key;
    create unique index settings_tenant_business_key on public.settings (tenant_id, business_id);
  end if;
end $$;

-- Agent 持久化任务与运行记录
create table if not exists public.agent_tasks (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null references tenants(id),
  business_id varchar(36) not null references businesses(id),
  task_type varchar(64) not null,
  name varchar(128) not null,
  schedule_cron varchar(64),
  status varchar(24) not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agent_tasks_tenant_business_idx on public.agent_tasks (tenant_id, business_id, status);
create index if not exists agent_tasks_next_run_idx on public.agent_tasks (next_run_at);
create unique index if not exists agent_tasks_business_name_idx on public.agent_tasks (business_id, name);

create table if not exists public.agent_task_runs (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null references tenants(id),
  business_id varchar(36) not null references businesses(id),
  task_id varchar(36) not null references agent_tasks(id) on delete cascade,
  status varchar(24) not null default 'pending',
  attempt integer not null default 1,
  max_attempts integer not null default 3,
  locked_by varchar(128),
  locked_at timestamptz,
  result jsonb,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists agent_task_runs_task_idx on public.agent_task_runs (task_id, created_at desc);
create index if not exists agent_task_runs_status_idx on public.agent_task_runs (status, locked_at);
create index if not exists agent_task_runs_tenant_business_idx on public.agent_task_runs (tenant_id, business_id, created_at desc);

-- 增量字段：任务幂等、退避重试和原子 claim（兼容已存在的早期表结构）
alter table public.agent_task_runs add column if not exists idempotency_key varchar(255);
alter table public.agent_task_runs add column if not exists available_at timestamptz;
alter table public.agent_task_runs add column if not exists claimed_by varchar(128);
alter table public.agent_task_runs add column if not exists claimed_at timestamptz;
alter table public.agent_task_runs add column if not exists input jsonb;
alter table public.agent_task_runs add column if not exists error_code varchar(64);
update public.agent_task_runs set idempotency_key = id where idempotency_key is null;
update public.agent_task_runs set available_at = coalesce(available_at, created_at, now()) where available_at is null;
update public.agent_task_runs set input = '{}'::jsonb where input is null;
alter table public.agent_task_runs alter column idempotency_key set not null;
alter table public.agent_task_runs alter column available_at set not null;
alter table public.agent_task_runs alter column input set not null;
create unique index if not exists agent_task_runs_idempotency_idx on public.agent_task_runs (idempotency_key);
create index if not exists agent_task_runs_claim_idx on public.agent_task_runs (status, available_at, claimed_at);

-- Agent 事件：检测器只写入事件，不负责发送任何外部通知
create table if not exists public.agent_events (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null references tenants(id),
  business_id varchar(36) not null references businesses(id),
  event_type varchar(64) not null,
  severity varchar(24) not null default 'info',
  title varchar(255) not null,
  content text not null,
  dedupe_key varchar(255) not null,
  status varchar(24) not null default 'open',
  metadata jsonb not null default '{}'::jsonb,
  detected_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index if not exists agent_events_business_dedupe_idx on public.agent_events (business_id, dedupe_key);
create index if not exists agent_events_tenant_business_status_idx on public.agent_events (tenant_id, business_id, status, detected_at desc);

-- 通知 outbox：事件与传输渠道解耦，所有渠道由独立 dispatcher 消费
create table if not exists public.notification_outbox (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null references tenants(id),
  business_id varchar(36) not null references businesses(id),
  event_id varchar(36) references agent_events(id),
  user_id varchar(36),
  channel varchar(32) not null,
  notification_type varchar(64) not null,
  title varchar(255) not null,
  content text not null,
  priority varchar(24) not null default 'normal',
  status varchar(24) not null default 'queued',
  idempotency_key varchar(255) not null,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  available_at timestamptz not null default now(),
  claimed_by varchar(128),
  claimed_at timestamptz,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists notification_outbox_idempotency_idx on public.notification_outbox (idempotency_key);
create index if not exists notification_outbox_claim_idx on public.notification_outbox (status, available_at, claimed_at);
create index if not exists notification_outbox_tenant_business_idx on public.notification_outbox (tenant_id, business_id, created_at desc);

-- 消息通知：用于界面展示与通知聚合
create table if not exists public.notifications (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null references tenants(id),
  business_id varchar(36) not null references businesses(id),
  user_id varchar(36),
  type varchar(64) not null,
  title varchar(255) not null,
  content text not null,
  priority varchar(24) not null default 'normal',
  status varchar(24) not null default 'unread',
  created_at timestamptz not null default now()
);
create index if not exists notifications_tenant_business_status_idx on public.notifications (tenant_id, business_id, status, created_at desc);

-- 任务 claim 必须在数据库事务中完成，避免多实例 scheduler 重复执行
create or replace function public.claim_agent_task_runs(p_worker_id text, p_limit integer default 10)
returns table (
  id varchar(36), tenant_id varchar(36), business_id varchar(36), task_id varchar(36),
  task_type varchar(64), payload jsonb, attempt integer, max_attempts integer,
  idempotency_key varchar(255)
)
language plpgsql security definer set search_path = public
as $$
begin
  update public.agent_task_runs
  set status = case when attempt >= max_attempts then 'failed' else 'pending' end,
      claimed_by = null, claimed_at = null, locked_by = null, locked_at = null,
      completed_at = case when attempt >= max_attempts then coalesce(completed_at, now()) else completed_at end,
      error = coalesce(error, 'Worker lease expired')
  where status = 'running'
    and coalesce(claimed_at, locked_at) < now() - interval '15 minutes';

  return query
  with candidates as (
    select r.id
    from public.agent_task_runs r
    join public.agent_tasks t on t.id = r.task_id
    where r.status = 'pending'
      and t.status = 'active'
      and coalesce(r.available_at, r.created_at) <= now()
      and r.claimed_at is null
    order by r.available_at nulls first, r.created_at
    limit greatest(1, least(coalesce(p_limit, 10), 100))
    for update skip locked
  )
  update public.agent_task_runs r
  set status = 'running', claimed_by = p_worker_id, claimed_at = now(),
      locked_by = p_worker_id, locked_at = now(),
      started_at = coalesce(r.started_at, now())
  from candidates c, public.agent_tasks t
  where r.id = c.id and t.id = r.task_id
  returning r.id, r.tenant_id, r.business_id, r.task_id, t.task_type, t.payload,
    r.attempt, r.max_attempts, r.idempotency_key;
end;
$$;

-- 通知 dispatcher 使用同样的原子 claim 语义；检测器永远不会直接调用渠道。
create or replace function public.claim_notification_outbox(p_worker_id text, p_limit integer default 20)
returns table (
  id varchar(36), tenant_id varchar(36), business_id varchar(36), event_id varchar(36),
  user_id varchar(36), channel varchar(32), notification_type varchar(64), title varchar(255),
  content text, priority varchar(24), attempts integer, max_attempts integer, idempotency_key varchar(255)
)
language plpgsql security definer set search_path = public
as $$
begin
  update public.notification_outbox
  set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
      claimed_by = null, claimed_at = null,
      last_error = coalesce(last_error, 'Notification lease expired')
  where status = 'sending' and claimed_at < now() - interval '15 minutes';

  return query
  with candidates as (
    select n.id
    from public.notification_outbox n
    where n.status = 'queued' and n.available_at <= now() and n.claimed_at is null
    order by n.available_at, n.created_at
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    for update skip locked
  )
  update public.notification_outbox n
  set status = 'sending', claimed_by = p_worker_id, claimed_at = now(), attempts = n.attempts + 1
  from candidates c
  where n.id = c.id
  returning n.id, n.tenant_id, n.business_id, n.event_id, n.user_id, n.channel,
    n.notification_type, n.title, n.content, n.priority, n.attempts, n.max_attempts, n.idempotency_key;
end;
$$;
revoke all on function public.claim_agent_task_runs(text, integer) from public, anon, authenticated;
grant execute on function public.claim_agent_task_runs(text, integer) to service_role;
revoke all on function public.claim_notification_outbox(text, integer) from public, anon, authenticated;
grant execute on function public.claim_notification_outbox(text, integer) to service_role;

-- PWA Web Push 订阅
create table if not exists public.push_subscriptions (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null references tenants(id),
  business_id varchar(36) references businesses(id),
  user_id varchar(36),
  endpoint text not null,
  keys jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_tenant_business_idx on public.push_subscriptions (tenant_id, business_id);
create index if not exists push_subscriptions_endpoint_idx on public.push_subscriptions (endpoint);

-- Human-in-the-Loop 审批单
create table if not exists public.agent_approvals (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null references tenants(id),
  business_id varchar(36) not null references businesses(id),
  user_id varchar(36),
  requester varchar(128),
  agent varchar(64) not null default 'business-agent',
  tool_name varchar(128),
  arguments jsonb not null default '{}'::jsonb,
  arguments_hash varchar(64),
  risk_level varchar(16) not null default 'medium',
  required_role varchar(20) not null default 'manager',
  invocation_id varchar(128) not null default gen_random_uuid()::text,
  execution_id varchar(36),
  approved_by varchar(36),
  action_type varchar(64) not null,
  title varchar(255) not null,
  description text,
  payload jsonb not null default '{}'::jsonb,
  status varchar(24) not null default 'pending',
  expires_at timestamptz,
  approved_at timestamptz,
  rejected_at timestamptz,
  consumed_at timestamptz,
  executed_at timestamptz,
  failed_at timestamptz,
  execution_result jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.agent_approvals add column if not exists requester varchar(128);
alter table public.agent_approvals add column if not exists agent varchar(64) not null default 'business-agent';
alter table public.agent_approvals add column if not exists tool_name varchar(128);
alter table public.agent_approvals add column if not exists arguments jsonb not null default '{}'::jsonb;
alter table public.agent_approvals add column if not exists arguments_hash varchar(64);
alter table public.agent_approvals add column if not exists risk_level varchar(16) not null default 'medium';
alter table public.agent_approvals add column if not exists required_role varchar(20) not null default 'manager';
alter table public.agent_approvals add column if not exists invocation_id varchar(128);
alter table public.agent_approvals add column if not exists execution_id varchar(36);
alter table public.agent_approvals add column if not exists approved_by varchar(36);
alter table public.agent_approvals add column if not exists consumed_at timestamptz;
alter table public.agent_approvals add column if not exists executed_at timestamptz;
alter table public.agent_approvals add column if not exists failed_at timestamptz;
alter table public.agent_approvals add column if not exists execution_result jsonb;
alter table public.agent_approvals add column if not exists last_error text;
update public.agent_approvals set invocation_id = gen_random_uuid()::text where invocation_id is null or invocation_id = '';
alter table public.agent_approvals alter column invocation_id set not null;
create index if not exists agent_approvals_tenant_business_idx on public.agent_approvals (tenant_id, business_id, status);
create index if not exists agent_approvals_status_created_idx on public.agent_approvals (status, created_at desc);
create unique index if not exists agent_approvals_invocation_idx
  on public.agent_approvals (tenant_id, business_id, invocation_id);
