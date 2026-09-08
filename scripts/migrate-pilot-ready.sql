-- ============================================================
-- migrate-pilot-ready.sql
-- RoveFrame Pilot Ready 升级迁移（P0-1 召回活动 / P0-5 审计存储）
-- 幂等：全部使用 IF NOT EXISTS / ADD COLUMN IF NOT EXISTS。
-- 执行：Supabase SQL Editor（或 psql -f scripts/migrate-pilot-ready.sql）
-- ============================================================

-- 1) email_send_tasks 出件队列列（真实发送状态机 + 活动/审批关联）
do $$ begin
  if to_regclass('public.email_send_tasks') is not null then
    alter table public.email_send_tasks
      add column if not exists campaign_id varchar(36),
      add column if not exists approval_id varchar(36),
      add column if not exists execution_id varchar(36),
      add column if not exists failed_at timestamptz,
      add column if not exists claimed_at timestamptz,
      add column if not exists attempts integer not null default 0,
      add column if not exists max_attempts integer not null default 3,
      add column if not exists provider_message_id varchar(255),
      add column if not exists last_error text;
    create index if not exists email_send_tasks_campaign_idx
      on public.email_send_tasks (tenant_id, business_id, campaign_id, status);
    create index if not exists email_send_tasks_status_sched_idx
      on public.email_send_tasks (status, scheduled_at);
  end if;
end $$;

-- 2) marketing_contents 审批关联与发送完成时间
do $$ begin
  if to_regclass('public.marketing_contents') is not null then
    alter table public.marketing_contents
      add column if not exists approval_id varchar(36),
      add column if not exists sent_at timestamptz;
    create index if not exists marketing_contents_approval_idx
      on public.marketing_contents (tenant_id, business_id, approval_id);
  end if;
end $$;

-- 3) Production Audit Store
create table if not exists public.audit_events (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null,
  business_id varchar(36) not null,
  user_id varchar(36),
  agent_id varchar(64),
  tool_name varchar(128),
  action varchar(64) not null,
  arguments_hash varchar(64),
  approval_id varchar(36),
  execution_id varchar(36),
  result jsonb,
  actor_role varchar(20),
  status varchar(24) not null default 'ok',
  created_at timestamptz not null default now()
);
create index if not exists audit_events_tenant_business_idx
  on public.audit_events (tenant_id, business_id, created_at desc);
create index if not exists audit_events_approval_idx
  on public.audit_events (tenant_id, business_id, approval_id);
create index if not exists audit_events_execution_idx
  on public.audit_events (execution_id, action);
