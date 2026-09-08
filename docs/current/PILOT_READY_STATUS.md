# PILOT READY STATUS — RoveFrame Restaurant AI Chief of Staff

> 生成：2026-09-08 · 基线 `65fa020` · 升级系列提交 6a282b5 → 75a42dc
> 定位：RoveFrame AI Executive Operations Platform，第一阶段核心产品 = Restaurant AI Chief of Staff。

## 一、目标闭环（已接线，禁 stub）

```
Business Data → AI Insight → Recommendation → Approval → Real Action
  → Execution Result → Audit → Memory
```

| 环节 | 实现 | 证据 |
|---|---|---|
| Business Data | Square 真实同步（orders/products/customers/inventory，OAuth+定时+游标） | `src/lib/connectors/square-sync.ts` |
| AI Insight | 真实数据分段（60 天无消费高价值客户） | `src/lib/agent/recovery-campaign.ts` |
| Recommendation | AI 生成 Campaign Draft（失败回落确定性模板） | 同上 buildCampaignDraft |
| Approval | EnterpriseToolGate 冻结 → HMAC events → /approvals UI（Request/Risk/Timeline/Result/Audit） | `roveagent/tools/framework.py`、`src/lib/agent/approvals.ts`、`src/app/[locale]/approvals/page.tsx` |
| Real Action | 批准 → 签名回调 → 单次放行 → 真实 SMTP 逐人发送 | `roveagent/api/app.py resolve_tool`、`src/lib/email/outgoing.ts` |
| Execution Result | email_send_tasks sent/failed 状态机 + 审批 execution_result 回写 | `src/lib/email/outgoing.ts finalizeCampaignIfComplete` |
| Audit | audit_events 全生命周期 + /audit 页面 + CSV 导出 | `src/lib/agent/audit.ts`、`src/app/[locale]/audit` |
| Memory | 活动结果沉淀 business_memories + Python L4 episode | `recordCampaignMemory`、`app.py chat` |

## 二、三个核心入口

1. **Morning Executive Brief**：DAILY_BRIEFING 任务（本地 8:00）→ Email（主通道）+ Web Push（增强），outbox 出件默认开启，attempts/backoff/失败日志齐全。
2. **Ask Business Question**：/agent 对话，四 persona（CEO Insight/COO/CMO/CTO）统一 runtime。
3. **Approve AI Actions**：/approvals 经营动作台（默认 tab），8s 轮询，批准后可见 executing → completed/failed 与真实结果。

## 三、上线前必须执行的部署步骤

1. **数据库**（目标 Supabase 项目 SQL Editor，按序）：
   - `scripts/migrate-pilot-ready.sql`（email 队列列 / marketing 审批关联 / audit_events）
   - `scripts/migrate-rls.sql`（33 张业务表 RLS + 双 scope policy）
   - `scripts/verify-rls.sql`（零交叉验证；出现 `RLS FAIL` 或 `raise exception` 即停止上线）
2. **环境变量**（`.env.example` 为准）：
   - `ENCRYPTION_SECRET`（≥32 字节随机）
   - `SQUARE_APP_ID/SQUARE_APP_SECRET`（Square Developer Console；回调 URL 白名单 = `<NEXT_PUBLIC_APP_URL>/api/integrations/square/oauth/callback`）
   - `node scripts/generate-vapid.mjs` → `WEB_PUSH_VAPID_*` + `NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY`
   - `ROVEFRAME_ENABLE_NOTIFICATION_DISPATCH` 默认开启（显式 `false` 才关）
   - 生产严禁 `RF_E2E_DEMO=1`（server.ts 直接拒绝启动）
3. **商家侧**：设置页「Connect with Square」OAuth（或手工粘贴 token）→ 绑定邮箱账号（is_default）→ 老板在 /agent 询问「帮我召回最近60天没来的高价值客户」→ /approvals 批准 → 真实发送。
4. **验收**：`pnpm run e2e:recovery`（需运行栈 + 真实 SMTP + Supabase，任何一步失败 exit 1）。

## 四、验证口径汇总

| 套件 | 结果 |
|---|---|
| TypeScript tests | 278 pass |
| Python unittest | 21 pass（含召回活动 exactly-once/拒绝/篡改 409/RBAC） |
| ts-check / eslint / stylelint | 通过 |
| RLS 零交叉 | `scripts/verify-rls.sql`（数据库内执行验证） |
| 全链 live E2E | `scripts/e2e-recovery-campaign.mts`（需真实凭据的运行栈） |

## 五、产品收敛（已冻结）

不开发：Plugin Marketplace / AI Workforce Marketplace / 更多行业 / Website Builder / POS replacement / Loyalty system。
