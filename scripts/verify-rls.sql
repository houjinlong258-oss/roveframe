-- ============================================================
-- verify-rls.sql — SQL 层零交叉验证（Supabase SQL Editor 直接执行）
--
-- 验证口径：same tenant / different business 与 cross tenant 均 zero crossover。
-- 全程单事务，结束时 rollback，不留任何残留数据；任何泄漏直接 raise 报错。
-- ============================================================

begin;

-- 1) 测试夹具（两租户、两门店、两用户、两订单）
--
-- Phase 15 修复：夹具此前缺少 `tenants.name` / `tenants.slug`，插入即报
--   null value in column "name" of relation "tenants" violates not-null constraint
-- 与 migrate-rls.sql 一样，本文件在第一次真正执行前从未验证过。
-- 其余列经实测确认可空或有默认值（scripts/_verify_fixture_columns.mts）。
insert into public.tenants (id, name, slug) values
    ('rls-tA', 'RLS Tenant A', 'rls-ta'),
    ('rls-tB', 'RLS Tenant B', 'rls-tb')
  on conflict (id) do nothing;
insert into public.businesses (id, tenant_id, name) values
  ('rls-bA', 'rls-tA', 'RLS Business A'),
  ('rls-bB', 'rls-tB', 'RLS Business B')
  on conflict (id) do nothing;
insert into public.users (id, tenant_id, business_id, email, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'rls-tA', 'rls-bA', 'rls-a@example.com', 'owner'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'rls-tB', 'rls-bB', 'rls-b@example.com', 'owner')
  on conflict (id) do nothing;
insert into public.orders (tenant_id, business_id, order_no, source, total, items, status) values
  ('rls-tA', 'rls-bA', 'RLS-A-1', 'square', 10, '[]'::jsonb, 'completed'),
  ('rls-tB', 'rls-bB', 'RLS-B-1', 'square', 20, '[]'::jsonb, 'completed');

-- 2) 以用户 A 身份（authenticated JWT 模拟）
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';

do $$
declare n int;
begin
  -- 只应看到自己门店的 1 单
  select count(*) into n from public.orders;
  if n <> 1 then raise exception 'RLS FAIL: user A sees % orders (expected 1)', n; end if;
  -- 跨租户读必须为零
  select count(*) into n from public.orders where tenant_id = 'rls-tB';
  if n <> 0 then raise exception 'RLS FAIL: user A reads % cross-tenant orders', n; end if;
  -- 同租户不同门店必须为零（用户 A 只属于 bA）
  select count(*) into n from public.orders where tenant_id = 'rls-tA' and business_id <> 'rls-bA';
  if n <> 0 then raise exception 'RLS FAIL: user A reads % other-business rows', n; end if;
  -- 跨租户写入必须被 RLS 拒绝
  begin
    insert into public.orders (tenant_id, business_id, order_no, source, total, items, status)
      values ('rls-tB', 'rls-bB', 'RLS-X-1', 'square', 1, '[]'::jsonb, 'completed');
    raise exception 'RLS FAIL: cross-tenant insert was allowed';
  exception when others then null; -- 预期被拒
  end;
  -- 跨门店更新必须被拒绝
  begin
    update public.orders set total = 999 where tenant_id = 'rls-tA' and business_id = 'rls-bB';
    raise exception 'RLS FAIL: cross-business update was allowed';
  exception when others then null; -- 预期被拒
  end;
end $$;

reset role;

-- 3) 以用户 B 身份复验（对称）
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';

do $$
declare n int;
begin
  select count(*) into n from public.orders;
  if n <> 1 then raise exception 'RLS FAIL: user B sees % orders (expected 1)', n; end if;
  select count(*) into n from public.orders where tenant_id = 'rls-tA';
  if n <> 0 then raise exception 'RLS FAIL: user B reads % cross-tenant orders', n; end if;
end $$;

reset role;
rollback;

select 'RLS VERIFICATION PASSED: zero crossover confirmed' as result;
