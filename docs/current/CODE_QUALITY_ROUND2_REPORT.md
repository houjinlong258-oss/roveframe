# CODE QUALITY ROUND 2 — 剩余 P0 修复报告

> 依据：`docs/current/CODE_QUALITY_IMPROVEMENT_PROMPT_20260908.md`（审查版 v1.2）。
> Round 1（f82a5e0）已完成 P0-5/9/18/19 + P1-1。本报告回填 Round 2 的 16 个剩余 P0，
> 每条按「证据 / 改动 / 测试 / 风险」格式，全部为可独立 revert 的小步 commit。

## 逐条回填

### [P0-1] 全站无速率限制 — commit c274b65
- 证据：全仓无 ratelimit/429 实现（仅 AI router 429 重试与 square 节流）。
- 改动：新增 `src/lib/rate-limit.ts`（固定窗口+指数退避+并发门+429 Retry-After）；接线 13 个缺口端点：auth login/signup（账号 5 次/15min+退避、IP 20/10 次/15min）、admin/auth、emails/send 30/min、channels/send 20/min、marketing/send 10/min、payments checkout/refund/reconcile、store/orders 30/min/桌码、upload 20/min/商户、agent/chat 并发 ≤4/商户（流结束 finally 释放）、healing 每日 20 次/商户；`/api/health` 不接限流。
- 测试：`tests/rate-limit.test.ts` 9 例（超窗 429、不同 key 隔离、窗口重置、退避、并发门幂等 release、IP 解析、接线契约）。
- 风险：单实例内存实现——多实例部署限额随实例数放宽（已写入 ARCHITECTURE.md 部署契约）。回滚：`git revert c274b65`。

### [P0-2] service_role→anon 静默回落 — commit a140601
- 证据：`supabase-client.ts:100-101` `key = serviceRoleKey ?? anonKey`；216 处调用无一传 token。
- 改动：生产（COZE_PROJECT_ENV=PROD）缺 service role key 直接抛错；非生产保留 anon 回落+告警；无 token 客户端按 url+key 模块级缓存；ARCHITECTURE.md 明示「service_role 全旁路 + 应用层谓词收口」模型与 RLS 启用顺序。
- 测试：`tests/supabase-client.test.ts` 6 例（生产抛错/回退/实例复用/key 轮换重建/token 客户端不缓存）。
- 风险：生产若此前只配了 anon key，升级后启动失败（即修复目标）。回滚：revert。

### [P0-3] plainTable 直查业务表（跨租户读） — commit 166d79b
- 证据：`api/business/inventory/route.ts:13-21` 用 `plainTable('integration_configs')` 无 tenant 过滤，而 integration_configs ∈ BUSINESS_SCOPED_TABLES。
- 改动：plainTable/plainInsert/plainUpdate/plainDelete 复用业务表白名单拒绝（`unfiltered data access is forbidden`）；inventory 改 `scopedTable(ctx)+eq('provider','erpnext')`。
- 测试：`tests/business-isolation.test.ts` +3 例（plain* 拒绝 + 路由源码契约）。
- 风险：任何未来想用 plain* 访问业务表的代码会直接抛错（预期行为）。回滚：revert。

### [P0-4] 读接口 RBAC 缺位 — commit 15f8adb
- 证据：staff 仅 4 权限，但 emails/reservations/reviews/agent-approvals/audit-export/support-access GET 仅 requireBusinessContext 即全量读取。
- 改动：上述 GET 全部 `requirePermission(entity:read)`（manager 新增 approvals:read/audit:read）；catch 统一 errorResponse（403 不再落 500）；support-access GET 必填 tenantId 且仅返回调用者自身授权记录（删除跨管理员全量列表）；API_PERMISSION_MATRIX.md 新增读边界矩阵。
- 测试：`tests/api-read-rbac.test.ts` 4 例（staff 403 / 六端点门控 / support-access 契约）。
- 风险：staff 角色的邮箱/预约/评论/审批/审计页面将收到 403（前端需以空态/提示呈现，属修复目标）。回滚：revert。

### [P0-6] 支付/清空/下单金额与幂等边界 — commit 3f683c9
- 证据：checkout reservation 分支只查存在性金额信任客户端；wipe 按 tenant 全删 13 表；store/orders 幂等键可选、items 无上限、计数 RPC 失败仅 console.warn。
- 改动：(a) reservations 新增权威 `due_amount`（schema/迁移三处），checkout 服务端比对、无权威价 409 拒绝；(b) wipe 双 scope + 服务端一次性确认令牌（5min）+ dry-run 预览，前端两步调用且失败不误报；overview 计数改双 scope；(c) store/orders zod 完整 schema（items≤50/qty≤99/tip≤1万/总额≤10万/note≤500）+ 23505 冲突回读既有订单 + 计数有界重试；迁移三处统一 (tenant,business,external_id) 部分唯一索引。
- 测试：`tests/amount-idempotency.test.ts` 10 例（schema 边界 + 幂等索引三处同构 + checkout/wipe/overview 契约）。
- 风险：历史预约无 due_amount → 预约支付模式 409（需商户在预约里补金额字段，后续 UI 跟进）。回滚：revert。

### [P0-7] 前端「保存成功」误报 — commit 4aa7606
- 证据：settings 六处保存无 res.ok 检查无 catch；emails 草稿保存无视响应；knowledge save 无 finally。
- 改动：新增 `lib/fetch-utils.saveJson`（非 2xx 抛 SaveError 含服务端文案）；settings 保存/删除全部改走 saveJson + 顶部错误提示条（三语 saveFail）；emails saveDraft 失败不再弹「已保存」；knowledge save/remove try/finally 复位按钮、失败不关弹窗并展示错误；safeFetchJson 失败 console.error 留痕。
- 测试：`tests/fetch-utils.test.ts` 8 例（mock fetch 200/500/网络失败 + 三页源码契约）。
- 风险：错误文案直接展示服务端 error 字段（可能与 i18n 文案混排，属可接受信息）。回滚：revert。

### [P0-8] 时区/货币链路不一致 — commit b731755
- 证据：fmtCurrency 固定 en-US；reservations 按浏览器本地落库而聚合按服务器 CST 切日；business-context 静默截断（20 评论/500 客户/200 支付）。
- 改动：fmtCurrency 增加 locale 参数（zh→zh-CN/es→es-ES），store 页币种随菜单数据；新增 `lib/time.ts`（businessDayRange/localDateInTimeZone/resolveBusinessTimeZone）；business-context/channels 简报/reservations GET 全部改业务时区零点切日；business-context 统计去截断（评分/待回复全量聚合、客户数 head-count、支付按状态计数），差评要点明确「最近 20 条」口径。
- 测试：`tests/format-time.test.ts` 14 例（EDT/EST/上海零点、zh/es 货币符号、聚合契约）。
- 风险：时区依赖 settings.locale.timezone（缺省 America/New_York），未配置时区的门店口径从「服务器本地」变为美东——对海外目标市场正确。回滚：revert。

### [P0-10] Python tenant_id 路径穿越 — commit b7cc1fd
- 证据：`api/app.py:576-593` `skill_dir = root/"skills"/f"tenant-{tenant_id}"/safe`；marketplace.install 同构；Pydantic 仅 min_length=1。
- 改动：新增 `roveagent/api/security.py`（require_safe_id `[A-Za-z0-9_-]` 1-64 fail-closed、sanitize_skill_name）；请求模型统一 `_TenantScopedRequest` 基类；Query 端点（sessions/memory/skills market/task_status）同校验；create_skill/install 路径拼接处二次校验。
- 测试：`roveagent/api/path_safety_test.py` 6 例（穿越/非法字符/目录外无写入/模型 422）。
- 风险：非法 tenant_id 请求从「可能越界写」变为 422 拒绝。回滚：revert。

### [P0-11] Python 门控链 fail-open 三处 — commit 92d17d1
- 证据：middleware 回调异常即跳过继续直执；工具策略兜底 `("*","",LOW,NONE)` 未登记工具免审批直执；权限由调用方 JSON 提供。
- 改动：(a) 安全中间件（`fail_closed` 标记，企业门控）异常 → 终止链返回 enterprise_gate_unavailable，普通中间件保持跳过语义；(b) 兜底策略仅放行「已注册」工具，未登记一律拒绝（HIGH/ADMIN 审计），write_file/patch 升级经理审批；(c) 新增 `api/permissions.derive_permissions`：客户端权限按角色允许集裁剪不能放大 + 员工档案固有能力服务端并入（chat 与 tool/resolve 两处接线）。
- 测试：`roveagent/enterprise/gate_fail_closed_test.py` 11 例（未知工具拒绝/注册工具保留/中间件崩溃阻断/普通跳过/写文件审批/权限推导）。
- 风险：任何未在策略表显式登记且未注册的工具调用会被拒绝（修复目标）；manager 集合补充了工具门控命名空间权限点。回滚：revert。

### [P0-12] Python 假执行 + 无锁 RMW — commit 6a5f07b
- 证据：`api/app.py:420-450` approved 即置 done 写「executed by …」；`api/tasks.py:74-102` 纯 RMW JSON。
- 改动：execute 类步骤改落「意图登记」（status=approved + step_intent_registered 审计，任务状态机新增 approved）；TaskStore 加乐观锁（version）+ per-scope 进程内锁，并发冲突抛 ConcurrentTaskUpdateError（execute 冲突方 409）；approvals/events 将 approval_policy=admin 映射为 owner（修复商户域无人可批死锁）。
- 测试：`roveagent/api/tasks_test.py` 5 例 + `tests/approval-deadlock.test.ts` 2 例（并发恰一次冲突、版本递增、旧数据兼容、execute 源码契约）。
- 风险：任务完成语义从「伪完成」变为「意图登记，等待工具链真实执行」——依赖 execute 完成的调用方需按新状态机处理。回滚：revert。

### [P0-13] healing/installer 死代码 RCE/自批原语 — commit 6611673
- 证据：healing.rollback `permissions.approve(...)` 快速通道 + git shell 拼接；installer 未校验输入拼 ssh + 硬编码 `POSTGRES_PASSWORD=roveframe`；grep 证实无调用方。
- 改动：rollback 移除自批（与 deploy 同要求人工批准）+ commit_hash 白名单；git 全部参数列表执行 + safe_commit_message 净化 + 沙箱测试 shlex 拆分；installer host/ssh_user/app_dir/domain 白名单校验 fail-closed + 每计划独立随机口令；新增 `docs/current/EXPERIMENTAL_MODULES.md` 威胁模型与启用门槛。
- 测试：`roveagent/deployment/installer_test.py` 5 例 + `tests/error-healing.test.ts` +3 例（不可从任何 API/任务路径触发、无 shell=True 拼接、无硬编码口令）。
- 风险：两模块保留构造但不接线；未来接线须先满足 EXPERIMENTAL_MODULES.md 门槛。回滚：revert。

### [P0-14] 迁移体系双源漂移 — commit 1688fa6
- 证据：MIGRATION_SQL（止于 platform_admin_audit_logs）与 4 个 SQL 文件漂移：staff 无 business_id、settings/store_qr_codes/model_configs 唯一键形态不一、agent_approvals/notifications/push_subscriptions 缺失。
- 改动：migration.ts 删除内嵌副本，autoMigrate 按序执行 `scripts/migrate.sql + migrate-business-tables.sql + migrate-pilot-ready.sql`（幂等）；平台管理/计费/审计/health_check DDL 并入 migrate.sql；新增 `scripts/verify-migrations.mjs`（schema 51 表全覆盖 + boot-check 必需表 + 唯一索引口径）并挂入 `pnpm validate`。
- 测试：比对脚本入 validate 链；`tests/amount-idempotency.test.ts` 契约更新。
- 风险：autoMigrate 依赖磁盘 SQL 文件（生产从仓库根启动，dist 部署需保留 scripts/）；新库会创建 pgvector 相关对象（Supabase 具备）。回滚：revert。

### [P0-15] email_send_tasks 无租约恢复 — commit 6eb82b0
- 证据：CAS 置 sending 后无回收；finalizeCampaignIfComplete 把 sending 视为未完成；SMTP 已发但回写失败会重发。
- 改动：`emailLeaseDecision` + `recoverStaleEmailSends`（sending∧claimed_at 超 15min → requeue+attempts+1 / 超 max→failed），出件主循环先行回收；sent 回写失败留痕（at-least-once 语义）；notification_outbox 同款 `recoverStaleOutboxItems`。
- 测试：`tests/email-lease.test.ts` 6 例（决策矩阵 + 接线契约）。
- 风险：崩溃残留行最多 15min 后重发（at-least-once，无 Message-ID 级去重——上游 SMTP 不提供，已文档化）。回滚：revert。

### [P0-16] Web Push 瞬时失败静默置 sent — commit 923e488
- 证据：push.ts 对非 410/404 失败只 failed++ 不抛；outbox 忽略返回值一律 sent；无订阅也计 sent。
- 改动：push 适配器返回结构化结果 {sent,failed,deleted,noSubscribers}（410/404 只删订阅）；outbox 对 sent===0 或 failed>0 视为未完成抛错 → attempts/backoff 重试；无订阅为终端失败（attempts=max，不再虚计 sent）；daily_briefing 幂等键契约锁定。
- 测试：`tests/push-retry.test.ts` 3 例。
- 风险：无 VAPID 配置或无订阅的推送项会转为 failed 而非静默 sent（更诚实，仪表盘可见失败）。回滚：revert。

### [P0-17] scheduler 60s tick 无互斥 — commit 4dbe223
- 证据：setInterval + void 无 in-flight 检测；多 business 串行无逐项 try/catch；长任务导致 tick 重叠与 cron_state 竞态重复外发。
- 改动：模块级 in-flight 锁（重叠 tick 跳过、卡死超 10min 强制续跑）；逐租户/逐 business 独立 try/catch；每日简报改 `claim_daily_briefing_slot` DB 原子抢占（update-where-guard + insert on conflict do nothing，RPC 入 migrate.sql 仅授 service_role；RPC 缺失回落旧路径并告警）。
- 测试：`tests/scheduler-mutex.test.ts` 4 例。
- 风险：跨实例原子性依赖新 RPC（旧库未跑迁移时回落读-判-写，多实例有极小重复风险，已告警）。回滚：revert。

### [P0-20] 任务引擎 worker↔schema 契约断裂 — commit 379b397
- 证据：worker 写 agent_type/priority/scheduled_at/attempt_number 与 QUEUED/COMPLETED 词汇，权威表为 task_type/name/schedule_cron/status'active'/attempt/pending/running；claim RPC 要求 run.pending+task.active，worker 从不写；detector 三类任务无 handler。
- 改动：worker/types 以 claim 语义重写（任务保持 active，运行 pending→running→completed/failed，attempt 计数，完成回写 last_run_at，去重走 (business_id,name) 唯一索引，claim 后回读 input）；detector 移除三类死任务创建（事件+通知 outbox 路径保留）。
- 测试：`tests/agent-tasks.test.ts` 重写为真实 schema 断言 6 例（列名/词汇/claim 语义/schema↔SQL 口径/detector 契约）。
- 风险：旧数据若存在 QUEUED 状态行将不再被认领（需一次性数据订正：`update agent_tasks set status='active'`、`update agent_task_runs set status='pending' where status='QUEUED'`）。回滚：revert。

### [P0-21] 审批 executing 无租约恢复 — commit fe934fc
- 证据：CAS 置 executing 后崩溃 → 永久卡死；退款可能在 provider 侧发生而库未回写，重复批准被拒、无对账路径。
- 改动：executing 超 15min（consumed_at 租约）CAS 回收 → pending 重放并留 approval.lease_recovered 审计；租约内返回 executing 中；重放安全依赖执行层幂等键（Stripe refund 幂等键冻结 invocation_id、roveagent 回调 execution_id 单次 claim）。
- 测试：`tests/approval-lease.test.ts` 3 例（纯判定 + 回收 CAS + 幂等键契约）。
- 风险：崩溃窗口 a（provider 调用前）安全重试；窗口 b（provider 后、库回写前）幂等键返回同一退款；窗口 c（库回写后、审批行回写前）重放会因 remaining 不足而报 failed——不产生重复资金，属已文档化边缘。回滚：revert。

## 验证矩阵（全绿）

| 步骤 | 结果 |
|---|---|
| `pnpm validate`（migrations 比对 + ts-check + lint + 415 tests + scan） | ✅（见最终跑批） |
| Python `unittest discover -s roveagent -t . -p *_test.py` | ✅ 60/60 |
| 新增测试 | TS +53（309→415 区间，含限流/RBAC/时区/租约/幂等/契约/前端）；Python +27（33→60） |
| `pnpm run e2e:recovery` | ⏭ 跳过：本机无真实 Supabase/SMTP 凭据栈 |
| 全库 `as any` / `@ts-ignore` | 0 / 0（未新增） |
| i18n 三语键 | en/zh/es 零漂移（深度比对通过；新增 saveFail/wipeFail 三语同 commit） |

## 剩余开放项（P1/P2，未在本轮处理）

- P1 表 31 项：P1-2 回执租约、P1-3 用量账本恢复、P1-4 别名、P1-5 square 游标、P1-6 IMAP UID 水位、P1-7 Telegram offset、P1-9 SSE 断连落库、P1-12 scan RPC、P1-20/21 前端竞态/SSE、P1-26 记忆围栏、P1-27 AIError 截断、P1-28 coding-agent 启用门等。
- P2 表 15 项：大文件拆分、死组件清理、a11y、依赖卫生（@aws-sdk 零引用）、validate:all 补全、AGENTS.md 指针化等。
- 建议下一步：按 P1 表继续逐项小步 commit；每项沿用「证据/改动/测试/风险」格式回填本报告姊妹篇。
