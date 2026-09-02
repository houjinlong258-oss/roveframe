-- =====================================================
-- RoveFrame customer_favorites 表
-- PWA Sprint 2 起步(C-PWA-2.1)
-- 用法: 在 Supabase SQL Editor 跑(配合 scripts/migrate.sql + scripts/migrate-business-tables.sql)
--
-- 字段设计:
--   device_id varchar(64)  -- 设备指纹(SHA-256(IP+UA+lang) 或 UUID v4 in localStorage)
--                          -- V1 替代 user_id:customer 端无注册,匿名收藏
--                          -- V2 加 customer 注册后,新增 user_id 列
--   business_id varchar(36)  -- 餐厅(V1 跨 tenant 公开收藏:V1 SaaS 是按 tenant 隔离的,
--                            -- 但 customer_favorites 不需要 tenant 隔离——customer 自己选)
--                            -- 实际:customer 加了多个 tenant 的不同 business 都 OK
--                            -- 留 tenant_id 仅用于审计/管理,V1 不强制
--   unique (device_id, business_id)  -- 一台设备对一家餐厅只能收藏一次
-- =====================================================

create table if not exists public.customer_favorites (
  id varchar(36) primary key default gen_random_uuid(),
  device_id varchar(64) not null,
  business_id varchar(36) not null references public.businesses(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (device_id, business_id)
);

create index if not exists customer_favorites_device_idx
  on public.customer_favorites (device_id);

create index if not exists customer_favorites_business_idx
  on public.customer_favorites (business_id);
