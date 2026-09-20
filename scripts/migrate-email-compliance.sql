-- ============================================================
-- Phase 16 任务 4 —— 群发邮件合规：退订能力
-- 幂等：create table if not exists / add column if not exists。
-- 已加入 src/lib/migration.ts 的 MIGRATION_FILES。
--
-- 为什么必须有这张表
--   实测：外发链路（src/lib/email/outgoing.ts）只设置 from/to/subject/text，
--   没有退订链接、没有 List-Unsubscribe 头、没有 opt-in 记录、也没有任何过滤。
--   欧美市场（CAN-SPAM / GDPR / PECR）对批量商业邮件的硬要求是
--   "收件人必须能退订，且退订必须被持续遵守"。缺这一项不是"功能没做"，
--   是这个功能**不能合法使用** —— 所以它挡住的是收入，不是体验。
--
-- 为什么用 (tenant_id, business_id, email) 而不是 customer_id
--   外发表（email_send_tasks）只有 `to_addr` 文本，没有 customer_id。
--   能否退订是**地址**的属性（同一个邮箱可能同时是客户与供应商联系人），
--   挂在地址上才对得上"这封信发给谁"。
-- ============================================================

create table if not exists public.email_unsubscribes (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null,
  business_id varchar(36) not null,
  -- 统一小写存储：地址的大小写不改变收件人身份（RFC 5321 local-part 理论上区分，
  -- 但现实中没有邮件服务商这样用；不归一化会造成"换个大小写就能继续发"的绕过）
  email varchar(255) not null,
  token varchar(64) not null,
  reason varchar(40) not null default 'link',     -- link / reply / manual / complaint
  source varchar(40),                              -- 触发退订的入口，便于排查
  unsubscribed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- 同一地址在同一商户下只能有一条退订记录
create unique index if not exists email_unsubscribes_addr_key
  on public.email_unsubscribes (tenant_id, business_id, lower(email));

-- 链接里的 token 必须能反查到唯一一条记录
create unique index if not exists email_unsubscribes_token_key
  on public.email_unsubscribes (token);

create index if not exists email_unsubscribes_tenant_idx
  on public.email_unsubscribes (tenant_id, business_id, unsubscribed_at desc);

-- ---------- 出件任务记住它那一封信用的退订令牌 ----------
-- 出件是异步的（scheduler worker），退订链接必须在**入队时**就定稿，
-- 因此令牌随任务落库，而不是发送时现算（现算意味着同一封信重试会换令牌）。
alter table public.email_send_tasks
  add column if not exists unsubscribe_token varchar(64);

alter table public.email_send_tasks
  add column if not exists unsubscribe_url text;

-- ---------- 订单幂等指纹（Phase 16 任务 5） ----------
-- 为什么需要单独一列：`external_id` 存的是 Idempotency-Key，只能回答
-- "这个 key 用过吗"，**回答不了"是不是同一张单"**。
-- 从订单内容（items/tip/table_no）反推指纹是不可靠的 —— 初版就这么做，
-- 结果把合法重试误判成冲突（请求里的 items 没有 name 字段，永远拼不出库里的样子）。
-- 落库一个权威指纹，比较就是一次字符串相等。
alter table public.orders
  add column if not exists idempotency_fingerprint varchar(128);
