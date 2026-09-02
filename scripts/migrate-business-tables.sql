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
  table_no varchar(20) not null unique,
  remark varchar(128),
  is_active boolean not null default true,
  scan_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- model_configs ----------
create table if not exists public.model_configs (
  id varchar(36) primary key default gen_random_uuid(),
  provider varchar(30) not null unique,
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
  provider varchar(30) not null unique,
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

-- ---------- 22 张业务表加 tenant_id(可空,回填后收紧) ----------
alter table public.products add column if not exists tenant_id varchar(36);
alter table public.customers add column if not exists tenant_id varchar(36);
alter table public.orders add column if not exists tenant_id varchar(36);
alter table public.reviews add column if not exists tenant_id varchar(36);
alter table public.email_accounts add column if not exists tenant_id varchar(36);
alter table public.emails add column if not exists tenant_id varchar(36);
alter table public.email_send_tasks add column if not exists tenant_id varchar(36);
alter table public.knowledge_docs add column if not exists tenant_id varchar(36);
alter table public.doc_chunks add column if not exists tenant_id varchar(36);
alter table public.chat_sessions add column if not exists tenant_id varchar(36);
alter table public.chat_messages add column if not exists tenant_id varchar(36);
alter table public.alerts add column if not exists tenant_id varchar(36);
alter table public.marketing_contents add column if not exists tenant_id varchar(36);
alter table public.reservations add column if not exists tenant_id varchar(36);
alter table public.store_qr_codes add column if not exists tenant_id varchar(36);
alter table public.model_configs add column if not exists tenant_id varchar(36);
alter table public.integration_configs add column if not exists tenant_id varchar(36);
alter table public.inventory_items add column if not exists tenant_id varchar(36);
alter table public.settings add column if not exists tenant_id varchar(36);

-- ---------- 默认租户已在 migrate.sql 创建;此处只回填业务表 tenant_id ----------
update public.products set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.customers set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.orders set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.reviews set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.email_accounts set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.emails set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.email_send_tasks set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.knowledge_docs set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.doc_chunks set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.chat_sessions set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.chat_messages set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.alerts set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.marketing_contents set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.reservations set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.store_qr_codes set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.model_configs set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.integration_configs set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.inventory_items set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;
update public.settings set tenant_id = '00000000-0000-0000-0000-000000000000' where tenant_id is null;

-- =====================================================
-- RAG 向量检索 RPC(P0-S2 tenant 化要求:必须传 filter_tenant_id)
-- =====================================================
create or replace function public.match_doc_chunks(
  query_embedding text,
  match_count int default 5,
  filter_tenant_id varchar(36) default null
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
  where (filter_tenant_id is null or d.tenant_id = filter_tenant_id)
  order by c.embedding <=> query_embedding::vector
  limit greatest(match_count, 1);
$$;
