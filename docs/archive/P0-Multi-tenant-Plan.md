#  P0 多租户改造 · 实施计划

> 目标：把 RoveFrame 从「单商户 SaaS」改造成「多租户 AI 商业系统平台底座」。
> 对应技术白皮书 §2/§7/§9，Sprint S1–S4。
> 这份是**落地前的改动方案**，供 review，确认后再执行。

***

## 1. 目标与范围

**改造后**：

```
RoveFrame Cloud
 ├─ Tenant A（餐厅）
 ├─ Tenant B（美容院）
 └─ Tenant C（零售店）
```

**范围**：新增 5 张平台表 + 全业务表加 `tenant_id` + 租户隔离 + 权限 + 审计。
**不动**：现有功能逻辑（商品/订单/小费/AI COO 等），只在其数据层加租户维度。

***

## 2. 数据模型

### 2.1 新增平台表

```sql
-- 租户（企业账号级）
create table public.tenants (
  id varchar(36) primary key default gen_random_uuid(),
  name varchar(128) not null,
  slug varchar(64) unique not null,
  plan varchar(20) not null default 'free',
  status varchar(20) not null default 'active',
  created_at timestamptz not null default now()
);

-- 企业实体（一个租户可多门店/品牌）
create table public.businesses (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null references tenants(id),
  name varchar(128) not null,
  industry varchar(30) not null default 'restaurant',
  location varchar(128),
  language varchar(8) not null default 'en',
  currency varchar(8) not null default 'USD',
  brand_style jsonb not null default '{}',
  schema_config jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- 用户（登录者）
create table public.users (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null references tenants(id),
  business_id varchar(36) references businesses(id),
  email varchar(255) not null,
  name varchar(128),
  created_at timestamptz not null default now()
);

-- 角色
create table public.roles (
  id varchar(36) primary key default gen_random_uuid(),
  name varchar(30) not null,
  permissions jsonb not null default '[]'
);

-- 用户-角色
create table public.user_roles (
  user_id varchar(36) not null references users(id),
  role_id varchar(36) not null references roles(id),
  primary key (user_id, role_id)
);

-- 审计日志
create table public.audit_logs (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null,
  actor_id varchar(36),
  action varchar(40) not null,
  entity varchar(40) not null,
  entity_id varchar(36),
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
```

### 2.2 全业务表加 `tenant_id`

现有 22 张业务表全部增加：

```sql
alter table public.products add column if not exists tenant_id varchar(36);
alter table public.orders add column if not exists tenant_id varchar(36);
alter table public.customers add column if not exists tenant_id varchar(36);
alter table public.reviews add column if not exists tenant_id varchar(36);
-- ... 其余表同理（staff / inventory_items / reservations / store_qr_codes /
--     chat_sessions / chat_messages / knowledge_docs / doc_chunks /
--     marketing_contents / emails / email_accounts / email_send_tasks /
--     alerts / integration_configs / model_configs / business_memories / settings）
```

> 迁移策略：先加**可空**列 → 用默认租户回填现有数据 → 再决定是否 `not null`。
> 见 §6 迁移步骤。

***

## 3. 租户隔离策略（关键取舍）

### 现状

当前后端用 `service_role_key` 直连 Supabase（无用户态 Auth）。**`service_role`** **会绕过 RLS**，所以：

- 只靠 RLS 并不能真隔离（service\_role 无视 RLS）。

- 因此 **P0 采用「应用层 tenant 过滤器」为主，RLS 为长期目标**。

### 3.1 应用层过滤（P0 立即生效）

封装一个 tenant 感知的数据访问层：

```ts
// lib/tenant.ts
export async function getTenantContext(request: Request) {
  // 从 JWT claim / X-Tenant-Id 头 解析 tenant_id
  return { tenantId: resolveTenantId(request) };
}

// 所有「读」自动带上 .eq('tenant_id', tenantId)
// 所有「写」自动在 insert/update 里注入 tenant_id
```

改造点：把散落在各 route 里的 `getSupabaseClient().from('products')...` 收口到一个带 tenant 过滤的 helper，
而不是在所有 route 逐一手写 `where tenant_id`（易漏）。

### 3.2 RLS（长期目标，P0 同步铺好策略）

即使现在 service\_role 绕过 RLS，也把策略建好，为将来切到「用户 JWT」铺路：

```sql
alter table public.products enable row level security;
create policy tenant_isolation on public.products
  using (tenant_id = current_setting('request.jwt.claims', true)::jsonb->>'tenant_id');
-- 其余表同理
```

***

## 4. 后端改造点

1. **Auth 接入**（S2）：Supabase Auth 注册/登录；JWT 里注入 `tenant_id` claim。
2. **数据访问收口**：新增 `lib/tenant-db.ts`，封装 `list/create/update/remove` 统一带 tenant 过滤 + 写 audit\_log。
3. **写审计**：所有 mutation 走统一 helper，自动落 `audit_logs`（before/after）。
4. **AI 上下文**：`business-context.ts` / `memory.ts` / `skills.ts` 均按当前 tenant/business 取数。
5. **settings 单行 → 多租户**：`settings` 表由「单行」改为「按 business\_id 多行」；`getSettings()` 加 tenant 维度。

***

## 5. 前端改造点

1. **路由结构**：`/[locale]/[tenant]/...` 或继续 `/[locale]` + 会话内 tenant 上下文（多租户后由登录态决定）。
2. **角色渲染**：Owner/Manager/Staff 三档，按权限控制菜单与操作按钮显隐。
3. **登录/邀请**：老板注册 → 自动建 tenant+business；邀请店长/员工。

***

## 6. 迁移步骤（可回滚）

1. 建 5 张平台表（§2.1）。
2. 建默认租户 + 默认 business，把现有「四川人家」数据 `tenant_id` 回填到该默认租户。
3. 全业务表加 `tenant_id`（可空）并回填。
4. 数据访问层改造 + 逐模块验证。
5. 加 RLS 策略（不影响 service\_role 运行）。
6. Auth 接上，切换前端到登录态。

**回滚**：全程 additive（只加列/加表，不改旧列语义），任一步可单独回退。

***

## 7. 任务拆解（对应白皮书 S1–S4）

| Sprint | 交付                                                                     |
| ------ | ---------------------------------------------------------------------- |
| S1     | tenants/businesses/users/roles/audit\_logs 建表 + 全表 tenant\_id + 回填默认租户 |
| S2     | Supabase Auth 接入 + JWT tenant claim + 登录/邀请                            |
| S3     | RBAC 权限 + 前端角色渲染 + 数据访问层收口                                             |
| S4     | Audit Log 写入切面 + 审计查询页 + 全量回归                                          |

***

## 8. 风险与注意事项

- **最大风险**：数据访问收口不彻底 → 出现「忘带 tenant 过滤」的漏查询，导致跨租户泄露。
  缓解：P0 阶段**统一 helper + 代码评审强制**，禁止散写 `.from()`。

- **AI 记忆/知识库**要按 tenant 隔离，避免跨企业串味。

- **settings 单行 → 多行**是隐性兼容点，`lib/settings.ts` 缓存需改。

***

*本文档 review 通过后，按 S1 开始执行。*
