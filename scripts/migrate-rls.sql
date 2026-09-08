-- ============================================================
-- migrate-rls.sql — Supabase Row Level Security（数据库第二道隔离防线）
--
-- 现状：业务读写全走 service_role（旁路 RLS），隔离只靠应用层。
-- 本迁移为全部 business-scoped 表启用 RLS：
--   · service_role 全量（当前应用路径不受影响）
--   · authenticated 仅能读写 auth.uid() 对应用户所属
--     tenant_id + business_id 的行（zero crossover）
--   · anon 无策略 → 默认拒绝
-- 幂等：drop policy if exists + create policy；可反复执行。
-- ============================================================

do $$
declare
  t text;
begin
  foreach t in array array[
    'products','orders','customers','reviews','staff','business_memories',
    'reservations','inventory_items','store_qr_codes','chat_sessions',
    'chat_messages','knowledge_docs','doc_chunks','marketing_contents',
    'emails','email_accounts','email_send_tasks','alerts',
    'integration_configs','model_configs','settings','payments',
    'payment_events','integration_events','agent_actions','agent_approvals',
    'agent_tasks','agent_task_runs','agent_events','notification_outbox',
    'notifications','push_subscriptions','audit_events'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);

      execute format('drop policy if exists %I on public.%I', t || '_service_role_all', t);
      execute format('create policy %I on public.%I to service_role using (true) with check (true)',
        t || '_service_role_all', t);

      execute format('drop policy if exists %I on public.%I', t || '_auth_tenant_scope', t);
      execute format('create policy %I on public.%I to authenticated using (tenant_id = (select tenant_id from public.users where id = auth.uid())) with check (tenant_id = (select tenant_id from public.users where id = auth.uid()))',
        t || '_auth_tenant_scope', t);

      execute format('drop policy if exists %I on public.%I', t || '_auth_business_scope', t);
      execute format('create policy %I on public.%I to authenticated using (business_id = (select business_id from public.users where id = auth.uid())) with check (business_id = (select business_id from public.users where id = auth.uid()))',
        t || '_auth_business_scope', t);
    end if;
  end loop;
end $$;

-- users：登录用户只能看到/修改自己的行（自引用策略，避免子查询递归）
alter table public.users enable row level security;
drop policy if exists users_self on public.users;
create policy users_self on public.users to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists users_service_role_all on public.users;
create policy users_service_role_all on public.users to service_role
  using (true) with check (true);

-- tenants：成员可见所属租户（平台表只读面）
alter table public.tenants enable row level security;
drop policy if exists tenants_member_read on public.tenants;
create policy tenants_member_read on public.tenants to authenticated
  using (id = (select tenant_id from public.users where id = auth.uid()));
drop policy if exists tenants_service_role_all on public.tenants;
create policy tenants_service_role_all on public.tenants to service_role
  using (true) with check (true);
