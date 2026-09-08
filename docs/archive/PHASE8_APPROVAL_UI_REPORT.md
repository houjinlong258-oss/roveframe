# Phase 8 — Enterprise AI Change Approval Experience

> 目标：把 AI 代码审批流升级为专业企业级审查系统。**未重写任何既有系统**——
> coding agent / approval workflow / worktree apply engine / test gate / rollback / audit
> 全部复用，本阶段只做增强与聚合。

## 最终验证

- `tsc -p tsconfig.json` ✅
- `tsx --test tests/*.test.ts` ✅ **161/161**（25 个套件；新增 23 个 Phase 8 用例）
- `eslint --quiet`（全部改动文件）✅
- 真实页面验证 ✅：dev server 打开 `/en/enterprise/approvals` → HTTP 200，标题/导航正常渲染，无 MISSING_MESSAGE，无运行时错误（验证后已停止服务）

## 1. Unified Diff Viewer — `/enterprise/approvals`

新增页面 `src/app/[locale]/enterprise/approvals/page.tsx`（GitHub PR + Linear 风格）：

- 左栏提案列表：状态 / 风险徽章 + 生成时间
- 右栏：提案头（标题、摘要、Agent 名 + 模型、风险级、审批人、commit）
- **统一 diff viewer**：每文件一张卡片（路径、create/modify/delete 徽章、+adds/−dels），
  hunk 头 `@@ -a,b +c,d @@`，双侧行号列，新增绿底 / 删除红底 / 上下文中性，
  支持 added / removed / modified sections

核心引擎 `src/lib/coding-agent/diff.ts`（新，纯函数）：

- Myers O(ND) 行级 diff + 公共前后缀裁剪加速
- hunk 折叠规则与 git 一致（变更间隔 ≤ 2×context 合并）
- git 约定边界：纯新增 hunk `-0,0`、纯删除 hunk `+0,0`、新文件 `--- /dev/null`
- 单侧超 3000 行退化为 `tooLarge` 标记，UI 回落提示

diff 由服务端实时计算（当前工作区内容 vs proposedContent），不经前端拼接。

## 2. Approval Decision Panel

- 三个决策动作：**Approve / Request changes / Reject**；Request changes 强制填写备注
  （服务端 400 校验 + UI 禁用按钮双重约束），备注存入 `reviewNote` 并回显
- 决策前检查包（`src/lib/coding-agent/review-checks.ts`，新）：
  - **Permission**：复用 Apply Engine 的 `revalidateChanges` 路径复检（与 apply 完全同源）
  - **Security**：静态扫描私钥 / AWS key / 硬编码凭据 / eval / child_process / 破坏性 fs 操作；
    命中秘密类规则时摘要自动脱敏
  - **Test gate**：声明 apply 时执行的门禁步骤（unit tests + tsc），并从 applyLog 解析上次结果
  - **Rollback**：仅 `applied` 且存在 `appliedCommitSha` 时可用
- approved → Apply（带门禁说明文案）；applied → Rollback

## 3. Audit Integration

- approve / reject / changes_requested / apply / rollback **全部留审计**
  （apply/rollback 此前已有；PATCH 决策路径本轮补齐 note 字段）
- 新增 `listAuditForEntity`（`src/lib/audit.ts`），详情页底部渲染该提案的
  审计时间线（action / actor / 时间，best-effort）

## 4. Security（UI 不可绕过）

- 所有读取与决策都走既有服务端路径：`withAuth`（PATCH 限 owner/manager）→
  状态机 → Apply Engine 复检；UI 只是调用方
- 新端点 `GET /api/coding-agent/review`：withAuth 完整校验 + tenant 隔离 +
  文件读取路径穿越防护（拒绝 `..` 与绝对路径）
- **状态机显式化**（`src/app/api/coding-agent/route.ts`）：`ALLOWED_TRANSITIONS`
  矩阵取代隐式判断，非法流转 409 并列出合法目标
- **顺手修掉的真问题**：持久层内存回退模式之前忽略 tenantId（getProposalById/
  listProposals/updateProposalStatus 全不过滤）——已补齐 fail-closed 租户过滤，
  与 DB 模式 `.eq('tenant_id')` 语义对齐

## 5. Testing（`tests/phase8-approval-ui.test.ts`，23 个用例）

- **diff rendering**：create/delete/modify、hunk 折叠（远拆近合）、unified diff 文本格式、行号正确性
- **permission validation**：review/PATCH 未认证 401、staff 角色 403、
  跨租户访问 404（含内存回退模式）、review GET 只读不改状态
- **approval state transition**：changes_requested 必须带备注（400）、
  pending→changes_requested→approved 合法、approved→rejected 409、
  PATCH 设置 applied 400
- **audit creation**：approve/reject/changes_requested 均断言审计记录
  （action、tenantId、actorId、before/after、note）

### 测试抓出并已修复的 2 个真 bug

1. **审计 before 污染**：内存存储为同引用对象，`updateProposalStatus` 原地改状态后
   `writeAudit` 读到的 `before` 已是新值——路由层改为先快照 `beforeStatus` 再更新。
2. **内存回退租户隔离缺失**：见第 4 节。

### 测试基础设施（可复用）

- `auth-guard._seedRoleForTest(userId, role)`：配合 `COZE_SUPABASE_JWT_SECRET`
  构造本地可验签 JWT，无 Supabase 环境即可走通 withAuth 完整链路（含角色门控）
- `audit._setAuditSinkForTest(sink)`：审计写入捕获

## 数据迁移

`scripts/migrate-production-hardening.sql` 追加（幂等，需在 Supabase SQL Editor 执行）：

```sql
alter table public.coding_proposals add column if not exists review_note text;
```

未执行迁移时：内存回退路径完整支持 reviewNote；DB 模式的 PATCH 带备注写入会
因缺列失败并返回 404——请先执行迁移。

## 改动文件清单

| 文件 | 变更 |
|------|------|
| `src/lib/coding-agent/diff.ts` | 新增：Myers diff + hunks + unified 格式化 |
| `src/lib/coding-agent/review-checks.ts` | 新增：四类审批前检查聚合 |
| `src/app/api/coding-agent/review/route.ts` | 新增：审批详情聚合端点 |
| `src/app/api/coding-agent/route.ts` | 状态机矩阵 + changes_requested + note + before 快照 |
| `src/lib/coding-agent/types.ts` | +`changes_requested` 状态、+`reviewNote` 字段 |
| `src/lib/coding-agent/persistent-store.ts` | review_note 列映射 + 内存租户隔离 |
| `src/lib/audit.ts` | +listAuditForEntity + 测试 sink |
| `src/lib/auth-guard.ts` | +_seedRoleForTest 测试缝 |
| `src/app/[locale]/enterprise/approvals/page.tsx` | 新增：企业审批台页面 |
| `src/app/[locale]/approvals/page.tsx` | 旧页兼容新状态（样式 + 文案键） |
| `src/components/layout/sidebar.tsx` | +/enterprise/approvals 导航入口 |
| `messages/{en,zh,es}.json` | +enterpriseApprovals 命名空间 +nav 键 +旧页 status 键 |
| `scripts/migrate-production-hardening.sql` | +review_note 列迁移 |
| `tests/phase8-approval-ui.test.ts` | 新增：23 个用例 |
