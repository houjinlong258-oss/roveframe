# P0 · S2 接线清单（Auth + 租户上下文）

> 前置：S1 的建表 DDL 已在 `src/lib/migration.ts` 就位（`tenants/businesses/users/roles/user_roles/audit_logs` + 全表 `tenant_id`）。
> 本清单聚焦 S2：接入 Supabase Auth、注入 tenant claim、升级 `getTenantContext`，并列出逐路由接线点。
> 供 review，确认后再逐项执行。

---

## 0. 关键决策（先定这个，否则后面全跑偏）

**从 service_role 切到「用户 JWT」是 S2 的核心。** 现状后端用 `service_role`（绕过 RLS、无用户态），多租户隔离依赖应用层 `tenant_id` 过滤。

- **S2 目标**：引入 Supabase Auth，登录后前端拿到的 **access_token（用户 JWT）** 带 `app_metadata.tenant_id`，后端据此解析租户。
- **RLS**：将来启用 RLS 时，用用户 JWT（非 service_role）访问才会真正生效；service_role 仍绕过 RLS，仅用于服务端内部任务（scheduler、seed）。

若你暂时不想动「用户 JWT + RLS」的复杂度，可以先只做「应用层 tenant 过滤」（S3 的数据访问层收口），Auth 仅做登录拿到 tenant_id 存 header。本清单按「完整版」写，可选精简用 `※` 标注。

---

## Part A — Supabase Auth 配置（一次性，控制台操作）

1. Authentication → Providers → **Email** 开启（或 OTP/OAuth 按需）。
2. 确认 `auth.users`（内置表）可写；我们的 `public.users` 通过 `id = auth.users.id` 关联。
3. 站点 URL / Redirect URLs 配置好（用于登录回调）。

---

## Part B — Auth 端点（新增）

```
POST /api/auth/signup   注册 → 建 auth 用户 + tenant + business + public.users
POST /api/auth/login    登录 → 返回 access_token（含 tenant claim）
POST /api/auth/me       解析当前用户 + 租户 + 角色
POST /api/auth/invite   老板邀请店长/员工（发邀请邮件，可后续接邮件通道）
```

关键点：`signup` 里用 `supabase.auth.admin.createUser({ app_metadata: { tenant_id } })` 把 tenant_id 写进 `app_metadata`，登录后 JWT 里即可读到。

---

## Part C — JWT tenant claim 注入

两种方式（选一）：

1. **custom claims（推荐）**：创建用户时写 `app_metadata.tenant_id`，登录即带。
2. **DB 层自动注入（更稳）**：`auth.users` 上加 trigger，注册时按业务规则补 tenant_id，避免客户端传参被篡改。

---

## Part D — 升级 getTenantContext（代码）

[src/lib/tenant.ts](file:///d:/RoveFrame%20AI%20Business%20OS/RoveFrame%20AI%20Business%20OS/src/lib/tenant.ts) 由「读 header/env」升级为「读 JWT claim」：

```ts
import { decode } from 'jsonwebtoken'; // 或 Supabase 的 getClaims
import { DEFAULT_TENANT_ID } from '@/lib/tenant';

export function getTenantContext(request?: Request): TenantContext {
  // ※ 精简版：仍从 x-tenant-id 头取（前端登录后把 tenant_id 放 header）
  const headerTenant = request?.headers?.get('x-tenant-id');
  if (headerTenant) return { tenantId: headerTenant, businessId: null };

  // 完整版：从 Authorization Bearer JWT 解析 app_metadata.tenant_id
  const auth = request?.headers?.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (auth) {
    try {
      const payload = decode(auth) as { app_metadata?: { tenant_id?: string } };
      return { tenantId: payload?.app_metadata?.tenant_id ?? DEFAULT_TENANT_ID, businessId: null };
    } catch { /* 非法 token 回退默认 */ }
  }
  return { tenantId: DEFAULT_TENANT_ID, businessId: null };
}
```

---

## Part E — 数据访问层收口（helper）

新增 `src/lib/tenant-db.ts`，把「读自动过滤 tenant、写自动注入 tenant」收口，避免散写漏带：

```ts
import { getSupabaseClient } from '@/storage/database/supabase-client';

type Scope = 'business' | 'platform'; // business 表才按 tenant 过滤

// 读：列查询自动 .eq('tenant_id', tenantId)
export function tenantQuery(tenantId: string, table: string) {
  return getSupabaseClient().from(table).eq('tenant_id', tenantId);
}

// 写：insert/update 自动注入 tenant_id
export function tenantInsert(tenantId: string, table: string, row: Record<string, unknown>) {
  return getSupabaseClient().from(table).insert({ ...row, tenant_id: tenantId });
}
```

> `settings`/`table-scoped` 等特殊表单独处理（见 Part F 标注）。

---

## Part F — 逐路由接线清单

### ① 需要「tenant 过滤」的后台业务路由（每个都：读加 `.eq('tenant_id')`，写加 `tenant_id`）

| 路由 | 涉及表 | 特殊点 |
|---|---|---|
| `api/dashboard` | orders/customers/reviews/alerts | 聚合查询要带 tenant |
| `api/business/products`（+ `generate`） | products | generate 的 transient 无需 tenant，但要回填到当前 tenant |
| `api/business/orders` | orders | 含 tip/tip_staff_id 聚合 |
| `api/business/inventory` | inventory_items | |
| `api/business/staff` | staff | |
| `api/business/tip-insight` | orders/staff | AI 洞察按 tenant 取数 |
| `api/customers`（+ `score`） | customers | |
| `api/reviews`（+ `reply`） | reviews | |
| `api/reservations` | reservations | |
| `api/emails`（+ `classify`/`send`） | emails/email_accounts | 邮箱账户按 tenant |
| `api/marketing`（`contents`/`generate`/`send`） | marketing_contents | |
| `api/knowledge`（`ask`/`docs`） | knowledge_docs/doc_chunks | 向量 + 正文都要 tenant |
| `api/agent`（`chat`/`messages`/`sessions`） | chat_sessions/chat_messages | AI COO 会话按 tenant |
| `api/alerts` | alerts | |
| `api/channels`（+`test`/`send`） | integration_configs | 集成凭据按 tenant |

### ② 需要「business_id」维度的（一租户多门店场景）

| 表 | 说明 |
|---|---|
| `settings` | 由「单行」改为「按 business_id 多行」；`lib/settings.ts` 的 `getSettings` 缓存逻辑要重写 |
| `business_memories` | 记忆 + tenant_id（已加）+ 可选 business_id |
| `cron_state` | scheduler 状态，多租户后按 tenant 分 key（关键：`daily_briefing.${tenantId}` 而不是裸 `daily_briefing`） |

### ③ 公开路由（顾客端，**不打 tenant 过滤**，靠 table_no/公开 token）

| 路由 | 说明 |
|---|---|
| `api/store/menu` / `orders` / `qr-codes` / `staff` | 扫码点餐公开接口，已有 `?table=` 绑定；多租户后需按 **table → tenant** 反查租户 |

### ④ 平台级路由（全局，不按 tenant）

| 路由 | 说明 |
|---|---|
| `api/integrations`、`api/settings/models` | 模型配置是否租户级？建议按 tenant，但初期可全局 |

---

## Part G — 前端改动

1. **登录/注册/邀请**：新增 `app/[locale]/auth/*` 页面（或用 Supabase Auth UI）。
2. **会话存储**：登录后存 access_token（localStorage/HttpOnly cookie）。
3. **请求头**：所有 fetch 带上 access_token（或 x-tenant-id）。
4. **角色渲染**（S3）：`hasPermission(role, action)` 控制菜单/按钮显隐。

---

## Part H — 风险与决策点

1. **service_role → 用户 JWT 的切换面很大**：现有所有 route 都用 `getSupabaseClient()`（无 token）。切用户 JWT 后，每个 route 要改成带 token 的 client。建议**分阶段**：先做 Part E 的「应用层 tenant 过滤」（保持 service_role），再逐步切 JWT + RLS。
2. **`settings` 单行 → 多行**是隐性大改，`lib/settings.ts` 与设置页读写要同步。
3. **公开 store 路由的 tenant 反查**：`table_no → tenant` 需要 `store_qr_codes` 也带 tenant_id（已在 S1 DDL 里加）。
4. **AI 记忆/知识库**的向量检索 `match_doc_chunks` RPC 需要加 tenant 参数，否则跨租户串味。

---

*确认本清单后，我按 Part A→G 的顺序，从「tenant-db.ts + getTenantContext 升级」开始逐项实现。*