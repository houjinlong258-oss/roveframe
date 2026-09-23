-- ============================================================
-- migrate-rls-gaps.sql — 补齐 migrate-rls.sql 未覆盖的 12 张表
--
-- ## 为什么需要这个文件（Phase 19 上线阻断项 1）
--
-- 独立审查用**项目自己的 anon key** 实测到：`delivery_orders` 的 21/21 行、
-- `delivery_positions` 16/16 行、`staff_attendance` 3/3 行、`public_sites` 1/1 行
-- 都能被匿名读走，其中含收件人姓名/电话/地址、骑手经纬度轨迹，
-- 以及一个**当前有效的点餐 token**（用它调 `/api/store/menu` 返回 200 与真实菜单）。
--
-- 本文件用只读的 `pg_policies` 复核后，发现缺口**比审查报告的 4 张更大**：
-- 未启用 RLS 的其实是 **12 张**。审查者只能看见当时**有数据**的那 4 张；
-- 另 8 张当时是空表，"anon 读到 0 行"与"RLS 拦住了"在他那里不可区分。
--
-- 根因：`scripts/migrate-rls.sql` 的表清单是**手写的 33 张**，Phase 17/18
-- 新增的表从未加进去。这与 Phase 15 §3.1 的"迁移清单漏项"是同一类缺陷 ——
-- 清单会腐烂，而腐烂是静默的。
--
-- ## 与 migrate-rls.sql 的关系
--
-- 策略命名与语义**逐字沿用** migrate-rls.sql（`<table>_service_role_all` /
-- `<table>_auth_tenant_scope` / `<table>_auth_business_scope`），
-- 这样库上的策略集合是同一个形状，`tests/rls-coverage*.test.ts` 可以按同一套
-- 规则断言。幂等：drop policy if exists + create policy。
--
-- ## 两张没有租户列的表单独处理
--
-- `customer_sessions`（顾客会话，7 列）与 `health_check`（2 列）**没有**
-- tenant_id / business_id，因此无法按租户建策略。它们**只应由 service_role 访问**：
--   · customer_sessions 里只有 token 的 sha256 摘要 —— 那是凭据材料；
--   · health_check 只有探针名与时间戳，与任何租户无关。
-- 对它们建**显式拒绝**策略（rather than 什么都不建）：把"不该被谁读"写成
-- 库里可查的事实，而不是依赖"没建策略所以默认拒绝"这个隐含行为。
--
-- ## 幂等与安全性
--
-- 全部 if not exists 语义（drop + create）与 to_regclass 存在性判断；
-- 可反复执行。本迁移**不动数据**，只改权限元数据。
-- service_role 策略保证应用路径（一律 service_role）完全不受影响。
-- ============================================================

-- ---------- 1) 有 tenant_id + business_id 的 10 张 ----------
do $$
declare
  t text;
begin
  foreach t in array array[
    -- Phase 17/18 新增：配送
    'delivery_orders','delivery_positions',
    -- Phase 17/18 新增：员工
    'staff_shifts','staff_attendance','staff_care_notes','staff_care_tasks',
    -- 顾客账号体系（含 PII：姓名/电话/地址）
    'customer_accounts','customer_addresses',
    -- 商家官网与退订名单
    'public_sites','email_unsubscribes'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);

      execute format('drop policy if exists %I on public.%I', t || '_service_role_all', t);
      execute format('create policy %I on public.%I to service_role using (true) with check (true)',
        t || '_service_role_all', t);

      -- auth.uid() 返回 uuid，而本库 id/tenant_id/business_id 全是 varchar
      -- ⇒ 必须显式 ::text（见 migrate-rls.sql 文件头的 Phase 15 记录，
      -- 当初就是 `varchar = uuid` 让那个迁移从未成功执行过）。
      execute format('drop policy if exists %I on public.%I', t || '_auth_tenant_scope', t);
      execute format('create policy %I on public.%I to authenticated using (tenant_id = (select tenant_id from public.users where id = auth.uid()::text)) with check (tenant_id = (select tenant_id from public.users where id = auth.uid()::text))',
        t || '_auth_tenant_scope', t);

      execute format('drop policy if exists %I on public.%I', t || '_auth_business_scope', t);
      execute format('create policy %I on public.%I to authenticated using (business_id = (select business_id from public.users where id = auth.uid()::text)) with check (business_id = (select business_id from public.users where id = auth.uid()::text))',
        t || '_auth_business_scope', t);
    end if;
  end loop;
end $$;

-- ---------- 2) 无租户列的两张：只允许 service_role，并显式拒绝其它角色 ----------
do $$
declare
  t text;
begin
  foreach t in array array['customer_sessions','health_check'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);

      execute format('drop policy if exists %I on public.%I', t || '_service_role_all', t);
      execute format('create policy %I on public.%I to service_role using (true) with check (true)',
        t || '_service_role_all', t);

      -- 显式拒绝：把意图写进库，而不是依赖"零策略 = 默认拒绝"这个隐含行为
      execute format('drop policy if exists %I on public.%I', t || '_deny_others', t);
      execute format('create policy %I on public.%I to anon, authenticated using (false) with check (false)',
        t || '_deny_others', t);
    end if;
  end loop;
end $$;

-- ---------- 3) 已启用 RLS 但**零策略**的 18 张：补一条显式策略 ----------
--
-- 这批表当初被单独 `enable row level security` 过，但从未建策略。今天它们
-- 恰好等于"对 anon/authenticated 全拒"，所以**当前不是漏洞**（service_role 旁路，
-- 应用路径不受影响）。那为什么还要补？
--
--   · **零策略是隐含行为，显式策略是可查事实。** 一个只看 `relrowsecurity`
--     的检查会把它们判成"已设防"，而真相是"恰好没人建策略"。这就是
--     Phase 15 §3.2 记过的那种"启用了 RLS 却零策略"的状态 —— 文档说它安全，
--     库里看不出为什么安全。
--   · 将来若有人给其中一张加策略（比如让 authenticated 读 `businesses`），
--     他会改的是"这张表有策略"这件事，而不是推翻一个隐含前提。
--
-- 处置：只补 `service_role` 全量策略 + 一条显式 deny，**不**给 authenticated
-- 开任何读面。理由逐条写明：
--   · 平台表（platform_admins / sessions / audit_logs / support_access_grants /
--     subscription_* / invoices / feature_entitlements）—— 平台管理面只经由
--     `/api/admin/*`，那些路由一律 service_role；给 authenticated 开读面等于
--     把平台账目暴露给任意登录商家。
--   · ai_usage_ledger / error_events / coding_proposals / cron_state —— 运维数据，
--     同一个理由。
--   · roles / user_roles —— 角色的权威来源是 `public.users.role`（RBAC 从那里读）。
--     这两张表若被 authenticated 读到，等于多出一个可枚举的权限面而没有收益。
--   · businesses —— 商家自己的门店。它**确实**会被商家读取，但那条路径走的是
--     service_role（`scopedTable`）。给 authenticated 开读面要先有一份
--     "按 users.business_id 过滤"的策略，而那是新的授权设计，不属于本轮
--     "补缺口"的范围。此处保持拒绝，并在 §5 记为待办。
--   · customer_favorites —— 按 device_id 分片（不是按账号），无法用 tenant 策略
--     表达；见 `src/lib/customer-identity.ts`。
do $$
declare
  t text;
begin
  foreach t in array array[
    'ai_usage_ledger','audit_logs','businesses','coding_proposals','cron_state',
    'customer_favorites','error_events','feature_entitlements','invoices',
    'platform_admin_audit_logs','platform_admin_sessions','platform_admins',
    'roles','subscription_events','subscription_plans','support_access_grants',
    'tenant_subscriptions','user_roles'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);

      execute format('drop policy if exists %I on public.%I', t || '_service_role_all', t);
      execute format('create policy %I on public.%I to service_role using (true) with check (true)',
        t || '_service_role_all', t);

      execute format('drop policy if exists %I on public.%I', t || '_deny_others', t);
      execute format('create policy %I on public.%I to anon, authenticated using (false) with check (false)',
        t || '_deny_others', t);
    end if;
  end loop;
end $$;

-- ---------- 4) 自检：把结果打成一条可读的 notice，便于部署时确认 ----------
--
-- 自检覆盖**两个**条件，而不是只看 relrowsecurity：
--   1. public schema 里没有未启用 RLS 的表；
--   2. 启用 RLS 的表都有至少一条策略。
-- 第二条是关键：只查第一条会把"启用了但零策略"判成通过 —— 而那正是本文件
-- 存在的原因，也是 Phase 15 栽过的那一跤。写在这里是为了让部署时就能看见。
do $$
declare
  uncovered text;
  policyless text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into uncovered
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false;

  select string_agg(c.relname, ', ' order by c.relname) into policyless
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = true
    and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname);

  if uncovered is null and policyless is null then
    raise notice 'RLS 自检通过：public schema 全部表均已启用 RLS，且每张表都有策略';
  else
    if uncovered is not null then
      raise warning 'RLS 自检：未启用 RLS 的表 -> %', uncovered;
    end if;
    if policyless is not null then
      raise warning 'RLS 自检：启用了 RLS 但零策略的表 -> %', policyless;
    end if;
  end if;
end $$;
