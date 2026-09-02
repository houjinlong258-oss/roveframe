import { Pool } from 'pg';

/** 所有待建的表/列（单一事实来源；与 scripts/migrate.sql 保持一致） */
export const MIGRATION_SQL = `
create table if not exists public.cron_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists public.staff (
  id varchar(36) primary key default gen_random_uuid(),
  name varchar(128) not null,
  role varchar(50),
  photo_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.business_memories (
  id varchar(36) primary key default gen_random_uuid(),
  content text not null,
  created_at timestamptz not null default now()
);
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

-- 现有业务表加 tenant_id（先可空，回填默认租户后可收紧为 not null）
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
`;

const DSN_KEYS = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'DIRECT_URL',
  'COZE_SUPABASE_DATABASE_URL',
  'SUPABASE_DATABASE_URL',
  'PG_CONNECTION_STRING',
];

export interface MigrateResult {
  ok: boolean;
  method: 'pg-dsn' | 'management-api' | 'none';
  error?: string;
}

/** 从 COZE_SUPABASE_URL（https://<ref>.supabase.co）解析项目 ref */
function projectRef(): string {
  const m = /https?:\/\/([^.]+)\.supabase\.co/.exec(process.env.COZE_SUPABASE_URL ?? '');
  return m?.[1] ?? '';
}

/**
 * 自动建表：优先用 Postgres DSN；否则用 Supabase Management API。
 * 两者都缺失时返回 method=none（由调用方决定是否告警）。
 */
export async function autoMigrate(): Promise<MigrateResult> {
  // 1) Postgres 直连（pg）
  const dsn = DSN_KEYS.map((k) => process.env[k]).find((v): v is string => Boolean(v));
  if (dsn) {
    const pool = new Pool({ connectionString: dsn, ssl: { rejectUnauthorized: false } });
    try {
      await pool.query(MIGRATION_SQL);
      return { ok: true, method: 'pg-dsn' };
    } catch (e) {
      return { ok: false, method: 'pg-dsn', error: e instanceof Error ? e.message : String(e) };
    } finally {
      await pool.end();
    }
  }

  // 2) Supabase Management API（需要 SUPABASE_ACCESS_TOKEN）
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref = projectRef();
  if (token && ref) {
    const resp = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: MIGRATION_SQL }),
    });
    if (resp.ok) return { ok: true, method: 'management-api' };
    return { ok: false, method: 'management-api', error: `HTTP ${resp.status}: ${await resp.text()}` };
  }

  return { ok: false, method: 'none', error: '未配置 DATABASE_URL 或 SUPABASE_ACCESS_TOKEN' };
}