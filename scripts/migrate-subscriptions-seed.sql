-- ============================================================
-- Phase 16 任务 2 —— 订阅套餐种子 + 存量租户的计费归属
-- 幂等：on conflict do nothing / 显式 conflict 目标。
-- 已加入 src/lib/migration.ts 的 MIGRATION_FILES（单一事实源）。
--
-- 为什么必须有这个迁移
--   实测（Phase 15 复核）：subscription_plans / tenant_subscriptions /
--   invoices / feature_entitlements **全部 0 行**，且仓库里没有任何脚本
--   给 subscription_plans 灌过数据 ⇒ 平台无法给商家定套餐，也无从判"该不该放行"。
--
-- 为什么 id 写死
--   plan_id 必须指向**真实存在的 plan**（任务 2 的测试要求之一）。
--   写死 UUID 让代码、测试、迁移三处引用同一个值，不必先查再插。
-- ============================================================

-- ---------- 1. 套餐（价格为 USD/月；海外市场，见 AGENTS.md 用户偏好） ----------
insert into public.subscription_plans (id, slug, name, description, price_amount, currency, interval, features, is_active)
values
  (
    '00000000-0000-4000-8000-00000000f001',
    'free',
    'Free',
    'Explore the platform with one location and limited AI actions.',
    0.00, 'USD', 'month',
    '{"max_businesses":1,"max_ai_actions_per_month":50,"max_emails_per_month":0,"qr_ordering":false,"knowledge_base":true,"email_channel":false,"social_publishing":false,"support":"community"}'::jsonb,
    true
  ),
  (
    '00000000-0000-4000-8000-00000000f002',
    'starter',
    'Starter',
    'One location, full AI COO, QR ordering and marketing email.',
    29.00, 'USD', 'month',
    '{"max_businesses":1,"max_ai_actions_per_month":1000,"max_emails_per_month":2000,"qr_ordering":true,"knowledge_base":true,"email_channel":true,"social_publishing":false,"support":"email"}'::jsonb,
    true
  ),
  (
    '00000000-0000-4000-8000-00000000f003',
    'growth',
    'Growth',
    'Multi-location operators with higher AI and messaging volume.',
    99.00, 'USD', 'month',
    '{"max_businesses":5,"max_ai_actions_per_month":10000,"max_emails_per_month":20000,"qr_ordering":true,"knowledge_base":true,"email_channel":true,"social_publishing":true,"support":"priority"}'::jsonb,
    true
  ),
  (
    '00000000-0000-4000-8000-00000000f004',
    'internal',
    'Internal',
    'Platform-operated account. Not billed and not sold.',
    0.00, 'USD', 'month',
    '{"max_businesses":null,"max_ai_actions_per_month":null,"max_emails_per_month":null,"qr_ordering":true,"knowledge_base":true,"email_channel":true,"social_publishing":true,"support":"internal","internal":true}'::jsonb,
    true
  )
on conflict (id) do nothing;

-- 套餐可能已存在（有人手工插过同 slug 不同 id）：按 slug 再兜一次，避免唯一索引冲突。
-- 不覆盖已存在的行 —— 改价是运营动作，不该被迁移回滚。
insert into public.subscription_plans (id, slug, name, description, price_amount, currency, interval, features, is_active)
select v.id, v.slug, v.name, v.description, v.price_amount, v.currency, v.interval, v.features, v.is_active
from (values
  ('00000000-0000-4000-8000-00000000f001'::varchar, 'free'::varchar,     'Free'::varchar,     'Explore the platform with one location and limited AI actions.'::text, 0.00::numeric,  'USD'::varchar, 'month'::varchar, '{"max_businesses":1,"max_ai_actions_per_month":50,"max_emails_per_month":0,"qr_ordering":false,"knowledge_base":true,"email_channel":false,"social_publishing":false,"support":"community"}'::jsonb, true),
  ('00000000-0000-4000-8000-00000000f002'::varchar, 'starter'::varchar,  'Starter'::varchar,  'One location, full AI COO, QR ordering and marketing email.'::text,    29.00::numeric, 'USD'::varchar, 'month'::varchar, '{"max_businesses":1,"max_ai_actions_per_month":1000,"max_emails_per_month":2000,"qr_ordering":true,"knowledge_base":true,"email_channel":true,"social_publishing":false,"support":"email"}'::jsonb, true),
  ('00000000-0000-4000-8000-00000000f003'::varchar, 'growth'::varchar,   'Growth'::varchar,   'Multi-location operators with higher AI and messaging volume.'::text,  99.00::numeric, 'USD'::varchar, 'month'::varchar, '{"max_businesses":5,"max_ai_actions_per_month":10000,"max_emails_per_month":20000,"qr_ordering":true,"knowledge_base":true,"email_channel":true,"social_publishing":true,"support":"priority"}'::jsonb, true),
  ('00000000-0000-4000-8000-00000000f004'::varchar, 'internal'::varchar, 'Internal'::varchar, 'Platform-operated account. Not billed and not sold.'::text,             0.00::numeric,  'USD'::varchar, 'month'::varchar, '{"max_businesses":null,"max_ai_actions_per_month":null,"max_emails_per_month":null,"qr_ordering":true,"knowledge_base":true,"email_channel":true,"social_publishing":true,"support":"internal","internal":true}'::jsonb, true)
) as v(id, slug, name, description, price_amount, currency, interval, features, is_active)
where not exists (select 1 from public.subscription_plans p where p.slug = v.slug);

-- ---------- 2. 存量租户回填：状态 active 永久有效，不下"试用倒计时" ----------
-- 这里的语义必须说清楚：
--   新注册的商家走 `/api/auth/signup`，拿到的是 **trialing + 14 天**
--   （由代码显式写入 current_period_end）。
--   而**存量**租户（本平台自营锚点租户属于此类）从来不在计费范围内，
--   给它们设一个 14 天试用期会在两周后把它们自己锁成只读 —— 那不是产品行为，
--   是回填脚本造成的事故。因此存量租户一律 active、无到期日。
--
-- 该语句只在**没有订阅行**时插入，因此：
--   · 重复执行不会把已停用的租户重置为 active（on conflict do nothing）；
--   · 也不会把平台管理员刚设的 suspended 覆盖掉。
insert into public.tenant_subscriptions (tenant_id, plan_id, status, renewal_source, currency, last_payment_status)
select
  t.id,
  case
    when t.id = '00000000-0000-0000-0000-000000000000'
      then '00000000-0000-4000-8000-00000000f004'  -- 锚点租户 = 平台自营 -> internal
    else '00000000-0000-4000-8000-00000000f001'    -- 其余存量 -> free
  end,
  'active',
  'offline',
  'USD',
  'grandfathered'
from public.tenants t
on conflict (tenant_id) do nothing;

-- ---------- 2b. 孤儿订阅清理（幂等） ----------
-- 为什么必须有：迁移在 2026-09-18 首次执行时给当时存在的租户都回填了订阅
-- （实测 11 行），随后测试残留清理删掉了 10 个 tenant，**订阅行留了下来**。
-- 那是真的垃圾：它们指向不存在的租户，而且 `stripe`/`renewal` 类对账脚本
-- 按 `tenant_subscriptions` 遍历时会读到它们。
--
-- 这条语句只能删"指向不存在租户"的行 —— 不可能误删在营商家的订阅。
delete from public.tenant_subscriptions s
where not exists (select 1 from public.tenants t where t.id = s.tenant_id);

-- ---------- 3. 平台默认 entitlement（tenant_id 为 null = 全局默认） ----------
insert into public.feature_entitlements (tenant_id, feature, enabled, rollout_percent, note)
values
  (null, 'qr_ordering',          true, 100, 'Phase 16: 扫码点餐默认开放'),
  (null, 'knowledge_base',       true, 100, 'Phase 16: 知识库默认开放'),
  (null, 'email_channel',        true, 100, 'Phase 16: 邮件渠道默认开放；未绑定 SMTP 时发送会明确失败'),
  (null, 'social_publishing',    false, 0, 'Phase 16: 社交发布**尚未实现**，默认关闭以免 UI 承诺未交付的能力'),
  (null, 'erp_sync',             false, 0, 'Phase 16: ERPNext 仅连通性验证，真实同步未实现')
on conflict (coalesce(tenant_id, ''), feature) do nothing;
