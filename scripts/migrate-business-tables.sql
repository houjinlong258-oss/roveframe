-- =====================================================
-- RoveFrame 22 张业务表 DDL + 全表 tenant_id 改造
-- 配合 scripts/migrate.sql 使用(P0 平台表 + cron_state + staff + business_memories 已在那边建)
--
-- 用法:
--   1) 先在 Supabase SQL Editor 跑 scripts/migrate.sql
--   2) 再跑本文件 scripts/migrate-business-tables.sql
--   3) 跑 pnpm tsx scripts/run-migrate.ts(可选,会再跑一次 idempotent 检查)
--
-- 字段定义来源: src/storage/database/shared/schema.ts(Drizzle ORM)
-- 全部 CREATE 使用 if not exists,可重复跑
-- =====================================================

-- ---------- pgvector 扩展(doc_chunks.embedding 需要) ----------
create extension if not exists vector;

-- =====================================================
-- 22 张业务表(从 schema.ts 转 DDL)
-- =====================================================

-- ---------- products ----------
create table if not exists public.products (
  id varchar(36) primary key default gen_random_uuid(),
  name varchar(128) not null,
  category varchar(50) not null default '招牌菜',
  price numeric(10,2) not null default 0,
  cost numeric(10,2) not null default 0,
  stock integer not null default 0,
  sales_count integer not null default 0,
  status varchar(20) not null default 'active',
  description text,
  image_url text,
  video_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists products_category_idx on public.products (category);
create index if not exists products_status_idx on public.products (status);

-- ---------- customers ----------
create table if not exists public.customers (
  id varchar(36) primary key default gen_random_uuid(),
  name varchar(128) not null,
  phone varchar(32),
  email varchar(255),
  tags jsonb not null default '[]'::jsonb,
  total_spent numeric(12,2) not null default 0,
  visit_count integer not null default 0,
  last_visit_at timestamptz,
  ai_score integer,
  churn_risk varchar(20) not null default 'low',
  preference_notes text,
  created_at timestamptz not null default now()
);
create index if not exists customers_churn_risk_idx on public.customers (churn_risk);
create index if not exists customers_last_visit_idx on public.customers (last_visit_at);

-- ---------- orders ----------
create table if not exists public.orders (
  id varchar(36) primary key default gen_random_uuid(),
  order_no varchar(40) not null unique,
  customer_id varchar(36) references public.customers(id),
  items jsonb not null default '[]'::jsonb,
  total numeric(10,2) not null default 0,
  tip numeric(10,2) not null default 0,
  tip_percent numeric(5,2),
  tip_staff_id varchar(36),
  channel varchar(20) not null default 'dine_in',
  status varchar(20) not null default 'pending',
  source varchar(20) not null default 'native',
  external_id varchar(128),
  table_no varchar(20),
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists orders_customer_id_idx on public.orders (customer_id);
create index if not exists orders_status_idx on public.orders (status);
create index if not exists orders_created_at_idx on public.orders (created_at);
create index if not exists orders_source_external_idx on public.orders (source, external_id);

-- ---------- payments / payment_events ----------
create table if not exists public.payments (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null references public.tenants(id),
  business_id varchar(36) not null references public.businesses(id),
  provider varchar(20) not null,
  external_id varchar(255),
  provider_payment_id varchar(255),
  amount numeric(14,3) not null,
  amount_minor bigint not null,
  currency varchar(3) not null default 'USD',
  status varchar(32) not null default 'pending',
  description varchar(200),
  reservation_id varchar(36),
  order_id varchar(36),
  checkout_url text,
  failure_reason text,
  refunded_amount_minor bigint not null default 0,
  reconciled_at timestamptz,
  created_by varchar(36),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.payments add column if not exists business_id varchar(36) references public.businesses(id);
alter table public.payments add column if not exists provider_payment_id varchar(255);
alter table public.payments add column if not exists refunded_amount_minor bigint not null default 0;
alter table public.payments add column if not exists reconciled_at timestamptz;
alter table public.payments alter column amount type numeric(14,3);
create unique index if not exists payments_provider_external_idx
  on public.payments (tenant_id, business_id, provider, external_id)
  where external_id is not null;
create index if not exists payments_tenant_status_idx on public.payments (tenant_id, business_id, status, created_at desc);
create unique index if not exists payments_provider_payment_idx
  on public.payments (tenant_id, business_id, provider, provider_payment_id)
  where provider_payment_id is not null;

create table if not exists public.payment_events (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null references public.tenants(id),
  business_id varchar(36) not null references public.businesses(id),
  provider varchar(20) not null,
  external_event_id varchar(255) not null,
  event_type varchar(100) not null,
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
alter table public.payment_events add column if not exists business_id varchar(36) references public.businesses(id);
alter table public.payment_events add column if not exists processed_at timestamptz;
alter table public.payment_events add column if not exists last_error text;
create unique index if not exists payment_events_provider_event_idx
  on public.payment_events (tenant_id, business_id, provider, external_event_id);

create table if not exists public.integration_events (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null references public.tenants(id),
  business_id varchar(36) not null references public.businesses(id),
  provider varchar(30) not null,
  external_event_id varchar(255) not null,
  event_type varchar(100) not null,
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists integration_events_provider_event_idx
  on public.integration_events (tenant_id, business_id, provider, external_event_id);

-- ---------- reviews ----------
create table if not exists public.reviews (
  id varchar(36) primary key default gen_random_uuid(),
  customer_id varchar(36) references public.customers(id),
  author_name varchar(128) not null,
  platform varchar(20) not null default 'google',
  rating integer not null default 5,
  content text not null,
  sentiment varchar(20) not null default 'positive',
  status varchar(20) not null default 'pending',
  reply_content text,
  reply_status varchar(20) not null default 'none',
  created_at timestamptz not null default now()
);
create index if not exists reviews_customer_id_idx on public.reviews (customer_id);
create index if not exists reviews_platform_idx on public.reviews (platform);
create index if not exists reviews_status_idx on public.reviews (status);
create index if not exists reviews_sentiment_idx on public.reviews (sentiment);

-- ---------- email_accounts ----------
create table if not exists public.email_accounts (
  id varchar(36) primary key default gen_random_uuid(),
  provider varchar(20) not null default 'smtp',
  email varchar(255) not null,
  display_name varchar(128),
  auth_type varchar(20) not null default 'password',
  credentials_encrypted text,
  smtp_host varchar(255),
  smtp_port integer,
  imap_host varchar(255),
  imap_port integer,
  is_default boolean not null default false,
  status varchar(20) not null default 'active',
  created_at timestamptz not null default now()
);
create index if not exists email_accounts_status_idx on public.email_accounts (status);

-- ---------- emails ----------
create table if not exists public.emails (
  id varchar(36) primary key default gen_random_uuid(),
  mailbox_id varchar(36) references public.email_accounts(id),
  from_addr varchar(255) not null,
  from_name varchar(128),
  to_addr varchar(255) not null,
  subject varchar(500) not null,
  content text not null,
  category varchar(30) not null default 'other',
  priority varchar(20) not null default 'medium',
  ai_summary text,
  reply_draft text,
  status varchar(20) not null default 'unread',
  external_id varchar(255),
  created_at timestamptz not null default now()
);
create index if not exists emails_mailbox_id_idx on public.emails (mailbox_id);
create index if not exists emails_category_idx on public.emails (category);
create index if not exists emails_status_idx on public.emails (status);
create index if not exists emails_created_at_idx on public.emails (created_at);

-- ---------- email_send_tasks ----------
create table if not exists public.email_send_tasks (
  id varchar(36) primary key default gen_random_uuid(),
  account_id varchar(36) references public.email_accounts(id),
  content_id varchar(36),
  to_addr varchar(255) not null,
  subject varchar(500) not null,
  content text not null,
  status varchar(20) not null default 'queued',
  scheduled_at timestamptz,
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists email_send_tasks_account_idx on public.email_send_tasks (account_id);
create index if not exists email_send_tasks_status_idx on public.email_send_tasks (status);

-- ---------- knowledge_docs ----------
create table if not exists public.knowledge_docs (
  id varchar(36) primary key default gen_random_uuid(),
  title varchar(255) not null,
  category varchar(30) not null default 'sop',
  content text not null,
  status varchar(20) not null default 'ready',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists knowledge_docs_category_idx on public.knowledge_docs (category);

-- ---------- doc_chunks(带 vector 1024) ----------
create table if not exists public.doc_chunks (
  id varchar(36) primary key default gen_random_uuid(),
  doc_id varchar(36) not null references public.knowledge_docs(id) on delete cascade,
  chunk_index integer not null default 0,
  content text not null,
  embedding vector(1024),
  created_at timestamptz not null default now()
);
create index if not exists doc_chunks_doc_id_idx on public.doc_chunks (doc_id);

-- ---------- chat_sessions ----------
create table if not exists public.chat_sessions (
  id varchar(36) primary key default gen_random_uuid(),
  title varchar(255) not null default '新会话',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- chat_messages ----------
create table if not exists public.chat_messages (
  id varchar(36) primary key default gen_random_uuid(),
  session_id varchar(36) not null references public.chat_sessions(id) on delete cascade,
  role varchar(20) not null,
  content text not null,
  thinking text,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_session_idx on public.chat_messages (session_id);
create index if not exists chat_messages_created_idx on public.chat_messages (created_at);

-- ---------- alerts ----------
create table if not exists public.alerts (
  id varchar(36) primary key default gen_random_uuid(),
  type varchar(30) not null default 'system',
  level varchar(20) not null default 'info',
  title varchar(255) not null,
  content text not null,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists alerts_is_read_idx on public.alerts (is_read);
create index if not exists alerts_created_at_idx on public.alerts (created_at);

-- ---------- marketing_contents ----------
create table if not exists public.marketing_contents (
  id varchar(36) primary key default gen_random_uuid(),
  type varchar(20) not null default 'campaign',
  title varchar(255) not null,
  brief text,
  content text not null,
  status varchar(20) not null default 'draft',
  send_stats jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists marketing_contents_type_idx on public.marketing_contents (type);
create index if not exists marketing_contents_status_idx on public.marketing_contents (status);

-- ---------- reservations ----------
create table if not exists public.reservations (
  id varchar(36) primary key default gen_random_uuid(),
  customer_name varchar(128) not null,
  phone varchar(32) not null,
  party_size integer not null default 2,
  table_no varchar(20),
  reserved_at timestamptz not null,
  status varchar(20) not null default 'pending',
  source varchar(20) not null default 'phone',
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists reservations_reserved_at_idx on public.reservations (reserved_at);
create index if not exists reservations_status_idx on public.reservations (status);

-- ---------- store_qr_codes ----------
create table if not exists public.store_qr_codes (
  id varchar(36) primary key default gen_random_uuid(),
  table_no varchar(20) not null,
  public_token varchar(64) not null default encode(gen_random_bytes(24), 'hex'),
  remark varchar(128),
  is_active boolean not null default true,
  scan_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- model_configs ----------
create table if not exists public.model_configs (
  id varchar(36) primary key default gen_random_uuid(),
  provider varchar(30) not null,
  api_key_encrypted text,
  base_url varchar(500),
  default_model varchar(100),
  is_enabled boolean not null default false,
  last_test_ok boolean,
  last_tested_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists model_configs_enabled_idx on public.model_configs (is_enabled);

-- ---------- integration_configs ----------
create table if not exists public.integration_configs (
  id varchar(36) primary key default gen_random_uuid(),
  provider varchar(30) not null,
  config_encrypted text,
  is_enabled boolean not null default false,
  sync_scope jsonb not null default '[]'::jsonb,
  last_sync_at timestamptz,
  status varchar(20) not null default 'disconnected',
  created_at timestamptz not null default now()
);
create index if not exists integration_configs_enabled_idx on public.integration_configs (is_enabled);

-- ---------- inventory_items ----------
create table if not exists public.inventory_items (
  id varchar(36) primary key default gen_random_uuid(),
  name varchar(128) not null,
  category varchar(50) not null default '食材',
  unit varchar(20) not null default 'kg',
  current_stock numeric(10,2) not null default 0,
  safety_stock numeric(10,2) not null default 0,
  supplier varchar(128),
  erp_item_code varchar(64),
  synced_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists inventory_items_category_idx on public.inventory_items (category);

-- ---------- settings(单行 jsonb;P0-S3 会改多行) ----------
create table if not exists public.settings (
  id varchar(36) primary key default gen_random_uuid(),
  business jsonb not null default '{}'::jsonb,
  locale jsonb not null default '{}'::jsonb,
  ai_prefs jsonb not null default '{}'::jsonb,
  model_assign jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------- tenant + business scope hardening ----------
-- Add both ownership columns to every operational table that exists. Existing
-- pre-tenant rows are assigned to the documented default tenant. A business is
-- inferred only when that tenant has exactly one business; ambiguous legacy
-- rows abort the migration and require an explicit operator mapping.
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
      execute format('alter table public.%I add column if not exists tenant_id varchar(36)', table_name);
      execute format('alter table public.%I add column if not exists business_id varchar(36) references public.businesses(id)', table_name);
      execute format(
        'update public.%I set tenant_id = %L where tenant_id is null',
        table_name,
        '00000000-0000-0000-0000-000000000000'
      );
      execute format(
        'update public.%I row set business_id = only_business.id from '
        '(select tenant_id, min(id) as id from public.businesses group by tenant_id having count(*) = 1) only_business '
        'where row.business_id is null and only_business.tenant_id = row.tenant_id',
        table_name
      );
      execute format('select count(*) from public.%I where business_id is null', table_name) into missing_business;
      if missing_business > 0 then
        raise exception 'business scope backfill required for %.% rows', table_name, missing_business;
      end if;
      execute format('alter table public.%I alter column tenant_id set not null', table_name);
      execute format('alter table public.%I alter column business_id set not null', table_name);
      execute format('create index if not exists %I on public.%I (tenant_id, business_id)', table_name || '_tenant_business_idx', table_name);
    end if;
  end loop;
end $$;

-- Existing approval installations gain a frozen, single-use invocation record.
do $$ begin
  if to_regclass('public.agent_approvals') is not null then
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
    create unique index if not exists agent_approvals_invocation_idx
      on public.agent_approvals (tenant_id, business_id, invocation_id);
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

-- Retry-safe public QR orders and per-business configuration uniqueness.
drop index if exists public.orders_qr_idempotency_idx;
create unique index orders_qr_idempotency_idx
  on public.orders (tenant_id, business_id, external_id)
  where source = 'qr' and external_id is not null;

alter table public.store_qr_codes drop constraint if exists store_qr_codes_table_no_key;
alter table public.store_qr_codes drop constraint if exists store_qr_codes_tenant_table_no_key;
create unique index if not exists store_qr_codes_tenant_business_table_no_key
  on public.store_qr_codes (tenant_id, business_id, table_no);
create unique index if not exists store_qr_codes_public_token_key on public.store_qr_codes (public_token);
create index if not exists store_qr_codes_public_token_idx on public.store_qr_codes (public_token) where is_active;

alter table public.model_configs drop constraint if exists model_configs_provider_key;
drop index if exists public.model_configs_tenant_provider_key;
drop index if exists public.model_configs_tenant_business_provider_key;
create unique index model_configs_tenant_business_provider_key
  on public.model_configs (tenant_id, business_id, provider);

alter table public.integration_configs drop constraint if exists integration_configs_provider_key;
drop index if exists public.integration_configs_tenant_provider_key;
drop index if exists public.integration_configs_tenant_business_provider_key;
create unique index integration_configs_tenant_business_provider_key
  on public.integration_configs (tenant_id, business_id, provider);

drop index if exists public.settings_tenant_id_key;
drop index if exists public.settings_tenant_business_key;
create unique index settings_tenant_business_key
  on public.settings (tenant_id, business_id);

drop index if exists public.payments_provider_external_idx;
create unique index payments_provider_external_idx
  on public.payments (tenant_id, business_id, provider, external_id)
  where external_id is not null;
drop index if exists public.payment_events_provider_event_idx;
create unique index payment_events_provider_event_idx
  on public.payment_events (tenant_id, business_id, provider, external_event_id);

-- =====================================================
-- RAG vector retrieval always requires exact tenant + business scope.
-- =====================================================
drop function if exists public.match_doc_chunks(text, int, varchar);
drop function if exists public.match_doc_chunks(text, int, varchar, varchar);
create function public.match_doc_chunks(
  query_embedding text,
  match_count int,
  filter_tenant_id varchar(36),
  filter_business_id varchar(36)
)
returns table (
  id varchar(36),
  doc_id varchar(36),
  chunk_index int,
  content text,
  similarity float
)
language sql
stable
as $$
  select
    c.id::varchar(36),
    c.doc_id::varchar(36),
    c.chunk_index,
    c.content,
    1 - (c.embedding <=> query_embedding::vector) as similarity
  from public.doc_chunks c
  join public.knowledge_docs d on d.id = c.doc_id
  where filter_tenant_id is not null
    and filter_business_id is not null
    and c.tenant_id = filter_tenant_id
    and c.business_id = filter_business_id
    and d.tenant_id = filter_tenant_id
    and d.business_id = filter_business_id
  order by c.embedding <=> query_embedding::vector
  limit greatest(match_count, 1);
$$;

-- ---------- AI Provider 连接中心扩展（2026-09-05） ----------
-- model_configs：协议/超时/重试/能力/模型缓存/脱敏测试错误/本地 opt-in/business 级配置
alter table public.model_configs add column if not exists display_name varchar(120);
alter table public.model_configs add column if not exists business_id varchar(36) references public.businesses(id);
alter table public.model_configs add column if not exists timeout_ms int;
alter table public.model_configs add column if not exists max_retries int;
alter table public.model_configs add column if not exists last_test_error varchar(500);
alter table public.model_configs add column if not exists models_cache jsonb;
alter table public.model_configs add column if not exists models_updated_at timestamptz;
alter table public.model_configs add column if not exists opt_in_local boolean not null default false;
-- Provider configuration is unique for one exact tenant + business pair.
drop index if exists public.model_configs_tenant_business_provider_key;
create unique index model_configs_tenant_business_provider_key
  on public.model_configs (tenant_id, business_id, provider);

-- ---------- AI 用量账本 ----------
create table if not exists public.ai_usage_ledger (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36),
  business_id varchar(36),
  user_id varchar(36),
  agent varchar(60),
  provider varchar(40) not null,
  model varchar(120) not null,
  input_tokens int,
  output_tokens int,
  -- 无可靠价格数据时保持 null，不伪造精确成本
  estimated_cost_usd numeric(12, 6),
  status varchar(20) not null default 'ok',
  error_code varchar(40),
  correlation_id varchar(64) not null,
  latency_ms int,
  created_at timestamptz not null default now()
);
create unique index if not exists emails_mailbox_external_idx
  on public.emails (tenant_id, business_id, mailbox_id, external_id) where external_id is not null;
create index if not exists ai_usage_ledger_tenant_idx on public.ai_usage_ledger (tenant_id, created_at desc);
create index if not exists ai_usage_ledger_correlation_idx on public.ai_usage_ledger (correlation_id);
