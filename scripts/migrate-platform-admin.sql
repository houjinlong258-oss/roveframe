-- ============================================================
-- RoveFrame Platform Admin / SaaS Control Plane 实体
-- 2026-09-05
-- 平台级表不属于任何商户租户；访问只能经由 requirePlatformAdmin。
-- 幂等：全部使用 if not exists / on conflict do nothing。
-- ============================================================

-- ---------- 平台管理员 ----------
create table if not exists public.platform_admins (
  id varchar(36) primary key default gen_random_uuid(),
  email varchar(255) not null,
  password_hash text not null,
  name varchar(120),
  role varchar(30) not null default 'admin', -- super_admin / admin / support_readonly
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index if not exists platform_admins_email_key on public.platform_admins (lower(email));

-- ---------- 平台管理员会话（独立 cookie 命名空间 rf_admin_session） ----------
create table if not exists public.platform_admin_sessions (
  id varchar(36) primary key default gen_random_uuid(),
  admin_id varchar(36) not null references public.platform_admins(id),
  token_hash varchar(128) not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists platform_admin_sessions_token_idx on public.platform_admin_sessions (token_hash);
create index if not exists platform_admin_sessions_admin_idx on public.platform_admin_sessions (admin_id, expires_at desc);

-- ---------- 订阅套餐 ----------
create table if not exists public.subscription_plans (
  id varchar(36) primary key default gen_random_uuid(),
  slug varchar(60) not null,
  name varchar(120) not null,
  description text,
  price_amount numeric(12, 2) not null default 0,
  currency varchar(8) not null default 'USD',
  interval varchar(20) not null default 'month', -- month / year
  features jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists subscription_plans_slug_key on public.subscription_plans (slug);

-- ---------- 商户订阅 ----------
create table if not exists public.tenant_subscriptions (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null,
  plan_id varchar(36) references public.subscription_plans(id),
  status varchar(20) not null default 'trialing', -- trialing / active / past_due / grace / suspended / cancelled
  started_at timestamptz not null default now(),
  current_period_end timestamptz,
  grace_period_end timestamptz,
  cancelled_at timestamptz,
  renewal_source varchar(30), -- stripe / offline / link
  provider_subscription_id varchar(120),
  amount numeric(12, 2),
  currency varchar(8) default 'USD',
  last_payment_status varchar(30),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists tenant_subscriptions_tenant_key on public.tenant_subscriptions (tenant_id);
create unique index if not exists tenant_subscriptions_provider_sub_key
  on public.tenant_subscriptions (provider_subscription_id)
  where provider_subscription_id is not null;

-- ---------- 订阅事件（幂等：event_key 唯一） ----------
create table if not exists public.subscription_events (
  id varchar(36) primary key default gen_random_uuid(),
  event_key varchar(120) not null,
  tenant_id varchar(36) not null,
  type varchar(40) not null, -- trial_started / renewed / payment_failed / suspended / resumed / extended / cancelled / expired
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists subscription_events_key on public.subscription_events (event_key);
create index if not exists subscription_events_tenant_idx on public.subscription_events (tenant_id, created_at desc);

-- ---------- 发票 ----------
create table if not exists public.invoices (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null,
  subscription_id varchar(36) references public.tenant_subscriptions(id),
  number varchar(60),
  amount numeric(12, 2) not null,
  currency varchar(8) not null default 'USD',
  status varchar(20) not null default 'open', -- open / paid / void / uncollectible
  provider_invoice_id varchar(120),
  issued_at timestamptz not null default now(),
  paid_at timestamptz
);
create unique index if not exists invoices_provider_key
  on public.invoices (provider_invoice_id)
  where provider_invoice_id is not null;
create index if not exists invoices_tenant_idx on public.invoices (tenant_id, issued_at desc);

-- ---------- 功能 entitlement / 灰度开关 ----------
create table if not exists public.feature_entitlements (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36), -- null = 平台全局默认
  feature varchar(80) not null,
  enabled boolean not null default true,
  rollout_percent int not null default 100,
  note varchar(500),
  updated_by varchar(36),
  updated_at timestamptz not null default now()
);
create unique index if not exists feature_entitlements_key
  on public.feature_entitlements (coalesce(tenant_id, ''), feature);

-- ---------- 受控售后排障授权 ----------
create table if not exists public.support_access_grants (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null,
  admin_id varchar(36) not null references public.platform_admins(id),
  reason varchar(500) not null,
  read_only boolean not null default true,
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists support_access_grants_idx on public.support_access_grants (tenant_id, admin_id, ends_at desc);

-- ---------- 平台审计日志（append-only，商户端无写路径） ----------
create table if not exists public.platform_admin_audit_logs (
  id varchar(36) primary key default gen_random_uuid(),
  admin_id varchar(36),
  action varchar(80) not null,
  target_tenant_id varchar(36),
  target_business_id varchar(36),
  request_id varchar(64),
  summary jsonb not null default '{}'::jsonb, -- 只写脱敏摘要，禁止明文秘密
  created_at timestamptz not null default now()
);
create index if not exists platform_admin_audit_idx on public.platform_admin_audit_logs (created_at desc);
create index if not exists platform_admin_audit_tenant_idx on public.platform_admin_audit_logs (target_tenant_id, created_at desc);
