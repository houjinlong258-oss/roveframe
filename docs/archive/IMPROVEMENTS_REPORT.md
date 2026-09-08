# 改进实施报告（Improvements Sprint）

> 针对代码审查后提出的 6 项改进清单的执行结果。基线：Production Hardening Sprint 完成后（见 `PRODUCTION_HARDENING_REPORT.md`）。
> 最终验证：`tsc` 通过、测试 **138/138 通过**（21 个套件）、ESLint 通过。

## 改进 1：既有路由 401 语义统一 ✅

老路由 catch 里 `jsonError(getErrorMessage(error))` 会把 `AuthenticationError`（401）兜底成 500，导致前端把"未登录"当"服务器错误"。统一替换为保留 status 的 `errorResponse(error)`。

修改文件：
- `src/app/api/alerts/route.ts`
- `src/app/api/dashboard/route.ts`
- `src/app/api/knowledge/ask/route.ts`
- `src/app/api/knowledge/docs/route.ts`
- `src/app/api/reviews/reply/route.ts`
- `src/app/api/reviews/route.ts`
- `src/app/api/upload/route.ts`

## 改进 2：Apply Engine 真实端到端演练 ✅（DRILL OK）

新增演练脚本 `scripts/apply-drill.ts`：创建提案 → 批准 → worktree apply → 验证文件 → rollback → 验证还原。完整闭环跑通：

```
proposal → approved → applied (merge commit + unit tests PASS + tsc PASS) → rolled_back
```

演练抓出并修复 **3 个真实 bug**：

1. **`src/lib/coding-agent/apply-engine.ts`** — Windows 上 git auto-gc 文件锁导致 commit 实际成功但进程返回非零，被误判为 apply 失败。修复：`git()` helper 统一加 `-c gc.auto=0`。
2. **`src/lib/coding-agent/persistent-store.ts`** — `updateProposalStatus` 内存回退路径丢弃 `patch` 参数，`appliedCommitSha` 写不进去，导致后续 rollback 被拒绝。修复：`Object.assign(updated, patch)` + meta 合并。
3. **runGate 错误日志** — 之前只带命令行不带 stderr，门禁失败时无法定位原因。修复：读取 `err.stderr || err.stdout`。

## 改进 3：全仓 lint 性能 ✅

全仓 `eslint .` 首次 175s（瓶颈为 Windows I/O，配置本身已忽略 RoveAgent/dist/tests）。方案：启用 ESLint 缓存。

- `package.json`：`lint` / `lint:build` 加 `--cache --cache-location .cache/eslint`（二次运行 5s）
- `.gitignore`：加入 `.cache/`

## 改进 4：API 层鉴权测试 + CI 流水线 ✅

- 新增 `tests/api-auth.test.ts`（12 个用例）：直接 import 11 个受保护路由 handler 传裸 Request 断言 401；伪造 Bearer token 断言 fail-closed 仍为 401。
- 新增 `.github/workflows/ci.yml`：ubuntu + node 22 + `pnpm install --frozen-lockfile` + ts-check + test + lint:build。

此测试又抓出 **第 4 个真 bug**：`resolveRequestUser` 里 `resolveUserByToken` 在无 Supabase 凭据环境直接抛错冒泡成 500。已在 `src/lib/auth-guard.ts` 加 try/catch，fail-closed 为 401。

## 改进 5：proxy JWT 本地校验快速路径 ✅

`src/lib/auth-guard.ts` 新增 `verifyJwtLocally`：
- HS256 验签 + alg 白名单 + `timingSafeEqual` 防时序攻击 + `exp` 必填 + 必须含 `app_metadata.tenant_id`
- 配置 `COZE_SUPABASE_JWT_SECRET` 后启用，校验延迟从 ~50–100ms（两次网络往返）降到 <1ms
- role 不在 JWT 中：新增 `roleCache`（userId → role，5min TTL），未命中时降级一次远程查询补齐
- 未配置 secret 时自动回落远程校验，行为与之前完全一致
- 新增 `tests/jwt-local-verify.test.ts`（8 个用例，含篡改签名/过期/缺 tenant 等负例）

## 改进 6：knowledge_docs 补 industry 列 ✅

- `scripts/migrate-production-hardening.sql` 末尾追加幂等 DO 块（`to_regclass` 守卫）：`knowledge_docs` 加 `industry varchar(50)` 列 + `knowledge_docs_industry_idx` 索引。
- `src/lib/enterprise/memory.ts` 本就按 industry 过滤并逐层 try/catch 降级，迁移执行后 L2 行业层即刻生效，无需改代码。
- `src/app/api/knowledge/docs/route.ts` POST/PATCH 支持可选 `industry` 字段（不传不写入，兼容未迁移环境），文档可被打上行业标签。

## 遗留事项（需在有凭据环境执行）

1. 在 Supabase SQL Editor 手动执行 `scripts/migrate-production-hardening.sql`（本机无 `COZE_SUPABASE_*` 凭据，无法代跑；DO 块幂等可重复执行）。
2. 配置 `COZE_SUPABASE_JWT_SECRET`（Supabase 项目 Settings → API → JWT Secret）以启用本地验签快速路径；未配置时自动回落远程校验，无功能损失。
3. 审批 UI 的 unified diff 预览（改进清单第 8 项）未在本轮范围内。
