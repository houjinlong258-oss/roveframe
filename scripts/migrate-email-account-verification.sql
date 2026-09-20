-- ============================================================
-- Phase 16 任务 4 —— 邮箱账号的"连接已验证"证据列
-- 幂等：add column if not exists。
--
-- 为什么需要
--   设置页保存 SMTP 账号后直接显示"已连接"，但保存时**从未连接过** ——
--   那是一个没有证据的断言（与 ERPNext"已连接"是同一类问题）。
--   修法：保存时真连一次，结果落库；UI 显示的是**上次验证结果**而不是假设。
--
-- 保留 `last_test_error` 的意义：失败时商家需要知道是认证失败、
-- 端口被拒还是域名解析不了 —— 只说"失败"没法自助修复。
-- ============================================================

alter table public.email_accounts
  add column if not exists last_test_ok boolean;

alter table public.email_accounts
  add column if not exists last_tested_at timestamptz;

alter table public.email_accounts
  add column if not exists last_test_error text;
