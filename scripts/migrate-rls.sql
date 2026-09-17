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
--
-- ------------------------------------------------------------
-- Phase 15 修复：本文件此前**从未能成功执行**。
--
-- 实测报错（第一次真正运行它时才发现）：
--   operator does not exist: character varying = uuid   (SQLSTATE 42883)
--   in policy products_auth_tenant_scope
--
-- 根因：`auth.uid()` 返回 **uuid**，而本库所有 id/tenant_id/business_id
-- 都是 **character varying**（实测 105 列全部为 varchar，uuid 列为 0）。
-- `users.id = auth.uid()` 于是变成 varchar = uuid，Postgres 无此运算符，直接报错。
--
-- 修法：把 `auth.uid()` 显式转成 text 再比较。
-- 这也说明为什么"未执行过的迁移"本身是风险 —— 它不会在 CI 里报错，
-- 只会在第一次真正部署时炸掉。
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
      execute format('create policy %I on public.%I to authenticated using (tenant_id = (select tenant_id from public.users where id = auth.uid()::text)) with check (tenant_id = (select tenant_id from public.users where id = auth.uid()::text))',
        t || '_auth_tenant_scope', t);

      execute format('drop policy if exists %I on public.%I', t || '_auth_business_scope', t);
      execute format('create policy %I on public.%I to authenticated using (business_id = (select business_id from public.users where id = auth.uid()::text)) with check (business_id = (select business_id from public.users where id = auth.uid()::text))',
        t || '_auth_business_scope', t);
    end if;
  end loop;
end $$;

-- users：登录用户只能看到/修改自己的行（自引用策略，避免子查询递归）
alter table public.users enable row level security;
drop policy if exists users_self on public.users;
create policy users_self on public.users to authenticated
  using (id = auth.uid()::text) with check (id = auth.uid()::text);
drop policy if exists users_service_role_all on public.users;
create policy users_service_role_all on public.users to service_role
  using (true) with check (true);

-- tenants：成员可见所属租户（平台表只读面）
alter table public.tenants enable row level security;
drop policy if exists tenants_member_read on public.tenants;
create policy tenants_member_read on public.tenants to authenticated
  using (id = (select tenant_id from public.users where id = auth.uid()::text));
drop policy if exists tenants_service_role_all on public.tenants;
create policy tenants_service_role_all on public.tenants to service_role
  using (true) with check (true);
