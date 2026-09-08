-- =====================================================
-- RoveFrame Production Hardening Sprint
-- error_events / coding_proposals / audit_logs
-- 用法: 在 Supabase SQL Editor 整段执行（幂等，可重复运行）
--
-- 说明:
--   1. 三张表均带 tenant_id 做租户隔离
--   2. 服务侧以 service_role key 访问，RLS 开启但由 service role 绕过；
--      anon 角色无任何直接权限
--   3. coding_proposals.status 允许:
--      pending_review / approved / rejected / applied / apply_failed / rolled_back
-- =====================================================

-- ---------- error_events（Sprint 5 错误事件持久化） ----------
create table if not exists public.error_events (
  id varchar(64) primary key,
  tenant_id varchar(36) not null,
  "timestamp" timestamptz not null,
  severity varchar(16) not null,
  category varchar(16) not null,
  message text not null,
  stack text,
  url varchar(500),
  method varchar(10),
  status_code int,
  context jsonb,
  business_id varchar(36),
  user_id varchar(64),
  fingerprint varchar(64) not null
);

create index if not exists error_events_tenant_time_idx
  on public.error_events (tenant_id, "timestamp" desc);

create index if not exists error_events_fingerprint_idx
  on public.error_events (tenant_id, fingerprint);

-- ---------- coding_proposals（Sprint 6 提案持久化 + apply/rollback 元数据） ----------
create table if not exists public.coding_proposals (
  id varchar(64) primary key,
  tenant_id varchar(36) not null,
  task_id varchar(64) not null,
  status varchar(20) not null default 'pending_review',
  title varchar(500) not null,
  summary text not null,
  changes jsonb not null default '[]'::jsonb,
  risk_level varchar(20) not null default 'review_required',
  blocked_paths jsonb not null default '[]'::jsonb,
  model varchar(100),
  decided_by varchar(64),
  decided_at timestamptz,
  applied_at timestamptz,
  applied_by varchar(64),
  applied_commit_sha varchar(64),
  rolled_back_at timestamptz,
  rolled_back_by varchar(64),
  rollback_commit_sha varchar(64),
  apply_log text,
  generated_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists coding_proposals_tenant_time_idx
  on public.coding_proposals (tenant_id, generated_at desc);

create index if not exists coding_proposals_status_idx
  on public.coding_proposals (tenant_id, status);

-- ---------- audit_logs（关键操作审计；src/lib/audit.ts 已在写入此表） ----------
create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  tenant_id varchar(36) not null,
  actor_id varchar(64),
  action varchar(100) not null,
  entity varchar(100) not null,
  entity_id varchar(100),
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_logs_tenant_time_idx
  on public.audit_logs (tenant_id, created_at desc);

create index if not exists audit_logs_entity_idx
  on public.audit_logs (tenant_id, entity, entity_id);

-- ---------- RLS：开启行级安全，仅 service role 可访问（服务端专用表） ----------
alter table public.error_events enable row level security;
alter table public.coding_proposals enable row level security;
alter table public.audit_logs enable row level security;

-- ---------- Enterprise Memory 行业层：knowledge_docs 补 industry 列 ----------
-- 表可能由早期环境手工创建，这里用 to_regclass 守卫保持幂等
do $$
begin
  if to_regclass('public.knowledge_docs') is not null then
    execute 'alter table public.knowledge_docs add column if not exists industry varchar(50)';
    execute 'create index if not exists knowledge_docs_industry_idx on public.knowledge_docs (industry)';
  end if;
end $$;

-- ---------- Phase 8：coding_proposals 补审批备注列 ----------
alter table public.coding_proposals add column if not exists review_note text;
