# Production Hardening Sprint — 修改报告

> 日期：2026-09-03 · 范围：P0 鉴权 / P1 持久化与审计 / P2 审批闭环
> 验证口径：`tsc -p tsconfig.json` ✅ · `tsx --test tests/*.test.ts` **84/84 通过**（63 原有 + 21 新增）✅ · 改动文件 ESLint ✅ · dev server 冒烟（未登录管理 API → 401）✅

---

## 一、P0 — 统一鉴权与租户上下文

### 1. `src/lib/auth-guard.ts`（新增）
统一鉴权中间件原语：
- `withAuth(handler, { roles })` — 路由层包装器：完整 Supabase token 校验 + 角色门控，401/403 语义正确
- `AuthContext` — 注入 `user / tenantId / businessId / role` 租户上下文
- `resolveRequestUser` — 带 60s TTL 进程内缓存（防页面并行请求打爆 Supabase）
- `PUBLIC_API_PREFIXES` / `isPublicApiPath` — 公开路由白名单（login/signup/logout、store/menu、store/orders、store/staff、customer/favorites）
- `injectRfHeaders / stripRfHeaders / getAuthContext` — proxy 注入 `x-rf-*` 租户头；注入前强制剥离客户端伪造头

### 2. `src/proxy.ts`（重写）
Next.js 16 proxy（Node.js runtime）现在是统一 API 鉴权边界：
- matcher 从「排除 /api」改为覆盖全部路径
- `/api/**`：公开白名单放行；其余必须带有效会话（HttpOnly cookie 或 Bearer），校验通过注入租户上下文头，失败返回 `401 {"error":"unauthorized: ..."}`
- 非 API 路径保持 next-intl 原行为
- **已实测**：未登录 `GET /api/coding-agent` → 401；`GET /api/healing` → 401；公开路由正常穿过 proxy

### 3. `src/app/api/coding-agent/route.ts`（重写）
- 全部方法接入 `withAuth`；POST/PATCH 限 owner/manager
- **修复身份伪造**：`businessId/userId` 原从请求体读取（可伪造），现只取自已验证会话
- **关闭假 applied 漏洞**：PATCH 不再允许手动设置 `applied`；仅 `pending_review` 可流转为 approved/rejected（409 冲突保护）

### 4. `src/app/api/healing/route.ts`（重写）
- POST 任意登录用户可上报（身份取自会话，不可伪造）；GET 含堆栈的错误详情限 owner/manager

### 5. `src/lib/auth.ts`（修改）
- session cookie 的 `Secure` 改为仅生产环境启用（原实现下本地 http 开发浏览器拒存 cookie，登录态根本无法建立）

### 备注（审查修正）
首轮评审称"全部 API 无鉴权"不完全准确：45/53 路由已通过 `getTenantContext` 做了完整校验（但 401 被笼统 catch 成 500，语义不对）。**真正的裸奔路由是 coding-agent 与 healing**（恰是最危险的两个），现已修复；proxy 层为全部路由补齐统一边界 + 正确 401。

## 二、P1 — 持久化与审计

### 6. `src/lib/healing/persistent-store.ts`（新增）
error_events 迁移 Supabase：DB 可用时以库为准（重启不丢、tenant_id 隔离、指纹跨重启去重）；未配置/未迁移时自动回退内存环形缓冲。60s 探测缓存，迁移应用后无需重启自动切换。

### 7. `src/lib/coding-agent/persistent-store.ts`（新增）
coding_proposals 同上：save/list/get/updateStatus 全部 async + tenant 隔离 + DB 优先内存兜底。原内存 `proposal-store.ts` 保留不动（63 个既有测试零改动通过）。

### 8. 审计
- `src/lib/audit.ts`（既有，写 audit_logs 表）已接入：审批决定、apply、rollback 均 `await writeAudit`（遵守"路由内禁止 fire-and-forget"陷阱）
- `src/lib/coding-agent/types.ts` 扩展：tenantId、decidedBy/At、appliedCommitSha、rolledBack、applyLog 等字段（全部可选，向后兼容）

### 9. `scripts/migrate-production-hardening.sql`（新增）
`error_events` / `coding_proposals` / `audit_logs` 三表 + 索引 + RLS 开启（service role 专用）。**幂等，需在 Supabase SQL Editor 手动执行**——本环境无 `COZE_SUPABASE_*` 凭据，无法代执行。

## 三、P2 — 审批闭环

### 10. `src/lib/coding-agent/apply-engine.ts`（新增）— 真正的 Apply Engine
`applyProposal`：状态守卫（仅 approved）→ 每条 change 重新过 `checkPath` 路径复检（不信任提案自报）→ **git worktree 隔离写入**（`.worktrees/<id>`，`agent/<id>` 分支，不直接碰主工作区）→ `merge --no-ff` 合入 → **测试门禁**（tsx 全量单测 + tsc）→ 失败自动 `revert -m 1` 并标记 `apply_failed`。
`rollbackProposal`：`git revert` 已合入提交（merge commit 自动 `-m 1`），回滚后重跑门禁，状态 `rolled_back`。

安全红线落实：
- 全程**不用** `reset --hard` / `clean -fdx`（工作区有未提交改动也不会被破坏）
- 目标文件与工作区未提交改动重叠时拒绝合入
- 路径穿越（`..`）、绝对路径、512KB 以上文件直接拒绝

### 11. `src/app/api/coding-agent/apply/route.ts` + `rollback/route.ts`（新增）
POST，owner/manager，全程审计留痕。

### 12. `src/app/[locale]/approvals/page.tsx`（新增）— Approval UI
侧栏新增「Approvals / 变更审批 / Aprobaciones」入口（ShieldCheck 图标）。功能：
- 提案列表（状态/风险徽章、时间）
- 详情：变更清单 + 每个文件的完整 proposedContent 预览（深色代码块）
- 操作：批准 / 拒绝（pending）→ 应用（approved）→ 回滚（applied）
- apply 日志展示；en/zh/es 三语文案齐备

### 13. `tests/production-hardening.test.ts`（新增，21 个测试）
公开路由判定（含 `/api/auth/loginx` 边界）、伪造头剥离/注入/解析、无效角色拒绝、无 token 拒绝、apply 复检（穿越/绝对路径/越权路径/空内容/空清单）、持久化内存回退 roundtrip。

## 四、未在本 Sprint 内（按禁令执行）

- Docker Sandbox、AI Business Generator、自动部署 —— 未触碰
- 已交付的务实替代：git worktree 即轻量沙箱；git revert 即回滚；测试门禁即部署前检查

## 五、遗留事项（需你操作或后续 Sprint）

1. **执行迁移**：`scripts/migrate-production-hardening.sql` → Supabase SQL Editor（未执行前持久化自动回退内存，功能可用但重启丢数据）
2. 本地环境无 `COZE_SUPABASE_*` 凭据，页面级渲染验证只能做到 `/en` 200 + 管理 API 401；完整登录→审批→apply 链路需在有凭据环境复测
3. 页面 401 后的前端跳转（AppShell 检测 401 跳 /auth）建议下一 Sprint 补
4. `git stash@{0} "hardening-wip"` 是验证过程中保留的快照副本，内容与当前工作区一致，确认无误后可 `git stash drop`
