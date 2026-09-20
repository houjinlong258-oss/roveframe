-- ---------------------------------------------------------------------------
-- Phase 18 —— 员工端排班（staff_shifts）与考勤（staff_attendance）
--
-- 设计要点：
--
-- 1. **两张表都带 tenant_id + business_id**，与 Phase 18 既有表
--    （staff / delivery_orders）一致。员工端接口一律按会话解析出的
--    tenant + business 过滤 —— 只有 tenant 过滤时，"同一老板的第二家店"
--    会与第一家店的数据混在一起。
--
-- 2. **刻意不加外键**。与 scripts/migrate-staff-identity.sql 同一口径：
--    员工离职销号时 staff 行可能先消失，外键会把"删员工"变成不可操作；
--    记录的有效性由读取侧判定（查不到即 409 / 空列表），不靠级联删除兜底。
--
-- 3. `staff_attendance_open_key` 是**本文件存在的核心**。
--    员工端打卡是一个按钮、不传方向（Phase 18 Frontend Spec §5.3），
--    重复点击、弱网重发、两个标签页同时点，都会并发到达。
--    没有这条**部分唯一索引**，两条"未签退"记录会同时落库 ——
--    之后任何"我现在是否已打卡"的查询都失去唯一答案，
--    而这是偶发的，测试环境几乎复现不出来。
--    有它之后，并发的第二条 INSERT 必然撞 23505，路由把它翻译成
--    409 already_open，语义与结果都确定。
--
-- 4. 幂等：create table if not exists / create index if not exists。
--    gen_random_uuid() 需要 pgcrypto 扩展（Supabase 默认已启用，见 scripts/migrate.sql 首行）。
-- ---------------------------------------------------------------------------

-- ---------- 排班 ----------
create table if not exists public.staff_shifts (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null,
  business_id varchar(36) not null,
  staff_id varchar(36) not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  role varchar(60),
  note varchar(240),
  created_by varchar(36),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 员工端"我的排班"：按 (tenant, business, 时间窗) 取，再按 staff_id 收敛到本人。
create index if not exists staff_shifts_window_idx
  on public.staff_shifts (tenant_id, business_id, starts_at);

-- ---------- 考勤 ----------
create table if not exists public.staff_attendance (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null,
  business_id varchar(36) not null,
  staff_id varchar(36) not null,
  -- 关联班次，可为空：允许"没有排班也打卡"（临时顶班是常态）。
  -- 刻意不加外键（见文件头第 2 条）。
  shift_id varchar(36),
  clock_in_at timestamptz not null default now(),
  clock_out_at timestamptz,
  -- 打卡来源：staff_pwa（员工自助）| manager_fix（店长补卡，必须写审计）。
  -- 补卡只能由老板端做，员工端不提供 —— 来源列是这条边界的可查证据。
  clock_in_source varchar(20) not null default 'staff_pwa',
  note varchar(240),
  created_at timestamptz not null default now()
);

-- 员工端考勤列表：按本人 + 时间倒序。desc 与查询口径一致，避免额外排序。
create index if not exists staff_attendance_staff_time_idx
  on public.staff_attendance (tenant_id, business_id, staff_id, clock_in_at desc);

-- ---------------------------------------------------------------------------
-- 并发保护：**一名员工同一时刻最多只能有一条"未签退"记录**。
--
-- 部分唯一索引只约束 clock_out_at is null 的行；已签退的历史行不参与，
-- 因此同一天可以有多条完整的打卡记录（早班 + 晚班）。
--
-- 这条索引不是优化，是**正确性约束**：它把"重复打卡"从
-- "可能出现两条开放记录、之后行为不确定"变成"数据库直接拒绝第二条"。
-- ---------------------------------------------------------------------------
create unique index if not exists staff_attendance_open_key
  on public.staff_attendance (staff_id) where clock_out_at is null;
