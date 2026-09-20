-- ---------------------------------------------------------------------------
-- Phase 17 — 商户官网（Agent 按店铺信息生成，公开可访问）
--
-- 背景：平台此前**没有**任何对外的商户站点。唯一的公开面是
-- `/{locale}/store`（点餐 H5），而它必须携带一个不透明二维码 token
-- （src/lib/storefront.ts:16 —— `store_qr_codes.public_token` 且 is_active）。
-- 一个从搜索引擎/名片进来的访客既没有 token，也没有桌号，于是无处可去。
--
-- 本表把"一个商家 = 一个官网"落成数据：
--   slug           路径 /site/<slug> 与 <slug>.<SITE_DOMAIN> 的解析键
--   enabled        草稿/发布开关。未发布 = 404，而不是"半成品对外可见"
--   content/theme  Agent 写出的分区文案与配色（jsonb，改版不需要 DDL）
--   custom_domain  商家自带域名；domain_status 驱动证书签发的放行判断
--   web_order_token 复用点餐 H5 的"网页桌号"token
--
-- 幂等：全部 create ... if not exists，可重复执行。
-- ---------------------------------------------------------------------------

create table if not exists public.public_sites (
  id uuid primary key default gen_random_uuid(),
  tenant_id varchar(36) not null,
  business_id varchar(36) not null,

  -- 小写字母/数字/连字符，2..63 字符。正则同时在代码侧校验（src/lib/public-site.ts）。
  slug varchar(63) not null,

  enabled boolean not null default false,

  tagline text not null default '',
  about text not null default '',

  -- [{ id, kind, heading, body }]，kind ∈ hero|about|menu|hours|gallery|reviews|contact|cta
  sections jsonb not null default '[]'::jsonb,
  -- { primary, accent, surface, font }
  theme jsonb not null default '{}'::jsonb,
  -- { title, description }
  seo jsonb not null default '{}'::jsonb,
  -- { phone, email, address, hours }
  contact jsonb not null default '{}'::jsonb,

  custom_domain varchar(253),
  -- none | pending_dns | issuing | active | error
  domain_status varchar(32) not null default 'none',
  domain_error text,

  -- 点餐 H5 的入口 token：官网"立即下单"直接跳到 /{locale}/store?token=<它>，
  -- 因此点餐页面与落单链路**一行都不用改**。
  web_order_token varchar(64),

  -- 生成来源，用于回答"这份文案是 AI 写的还是人改过的"
  generated_by varchar(32) not null default 'agent',
  generated_at timestamptz,

  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 一个商家只有一个官网
create unique index if not exists public_sites_tenant_business_key
  on public.public_sites (tenant_id, business_id);

-- slug 是公开解析键，必须全局唯一
create unique index if not exists public_sites_slug_key
  on public.public_sites (slug);

-- 自定义域名全局唯一；未绑定时允许多行为 NULL
create unique index if not exists public_sites_custom_domain_key
  on public.public_sites (custom_domain)
  where custom_domain is not null;

-- 证书签发的询问路径按 host 查（Caddy on_demand_tls.ask → /api/site/authorize）
create index if not exists public_sites_domain_status_idx
  on public.public_sites (custom_domain, domain_status);
