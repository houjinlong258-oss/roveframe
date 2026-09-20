-- ---------------------------------------------------------------------------
-- Phase 19 —— 顾客账号体系（顾客端 PWA 的账号后端）
--
-- 背景：顾客端此前**没有账号**。唯一身份是 `roveframe_device_id` cookie
-- （src/lib/customer-identity.ts:16），清一次浏览器数据就丢失收藏与历史订单；
-- 而 `orders` 表虽然早就有 `customer_id` 列，它指的是商家侧的 CRM 客户
-- （`customers` 表，商家自己维护的名单），顾客本人无法登录、也读不到自己的单。
--
-- 因此这里建的是**顾客侧**的三张表，与商家的 `users` / `customers` 完全分开：
--   顾客账号不参与 RBAC，不带 role，不进 `users`（否则顾客会出现在员工列表里）。
--
-- 三张表的分工：
--   customer_accounts   一个顾客在一个商家下的账号。password_hash/salt 见 src/lib/customer-auth.ts
--   customer_sessions   会话。**只存 sha256(token)**，原 token 只存在于浏览器 cookie 里
--   customer_addresses  收货地址簿（上限 10 条在代码侧强制，见 api/customer/addresses）
--
-- 为什么租户/商家列在顾客表上而不是靠 account 间接推导：
--   本表的三条唯一索引都带 (tenant_id, business_id) —— 同一个手机号在 A 商家和
--   B 商家是两个互不相干的账号（顾客在不同店铺是不同的人，合并会被当成跨租户数据泄漏）。
--
-- 幂等：全部 create ... if not exists，可重复执行。
-- ---------------------------------------------------------------------------

create table if not exists public.customer_accounts (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null,
  business_id varchar(36) not null,

  -- 邮箱与手机号都可为空，但至少一个必须存在（写入侧强制，见 api/customer/auth/register）
  email varchar(255),
  phone varchar(40),

  -- scrypt(password, salt, 64)：salt / hash 都是 hex。列名沿用仓库既有命名，
  -- password_hash 是 text 而不是定长，便于日后调整 scrypt 参数或摘要长度。
  password_hash text not null,
  password_salt varchar(64) not null,

  display_name varchar(80),
  -- en | zh | es（与 next-intl 的三语一致）；默认 en 对齐面向海外市场的定位
  locale varchar(5) not null default 'en',
  marketing_opt_in boolean not null default false,
  -- active | disabled。禁用后 resolveCustomerSession 一律拒绝（fail-closed）
  status varchar(20) not null default 'active',
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

-- 邮箱唯一性按 lower(email)：否则 Foo@x.com 与 foo@x.com 会变成两个账号，
-- 而登录时只会命中其中一条，用户看到的是"密码明明是对的却登不上"。
-- 部分索引（where email is not null）：允许大量只有手机号的账号。
create unique index if not exists customer_accounts_email_key
  on public.customer_accounts (tenant_id, business_id, lower(email))
  where email is not null;

create unique index if not exists customer_accounts_phone_key
  on public.customer_accounts (tenant_id, business_id, phone)
  where phone is not null;

create table if not exists public.customer_sessions (
  id varchar(36) primary key default gen_random_uuid(),
  account_id varchar(36) not null,

  -- sha256(token) 的 hex（64 字符）。**原始 token 不落库**：
  -- 库被读走时，攻击者拿到的是摘要，无法直接当会话用。
  token_hash varchar(64) not null,

  expires_at timestamptz not null,
  -- 登出即写 revoked_at（软删，保留审计痕迹），不物理删除
  revoked_at timestamptz,
  user_agent varchar(240),
  created_at timestamptz not null default now()
);

-- 按 cookie 里的 token 反查会话是每个鉴权请求的热路径，必须唯一且走索引
create unique index if not exists customer_sessions_token_hash_key
  on public.customer_sessions (token_hash);

-- 会话清理/统计（按账号找未过期会话）
create index if not exists customer_sessions_account_expiry_idx
  on public.customer_sessions (account_id, expires_at);

create table if not exists public.customer_addresses (
  id varchar(36) primary key default gen_random_uuid(),
  account_id varchar(36) not null,
  tenant_id varchar(36) not null,
  business_id varchar(36) not null,

  label varchar(40),
  recipient_name varchar(80) not null,
  recipient_phone varchar(40) not null,
  address_line varchar(240) not null,
  address_note varchar(240),
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists customer_addresses_account_idx
  on public.customer_addresses (account_id);
