-- ---------------------------------------------------------------------------
-- Phase 18 —— 老板端「员工 / 考勤 / 关怀」的存储
--
-- 设计要点（为什么这样做，而不是另一种做法）：
--
-- 1. `staff` 的档案列用 `add column if not exists` 逐条补。
--    本库的历史是「列会漂移」：schema.ts 定义了 `.default()` 的列，
--    用户库里可能既没有该列也没有默认值（见 AGENTS.md 陷阱 12）。
--    逐条 add column 的好处是**重复执行安全**，且能对老库增量补齐；
--    代价是必须保证每条都有 `default` 或可空 —— 否则已有行会被违反非空约束。
--
-- 2. **不加外键**。与 scripts/migrate-staff-identity.sql、scripts/migrate-workforce.sql
--    同一口径：员工离职销号时 `staff` 行可能先消失，外键会把"删员工"变成不可操作。
--    记录的有效性由读取侧判定（查不到即空列表），不靠级联删除兜底。
--
-- 3. `staff_care_notes.content` 是**隐私数据**：它的可见范围（只有作者与当事人）
--    无法用权限矩阵表达，必须在查询里强制（见 src/app/api/team/care/notes/route.ts）。
--    本文件只负责存储，不提供任何"按 tenant 就能读到全部"的视图或宽松 RLS 策略。
--
-- 4. 本文件的 DDL 全部幂等（add column if not exists / create table if not exists /
--    create [unique] index if not exists），可重复执行。
-- ---------------------------------------------------------------------------

-- ---------- 员工档案列（排班 / 考勤 / 关怀 / 邀请都需要它们） ----------
alter table public.staff add column if not exists phone varchar(40);
alter table public.staff add column if not exists email varchar(255);
alter table public.staff add column if not exists position varchar(60);
alter table public.staff add column if not exists employment_type varchar(20) not null default 'full_time';
alter table public.staff add column if not exists hourly_rate numeric(10,2);
alter table public.staff add column if not exists hired_at date;
alter table public.staff add column if not exists birthday date;
alter table public.staff add column if not exists emergency_contact varchar(160);
alter table public.staff add column if not exists status varchar(20) not null default 'active';

-- 排班表与考勤表由 scripts/migrate-workforce.sql 创建（本文件只读它们，不重复建）。
-- 之所以在这里再声明一次是为了让"关怀信号的输入从哪来"可查：
--   staff_shifts     (tenant_id, business_id, staff_id, starts_at, ends_at, ...)
--   staff_attendance (tenant_id, business_id, staff_id, clock_in_at, clock_out_at, ...)

-- ---------- 关怀记录（一对一谈话 / 观察 / 支持记录） ----------
create table if not exists public.staff_care_notes (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null,
  business_id varchar(36) not null,
  staff_id varchar(36) not null,
  -- 作者。可见性规则的一半：只有作者本人能读自己写的记录。
  author_user_id varchar(36) not null,
  -- one_on_one | observation | support | follow_up（白名单在代码里，不用 check 约束：
  -- 状态机/类型演进不应要求 DDL，与仓库既有做法一致）
  kind varchar(30) not null default 'one_on_one',
  content text not null,
  -- private | shared_with_subject。**刻意不用它放宽读取**：
  -- 无论取何值，内容都只对"作者"和"当事人"可见（见 notes 路由）。
  -- 保留该列是为了将来在同一规则下区分展示方式，而不是用来扩大读者集合。
  visibility varchar(20) not null default 'private',
  created_at timestamptz not null default now()
);

-- 关怀记录的读取永远是"某个人 + 时间倒序"，desc 与查询口径一致，避免额外排序。
create index if not exists staff_care_notes_subject_idx
  on public.staff_care_notes (tenant_id, business_id, staff_id, created_at desc);

-- 作者视角的读取（"我写过哪些记录"）也需要一条索引：没有它，
-- 作者分支会退化成按 tenant 全表扫描再过滤。
create index if not exists staff_care_notes_author_idx
  on public.staff_care_notes (tenant_id, business_id, author_user_id, created_at desc);

-- ---------- 关怀待办（由信号计算生成，由人决定接受 / 忽略） ----------
create table if not exists public.staff_care_tasks (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null,
  business_id varchar(36) not null,
  staff_id varchar(36) not null,
  -- birthday | rest | overtime | long_shift | anniversary | missing_punch
  kind varchar(40) not null,
  title varchar(160) not null,
  detail varchar(600),
  due_at timestamptz,
  -- open | accepted | dismissed
  status varchar(20) not null default 'open',
  -- agent | manager：谁提出的（信号任务是**建议**，不是判定）
  suggested_by varchar(20) not null default 'agent',
  -- computeSignals() 产出的确定性去重键
  signal_key varchar(120),
  decided_by varchar(36),
  decided_at timestamptz,
  decision_note varchar(240),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 这条**部分唯一索引**是"每日信号任务幂等"的全部依据。
--
-- 为什么必须有它，而不是在代码里"先查有没有再插入"：
--   信号计算会由定时任务与「立即计算」按钮**同时**触发（以及多实例重叠 tick）。
--   "先查再插"在并发下必然漏：两个请求都查到"没有"，然后都插入 —— 结果同一个人
--   的同一件事出现两条待办，老板看到重复，点掉一条另一条还在。
--   唯一索引把这件事从"可能出现重复、之后不确定"变成"数据库直接拒绝第二条"。
--
-- 为什么是 `where signal_key is not null`：
--   手工创建 / 人工补录的待办没有 signal_key（null），它们不该被去重 ——
--   部分索引让这些行完全不参与唯一性判定。
--
-- 为什么 key 里带期间（如 birthday:<staffId>:<YYYY>）：
--   去重粒度就是"这件事在这个期间只提一次"。带期间，生日明年会重新提；
--   不带期间，同一条待办会永远占位，信号再也不出现。
--
-- 路由侧用 `upsert(..., { onConflict: 'tenant_id,business_id,signal_key', ignoreDuplicates: true })`
-- 撞的正是这条索引（PostgREST 据此发出 `on conflict (...) do nothing`）。
-- 因此**该索引的列集合与顺序变更是破坏性的**：改了它，插入语句会从
-- "静默跳过重复"变成"直接报错"，而症状只出现在并发/重复计算时。
-- ---------------------------------------------------------------------------
create unique index if not exists staff_care_tasks_signal_key
  on public.staff_care_tasks (tenant_id, business_id, signal_key)
  where signal_key is not null;

-- 待办列表永远是"本店 + 状态 + 到期时间"，desc/asc 与查询口径一致。
create index if not exists staff_care_tasks_open_idx
  on public.staff_care_tasks (tenant_id, business_id, status, due_at);

-- ---------------------------------------------------------------------------
-- Phase 18 补：settings.wellbeing。
--
-- 这是**补一个真实缺陷**，不是新功能。员工偏好接口
-- （src/app/api/staff/preferences/route.ts）读写 settings.wellbeing 存个人开关，
-- 但此前**没有任何迁移创建这一列** —— 它的文件头注释还写着"该列在库里已经存在"，
-- 而实测（scripts/_probe_p18_state.mts 对真实库）显示它不存在。
--
-- 之所以放在本文件而不是 delivery-orders：delivery 对应 settings.delivery，
-- wellbeing 属于员工关怀这条线，与 care 表同源。
-- ---------------------------------------------------------------------------

alter table public.settings
  add column if not exists wellbeing jsonb not null default '{}'::jsonb;
