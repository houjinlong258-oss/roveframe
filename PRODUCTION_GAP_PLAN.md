# PRODUCTION GAP PLAN — RoveFrame Pilot Ready 升级计划

> 基线 commit：`65fa020`（2026-09-08 之后工作树全量，含 1851 文件 / 993K 行）
> 依据证据：`_src_review_20260907/{A,B,C,D}_findings.md` + `源码验收报告_20260908.md` + `docs/current/PRODUCTION_GATE_REPORT.md`
> 定位变更：**RoveFrame AI Executive Operations Platform**，第一阶段核心产品 = **Restaurant AI Chief of Staff**（Morning Brief / Ask Business Question / Approve AI Actions 三个入口）。
> 本计划只做「接线 + 验证」，不做新功能扩张；Plugin Marketplace / AI Workforce Marketplace / 更多行业 / Website Builder / POS replacement / Loyalty 一律冻结。

---

## 实施状态（2026-09-08 更新）

| 项 | 状态 | 提交 |
|---|---|---|
| Step 1 git baseline | ✅ | `65fa020` |
| Step 2 本计划 | ✅ | `a939ad2` |
| P0-1 召回活动真实审批动作 | ✅ | `6a282b5` |
| P0-2 通知投递（Email + Web Push） | ✅ | `10beb0e` |
| P0-3 Square OAuth + 定时同步 + 游标 | ✅ | `ee5d4fb` |
| P0-4 审批 UI 最后一公里 | ✅ | `a870757` |
| P0-5 Production Audit Store | ✅ | `a870757` |
| P0-6 Supabase RLS | ✅ | `67386de` |
| AI Executive Layer（四 persona） | ✅ | `75a42dc` |
| Step 6 测试 | ✅ | TS 278 + Python 21 全绿；live E2E 见 `scripts/e2e-recovery-campaign.mts`（需运行栈 + 真实凭据） |

**外部依赖（非代码，上线前必须配置）**：Supabase 目标库跑 `scripts/migrate-pilot-ready.sql` + `scripts/migrate-rls.sql` + `scripts/verify-rls.sql`；`ENCRYPTION_SECRET`；SMTP 邮箱账号；`SQUARE_APP_ID/SECRET`（OAuth 回调白名单）；`node scripts/generate-vapid.mjs` 生成 VAPID 并写入 env。详见 `docs/current/PILOT_READY_STATUS.md`。

---

## 0. 目标闭环（真实链路，禁 stub）

```
Business Data → AI Insight → Recommendation → Approval → Real Action
  → Execution Result → Audit → Memory
```

所有 Demo 路径逐步替换为真实业务路径；`RF_E2E_DEMO` 生产强制关闭。

---

## 1. P0-1 第一个真实高价值审批动作：AI CMO Customer Recovery Campaign

### 当前缺口（证据）
1. Python CEO 工具集 8 个全是只读（`roveagent/tools/business_data_tool.py:66-83`）→ 真实对话永远走不到「请求审批」；E2E 用的是 stub `send_marketing_campaign`（`A_agent_chat_findings.md §3.4`）。
2. 门禁策略已有 `send_*` → HIGH/MANAGER（`roveagent/tools/framework.py:100-110` DEFAULT_POLICIES），但**没有任何真实工具命中该策略**。
3. TS 侧营销外发只写 `email_send_tasks`（queued），**全仓无处理器**（grep 证据：`marketing/send/route.ts:101` 是唯一写入点）→ 邮件实际发不出去。
4. 批准后执行链（gate→HMAC events→/approvals→签名回调 resolve）机制已真实贯通（`B_approval_findings.md §1`），缺的只是「一个真实工具挂在链上」。

### 涉及文件
| 文件 | 修改 |
|---|---|
| `roveagent/tools/framework.py` | DEFAULT_POLICIES 增加 `send_customer_recovery_campaign` → HIGH / OWNER（owner 也必须经审批） |
| `roveagent/tools/business_data_tool.py` | 注册真实工具 `send_customer_recovery_campaign`（business toolset） |
| `roveagent/business/data_layer.py` | 新增 `analyze_churn_customers` 与 `send_recovery_campaign` 两个操作（经 /api/internal/agent/business-data） |
| `src/app/api/internal/agent/business-data/route.ts` | 新增 `analyze_churn_customers`（60 天无消费 + 高价值分段）、`send_recovery_campaign`（真实 SMTP 逐人发送 + 落库） |
| `src/lib/agent/recovery-campaign.ts`（新） | 分段查询 / Campaign Draft 生成 / 执行器（nodemailer 真实发送、逐收件人状态） |
| `src/lib/email/outgoing.ts`（新） | `email_send_tasks` 处理器：queued→sending→sent/failed，重试 + 失败日志（同时修 marketing/send 发不出去的问题） |
| `scripts/migrate.sql` + `migrate-business-tables.sql` + `src/storage/database/shared/schema.ts` | 新表 `campaign_emails`（tenant/business/campaign/customer/recipient/subject/body/status/provider_message_id/error/sent_at） |
| `src/lib/agent/approvals.ts` | executeFrozenApproval 分支无需新增（走 roveagent.tool_call 回调）；补审计写入（见 P0-5） |

### 流程（真实链路）
```
老板对话「帮我召回最近60天没来的高价值客户」
 → CEO Agent 调 read_customers/read_orders 分析真实数据
 → 生成 Campaign Draft（分段人数/主题/正文模板）
 → 调 send_customer_recovery_campaign（冻结 args：campaign_id/收件人 id 列表/主题/正文）
 → EnterpriseToolGate 判定 requires_approval(OWNER) → HMAC push /api/agent/approvals/events
 → 老板 /approvals UI 看到 Agent/Tool/Business/User/Arguments/Risk → Approve
 → TS processApproval → 签名回调 Python /api/agent/tool/resolve → consume_grant 单次放行
 → BusinessDataLayer → TS internal send_recovery_campaign → nodemailer 真实发送
 → campaign_emails 逐人状态（sent/failed）+ business_memories 写入结果 + audit_events 审计
```

### 风险
- 无 SMTP 账号/凭据时执行失败 → approval 状态 failed + last_error 明确展示（不静默）。
- AI 生成正文质量 → 模板化兜底 + 人工可改 draft。
- 大批量发送被 ESP 限流 → 逐封串行 + 1s 间隔 + email_send_tasks 队列重试。

---

## 2. P0-2 通知投递修复：Daily Executive Brief 真实送达

### 当前缺口（证据）
1. outbox 只实现 web_push，email/telegram/whatsapp/sms 直接 throw（`src/lib/notifications/outbox.ts:114-115`）。
2. 出件循环被 `ROVEFRAME_ENABLE_NOTIFICATION_DISPATCH` 关闭（`scheduler.ts:252-258`）。
3. Service Worker 被禁用（`next.config.ts` `disable: true`，Serwist×Turbopack 兼容问题）。
4. `public/` 无 icons（只有 5 个 svg），`push.ts:60` 与 manifest 引用 /icons/icon-192.png 均 404。
5. DAILY_BRIEFING handler 只入队 web_push（`worker.ts:375`）。

### 涉及文件
| 文件 | 修改 |
|---|---|
| `src/lib/notifications/outbox.ts` | 实现 email 通道（真实 SMTP，取 business owner 邮箱 + 默认发件账号；attempts/backoff/last_error 复用现有重试） |
| `src/lib/agent/tasks/worker.ts` | DAILY_BRIEFING 同时入队 email + web_push 两条通知 |
| `src/lib/scheduler.ts` | 默认启用 dispatch（env 缺省改为 true，保留显式关闭开关） |
| `public/sw.js`（新，手写） | push/notificationclick 最小 SW（避开 Serwist×Turbopack 构建不兼容，serwist 保持 disable） |
| `src/components/pwa/PushSubscribe.tsx`（新）+ layout 挂载 | SW 注册 + 订阅持久化（POST /api/notifications/push 已有） |
| `public/icons/*.png`（新） | icon-192/512/maskable 生成 |
| `scripts/generate-vapid.mjs`（新） | VAPID keypair 生成（web-push 库） |
| `.env.example` | NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY 客户端可见公钥 |

### 验证口径
created（notifications 行）→ queued（outbox）→ sent / failed（带 sent_at / last_error / attempts）。不是只生成任务记录。

### 风险
- Web Push 需要 HTTPS + 浏览器授权，老板可能不授权 → Email 是主通道（P0 优先），Push 为增强。
- VAPID key 与订阅持久化：订阅已落 push_subscriptions 表；410/404 自动清理已有。

---

## 3. P0-3 真实 Integration Flow（Square 优先）

### 当前缺口（证据）
- 无 OAuth 回调路由（全 src 无 `oauth/callback`）；凭据靠手工粘贴 token（`settings/page.tsx:92-98`）。
- 仅 square orders 单向同步且手动触发；products/customers/inventory 未实现（`C_connectors_findings.md §1b`）。
- scheduler 60s tick 不含 Square 同步（`scheduler.ts:266-281`）。
- `RF_E2E_DEMO=1` 时沙箱订单写真实库（`sync route:11,55-57`）——生产必须硬门禁。

### 涉及文件
| 文件 | 修改 |
|---|---|
| `src/app/api/integrations/square/oauth/start/route.ts`（新） | 生成 state（签名+过期）、跳转 Square authorize URL（env `SQUARE_APP_ID`/`SQUARE_OAUTH_SCOPES`） |
| `src/app/api/integrations/square/oauth/callback/route.ts`（新） | 验 state → 换 token（refresh_token 一起加密落 integration_configs）→ 拉 /v2/locations 绑定 location |
| `src/lib/connectors/square.ts` | 新增 fetchSquareCatalog / fetchSquareCustomers / fetchSquareInventory（游标分页），token 刷新 |
| `src/app/api/integrations/[provider]/sync/route.ts` | 扩展 square：orders + catalog + customers + inventory；游标水位写 cron_state |
| `src/lib/scheduler.ts` | 每 tick 对已连接 square 的 business 跑增量同步（水位 15 分钟节流） |
| `src/server.ts` | 生产启动硬校验：PROD && RF_E2E_DEMO=1 → 拒绝启动（fail-closed） |
| `src/app/[locale]/settings/page.tsx` | 「Connect with Square」按钮替换纯手工粘贴（保留手工粘贴作为 fallback） |

### 要求落点
OAuth flow / merchant connection / location binding / scheduled sync / cursor persistence / order+product+inventory sync；所有行 tenant_id+business_id；demo 数据不混生产。

### 风险
- Square OAuth 需开发者应用 App ID/Secret + 回调域名白名单（外部依赖，需部署者配置）。
- 沙箱/生产 scope 差异；限流 → 同步失败记录 integration_events + audit。

---

## 4. P0-4 Approval 最后一公里

### 当前缺口（证据）
UI 行只渲染 title/status/type/risk/description/tool/execution_id（`approvals/page.tsx:258-301`）；不显示 Arguments、execution_result、approved_by、审计；无轮询/Realtime（`B_approval_findings.md E/F`）；默认 tab=code；GET 无 try/catch 未认证 500。

### 涉及文件
| 文件 | 修改 |
|---|---|
| `src/app/[locale]/approvals/page.tsx` | 展开卡片：Agent/Tool/Business/User/Arguments(JSON)/Risk；状态时间线 pending→executing→executed/failed（含 approved_by/approved_at/executed_at/failed_at/last_error）；execution_result 展示；8s 轮询；默认 tab=business |
| `src/app/api/agent/approvals/route.ts` | GET try/catch → 401（未认证）；返回完整字段 |
| `src/lib/agent/approvals.ts` | 审批生命周期写 audit_events（P0-5） |

### 风险
- 30s HTTP 同步等待：TS→Python resolve 现有 30s 超时；campaign 发送可能超时 → 本轮把发送改为「入队后由 email_send_tasks 处理器异步出件」，resolve 立即返回 queued 状态，最终结果由任务处理器回写（避免 UI failed 与实际执行不符）。

---

## 5. P0-5 Production Audit Store

### 当前缺口（证据）
Python 审计只写本地 JSONL（`gate_hook.py:50-56`、`app.py:471-473,514-515`）；TS `audit_logs` 无 entity_id（`mutation-guard.ts:29-40`）；无查询 API/页面/导出。

### 涉及文件
| 文件 | 修改 |
|---|---|
| `scripts/migrate.sql` / `migrate-business-tables.sql` / `schema.ts` | 新表 `audit_events`：tenant_id, business_id, user_id, agent_id, tool_name, action, arguments_hash, approval_id, execution_id, timestamp, result, actor_role, status |
| `src/lib/agent/audit.ts`（新） | `writeAuditEvent`（幂等 key = execution_id+action） |
| `src/lib/agent/approvals.ts` | 全生命周期（created/approved/rejected/executing/executed/failed）写 audit_events；Python 执行结果经 resolve 返回值写入 result |
| `src/app/api/audit/route.ts` + `src/app/api/audit/export/route.ts`（新） | 分页查询（tenant/business 限定、按 approval_id 关联）+ CSV 导出 |
| `src/app/[locale]/audit/page.tsx`（新）+ sidebar + i18n | 审计页面 |

### 风险
- Python 侧独立 JSONL 与 TS store 双写漂移 → 本轮以 TS store 为准（resolve 回调即落库），Python JSONL 保留为本地兜底。

---

## 6. P0-6 Database Security（Supabase RLS）

### 当前缺口（证据）
全仓仅 `migrate-production-hardening.sql:89-91` 对 3 张表 enable RLS 且**无任何 policy**；业务读写全部走 service_role（旁路 RLS）→ 隔离只有应用层一道防线（`D_runtime_findings.md §3.3`）。

### 涉及文件
| 文件 | 修改 |
|---|---|
| `scripts/migrate-rls.sql`（新） | 对全部 business-scoped 表 enable RLS + 每表两条 policy：authenticated（`tenant_id = (select tenant_id from users where id=auth.uid())` 与 `business_id = (select business_id from users where id=auth.uid())`）与 service_role（全量，默认旁路即可，显式授权）；优先保护 orders/customers/payments/integrations/memory/audit |
| `scripts/verify-rls.sql`（新） | SQL 层验证：set local role authenticated + request.jwt.claims 模拟两 tenant 两 business，断言跨租户/跨 business 查询返回 0 行（zero crossover） |
| `tests/rls-policy.test.ts`（新） | 静态断言 migrate-rls.sql 覆盖表清单 + policy 存在（同 approval-bus.test.ts 模式） |

### 风险
- service_role 仍全权（当前架构无用户 JWT 数据面）→ RLS 是第二道防线 + 未来用户 JWT 模式的前置；上线不破坏现有应用层路径（service_role 不受 RLS 影响）。

---

## 7. AI Executive Layer（保留统一 Runtime）

- 不新建 runtime。统一 RoveAgent Runtime（Python `roveagent` + TS 降级 loop 不变）。
- 四个 persona：CEO Insight（business overview/strategy）、COO（operations）、CMO（customer growth）、CTO（system health）——经 persona/skills/permissions/workflows 区分：
  - Python：`roveagent/workforce/employees.py` 现有 find_employee 机制 + restaurant skills pack；补 persona 定义文件（permissions 与 ROLE_PERMISSIONS 对齐）。
  - TS：agent 页 persona 选择器透传 agent 身份（chat route 已携带 role/permissions）。
- 产品收敛：三入口（Morning Brief / Ask / Approve）为导航主路径；不建 Marketplace 等。

---

## 8. 测试与验收

### 新增测试
1. `roveagent/enterprise/recovery_campaign_test.py`：真 gate + 真 handler + 真 resolve（exactly-once、拒绝零发送、篡改 409），BusinessDataLayer 以真实 HTTP 指向 TS 时做集成（未配置时显式 skip 并输出原因）。
2. `tests/recovery-campaign.test.ts`：分段逻辑（60 天无消费+高价值）、draft 校验、执行器（nodemailer json transport 断言出件与逐人状态）。
3. `tests/notification-email.test.ts`：outbox email 通道状态机 queued→sent/failed、重试退避。
4. `tests/audit-store.test.ts`：audit_events 写入幂等 + 查询过滤。
5. `scripts/e2e-recovery-campaign.mts`（新）：live 全链脚本（需运行栈 + 真实 SMTP + Supabase），验证「对话→分析→draft→审批→发送→audit→memory」；未配置时 exit 1 并打印缺失项（不假装通过）。

### 最终验收（Pilot Ready）
- 老板每天 8:00 收到经营简报（Email 主通道，Push 增强）✅可验证
- 问「为什么销售下降？」→ AI 读真实数据回答 ✅现有 read_* 工具
- AI 建议召回客户 → Approve → 真实发送 → 结果记录 ✅本计划 P0-1
- Audit 页面可查询/导出 ✅P0-5
- RLS 零交叉验证 ✅P0-6

---

## 9. 实施顺序（对应用户 Step 3-6）

1. ✅ Step 1 git baseline（`65fa020`）
2. ✅ Step 2 本计划
3. Step 3 真实审批动作（P0-1，含 email_send_tasks 处理器）
4. Step 4 notification delivery（P0-2）
5. Step 5 production integration（P0-3 Square OAuth+定时同步；P0-4 审批 UI；P0-5 Audit Store；P0-6 RLS）
6. Step 6 测试（第 8 节全部 + 全量 validate）
