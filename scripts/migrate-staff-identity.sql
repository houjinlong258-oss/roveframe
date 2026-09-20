-- ---------------------------------------------------------------------------
-- Phase 18 / P18-1 —— 员工账号与员工档案的关联
--
-- 现状问题（实测）：`users`（登录账号）与 `staff`（员工档案）之间**没有任何字段相连**。
-- 因此"这个登录的人对应哪条员工记录"无从查起 —— 员工端的排班、考勤、外卖派单
-- 全部没有归属可言。这是后面所有员工功能的前置条件。
--
-- 刻意**不加外键**：`users` 行可能先于员工档案被删除（离职后销号），
-- 外键会把"删账号"变成不可操作。关联有效性由读取侧判定 ——
-- `GET /api/staff/me` 查不到档案时返回 409，而不是 200 + 空对象。
--
-- 幂等：add column if not exists / create index if not exists。
-- ---------------------------------------------------------------------------

alter table public.staff add column if not exists user_id varchar(36);

-- 一个账号只能绑一条员工档案。部分索引：未关联（null）的行不受约束，
-- 否则第二个未关联员工会撞唯一键。
create unique index if not exists staff_user_id_key
  on public.staff (user_id) where user_id is not null;

create index if not exists staff_user_idx
  on public.staff (tenant_id, business_id, user_id);
