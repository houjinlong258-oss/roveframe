# RoveFrame AI Business OS — Current State Report

**审查日期：2026-09-05**  
**结论：Pre-Production Beta；工程底座约 72%，可售商业闭环约 38%**

## 审查边界

本审查以当前工作区源码、迁移脚本、测试、运行脚本和浏览器验收材料为准。产品愿景文字和 CTO/架构提示作为产品要求与评审标准使用；它们不是额外的代码执行授权。附件《RoveFrame_缺口与内部欠账清单》是 2026-09-04 的评估材料，其中部分“缺失”结论早于当前工作区的 Square 与审批台改动，以下报告以代码实态纠正这些快照。

已执行的验证：

- `pnpm test`：**166/166 通过，26 个套件**。
- `pnpm ts-check`：通过。
- `pnpm next build`：成功；仅有 coding-agent 动态文件扫描范围过宽的 4 个性能警告。
- 改动文件 ESLint：通过（命令执行中未发现错误）。
- `git diff --check`：通过。
- 全量 Stylelint：未通过，发现 `src/app/globals.css` 中 **80 个既有规则问题**；该文件不是本轮改动，已作为仓库卫生债务记录，不做自动格式化覆盖。
- 未执行真实 Supabase 登录、迁移、第三方 POS、支付或 IMAP 验收：本机没有可用的生产凭据。

## 结论摘要

RoveFrame 已经不是只有页面的演示应用。它有 Next.js 16/React 19 前端、Supabase 数据访问、三语路由、SSE AI 对话、租户上下文、RBAC、企业 Agent 工具、持久化任务与通知 outbox、审批台、错误分析和部署产物生成器。`src/lib/auth-guard.ts:300` 的 `withAuth`、`src/lib/tenant.ts:31` 的验证身份解析、`src/lib/enterprise/tool-runtime.ts:49` 的工具目录，以及 `src/lib/scheduler.ts:199` 的调度入口均为真实代码，161 个既有测试加本轮 5 个生产安全测试全部通过。

距离最终商业产品的主要差距不在“再做几个页面”，而在真实商业闭环：外部数据仍只打通 Square；支付目前有 Stripe 测试模式收款切片，但退款和对账没有实现；邮件只有 SMTP/发送和 AI 分类，没有 IMAP 收件同步；自愈尚未接入审批后的部署；安装器只生成文件；注册仍是传统表单，不能用一句自然语言创建工作区、AI 员工和工作流。

**当前 Go/No-Go：** 可以邀请少量餐饮客户做受控 Beta，不能宣称“接上现有系统后自动运营”，也不能开放真实收款或无人审批的外部操作。

## 模块完成度评分

分数表示“达到可向真实客户承诺的程度”，不是代码行数占比。

| 模块 | 完成度 | 已验证事实 | 主要缺口 |
|---|---:|---|---|
| 账户、登录、会话 | 75% | Supabase Admin 建用户、HttpOnly cookie/Bearer、JWT 本地验签、401/403 测试 | 邮箱验证、密码找回、OAuth、邀请接受页和账号恢复还未形成完整产品流程 |
| 租户隔离与 RBAC | 76% | proxy 统一边界、`tenantTable`/作用域写入、owner/manager/staff、角色测试 | 部分旧表和 Drizzle 类型仍与迁移表结构不一致；完整 RLS 策略和有凭据验证尚未完成 |
| 餐饮数据 CRUD | 78% | 产品、订单、库存、客户、评论、预约、二维码、媒体上传 | 多业务/多门店管理、导入导出、数据修正和真实 POS 主数据冲突策略不足 |
| AI COO 对话 | 72% | SSE、业务上下文、外部模型路由、工具调用、确定性降级 | 没有基于真实外部数据的连续运营证明，缺少可解释指标、引用来源和失败重试体验 |
| Agent 企业内核 | 68% | 六类 Agent、命名空间权限、Zod 输入校验、超时、审计、任务队列 | RoveAgent 尚未形成运行时集成；没有租户级 Agent 实例配置、版本化 skill 和成本/配额控制 |
| 人工审批 | 82% | 提案列表、diff、状态流转、Apply/Rollback、审计，Phase 8 浏览器验收 | 业务写工具覆盖有限，审批通知、SLA、多人审批策略和支付类审批缺失 |
| 外部集成 | 42% | 集成配置加密、连通性测试、Square 拉取同步和签名 Webhook（`src/app/api/integrations/[provider]/sync/route.ts:18`、`src/app/api/webhooks/[provider]/route.ts:13`） | ERPNext/Shopify/Toast/Clover 仅有配置或测试，缺同步/Webhook；缺统一游标、DLQ、重放 |
| 支付 | 24% | Stripe hosted Checkout、`payments`/`payment_events` 表、签名 Webhook、事件幂等、按币种最小单位换算已实现；设置页有 Stripe/PayPal 连通性测试 | 无退款 API、每日对账、争议处理、PayPal capture 和支付 UI；真实凭据验收未完成 |
| 邮件中心 | 55% | SMTP/真实发送、AI 分类、回复草稿、队列数据结构 | 没有 imapflow 收件同步、OAuth refresh、线程去重和退信处理 |
| 自动化与通知 | 61% | cron_state、Durable task、重试/租约、事件检测、outbox、Web Push/渠道发送 | 生产迁移未在目标库执行；通知派送默认 opt-in；缺可视化任务控制台和长期运行 SLO |
| 自愈与开发 Agent | 48% | 错误采集/分析/补丁提案、路径权限、worktree、测试门禁、回滚 | 未形成“生产错误→审批→部署”的闭环；未有隔离容器、签名制品和真实部署编排 |
| 部署 | 35% | Dockerfile/Compose/Nginx/deploy.sh 生成及配置校验 | 没有远程安装、域名/证书状态、环境密钥托管、健康监控和回滚控制面 |
| PWA/移动端 | 46% | manifest、InstallPrompt、离线页、设备收藏、Web Push API | Service Worker 当前明确 `disable: true`；没有老板移动审批/简报 inbox |
| UI/UX 与 onboarding | 64% | 10 个管理页、深浅色、时区主题、三语、响应式壳层 | 注册是 email + business name + industry 表单；没有自然语言建店、向导式连接、空状态和首日成功路径 |
| 可观测性与合规 | 47% | audit_logs、agent_actions、错误指纹与持久化回退 | 没有集中 metrics/traces、数据保留/删除策略、DPA/导出、密钥轮换和租户审计导出 |
| 测试与交付 | 74% | 166 单测、CI workflow、类型检查、Lint、审批 E2E 演练脚本 | 缺真实第三方 contract tests、浏览器主路径回归、迁移 preflight、负载和灾备演练 |

按商业价值加权，当前约 **72% 工程底座、38% 可售闭环**。后者较低是因为支付和外部数据是真实经营的必要条件。

## 已完成且可复用的能力

### 请求、身份和租户

`src/proxy.ts` 覆盖 `/api` 网络边界，公开白名单只包含登录、注册、登出、顾客点餐/店员和 Webhook；其他请求必须通过 Supabase token。`src/lib/auth-guard.ts` 会先剥离伪造的 `x-rf-*` 头，再注入服务端上下文；敏感 coding-agent、healing、deployment、enterprise API 还使用 `withAuth` 二次校验。业务查询大量使用 `tenantTable`、`scopedTable` 和 `*_WithTenant` 写入器。

### AI 与审批

`src/lib/enterprise/agents.ts:29` 定义 CEO、Operations、Marketing、Customer、Developer、DevOps 六个角色；工具运行时将角色命名空间、RBAC、Zod schema、超时和 `agent_actions` 审计串成一条闸门。写工具进入 `agent_approvals`，coding-agent 则经过 diff 检查、worktree、测试门禁、merge 和 revert。附件验收中记录的真实 Apply/Rollback commit 与当前 git 历史一致。

### 业务数据和扫码点餐

产品媒体上传、公开 QR token、菜单、服务员小费、服务端重算价格和 Square 订单标准化已经存在。Square 客户端使用 Orders API，并以签名 URL + HMAC-SHA256 校验 Webhook。需要注意：附件清单声称 A1/A3 不存在，但当前源码已有 Square 最小闭环；它仍不是 POS 生态完成，因为没有 OAuth 授权 UI、游标/分页完整性、重放和对账。

## 已确认的商业缺口

1. **连接现有软件**：同步路由当前对非 Square provider 返回 `sync not implemented`；没有 ERPNext 库存/供应商/采购单同步，也没有 Shopify/Toast/Clover 数据流。
2. **支付**：本轮已加入 Stripe hosted Checkout、`payments`/`payment_events`、Webhook 签名和事件幂等；仍缺退款 API、每日对账、争议处理、PayPal capture 及支付 UI。
3. **收件**：`imapflow` 在依赖中，但 `src/lib` 没有收件适配器；邮件页面只能依赖 seed/手工写入。
4. **自然语言建店**：注册创建 tenant/business/user，但没有从“我经营一家纽约寿司店”提取地点、目标、菜单、营业时间、员工、连接器，并生成 Agent/skill/workflow。
5. **持续运营证据**：scheduler 有每日简报骨架，但 `cron_state` 缺失时主动跳过；尚未用真实租户连续运行两周并量化成功率。
6. **自助部署**：deployment generator 只返回 Dockerfile、Compose、Nginx 和脚本，不执行远程安装、域名绑定、密钥注入、监控或回滚。
7. **自愈**：error collector/analyzer/patch-generator 与 coding proposal 各自存在，但没有生产错误自动入提案、审批后部署、健康检查和自动回滚的可验证管道。
8. **行业复制**：当前 Agent prompt、字段和 UI 仍以餐厅为中心；Hotel/Retail/Healthcare 没有行业包和 connector marketplace。

## 技术风险和业务风险

| 优先级 | 风险 | 证据 | 处理 |
|---|---|---|---|
| P0 | 收款闭环尚未可对客户承诺 | Stripe Checkout/Webhook 已有，但尚无退款、对账和真实凭据验收 | 完成 Stripe test-mode 验收、对账和退款，再做 PayPal |
| P0 | 外部数据缺失使 AI 洞察停留在 seed/本地数据 | provider sync 仅实现 Square | 先 Square production OAuth/Webhook/replay，再 ERPNext |
| P0 | 生产加密配置错误可能造成凭据泄露或不可解密 | 本轮已移除生产默认开发密钥；仍需显式密钥治理 | 使用 Secret Manager、启动 preflight、轮换流程 |
| P1 | 公共点餐重复下单 | 原接口每次重试生成新订单 | 本轮加入 Idempotency-Key、租户范围查询和部分唯一索引；需在目标库迁移并做并发测试 |
| P1 | 调度器在缺表时静默不运行 | `ensureCronState()` 发现错误即跳过 | 部署前 migration gate；增加运行心跳与告警 |
| P1 | 业务邀请可能跨业务挂载成员 | 原接口直接采用客户端 `business_id` | 本轮校验业务属于当前租户，且 manager 只能邀请到自己的业务 |
| P1 | 数据结构漂移 | Drizzle 仍有 provider 全局 unique/部分表无 tenant 字段，SQL 又按租户改造 | 统一 schema source，生成迁移快照并加入 schema diff CI |
| P2 | 自愈/部署误操作 | 目前只有代码路径保护，无容器隔离和制品签名 | 沙箱、签名、审批、健康检查、自动 rollback |
| P2 | 交付不可追溯 | 工作区有大量 modified/untracked 外来目录 | 分批提交、迁移 docs、清理仓库后再发 beta |

## 本轮直接实施

### 1. 生产加密 fail-closed

修改 `src/lib/crypto.ts`：生产或 `NODE_ENV=production` 未配置 `ENCRYPTION_SECRET` 时抛出明确错误，只有非生产保留开发 fallback。原因是可预测的默认密钥会让所有租户凭据共享同一恢复密钥。风险是未设置密钥的生产启动会更早失败；这是有意的部署门禁。

### 2. 邀请业务范围校验

修改 `src/app/api/auth/invite/route.ts`：`business_id` 必须属于当前 tenant；manager 只能邀请到自己的 business；缺少 business scope 返回 400。防止 owner/manager 使用客户端参数把用户挂到错误业务。

### 3. QR 下单幂等

修改 `src/app/api/store/orders/route.ts` 与 `src/lib/storefront.ts`：接受受限格式的 `Idempotency-Key`，在同租户 QR 订单中查找并返回原订单，写入 `orders.external_id`；迁移脚本和内嵌迁移增加 `(tenant_id, external_id)` 的 QR 条件唯一索引，并为旧订单表补齐缺失列。这样网络重试不会重复创建订单；并发语义仍需在真实数据库执行迁移后验证。

### 4. 迁移与类型一致性修正

`scripts/migrate-business-tables.sql` 不再为 `model_configs.provider` 和 `integration_configs.provider` 创建全局 unique，改由租户范围索引治理；并增加 QR 幂等索引。迁移顺序已保证索引在 `tenant_id` 加入后创建。

### 5. Stripe 测试模式收款切片

新增 `src/lib/payments/stripe.ts`、`src/app/api/payments/checkout/route.ts` 与统一 Webhook 的 Stripe 分支：服务端按金额创建 hosted Checkout，按 USD/JPY/KWD 等币种使用正确的最小单位，先写租户/业务范围内的 payment 记录，再把 session id/URL 回写；回跳地址限制在配置的应用来源，避免开放重定向；Webhook 使用 timestamped HMAC、`payment_events` 唯一键和 payment metadata 更新 `paid`/`failed`/`refunded` 状态。新增纯函数测试覆盖金额边界、零位/三位币种、签名时效和伪造签名。该切片不会在本机调用 Stripe，退款、对账和支付页面仍在路线图中。

## 仓库和运行状态

当前工作区在本轮开始前就有大量 modified/untracked 文件，包括页面、消息、迁移和 `RoveAgent Core-2026.8.31` 等外来目录。本次没有清理、移动、提交或覆盖它们。`.gitignore`、`tsconfig` 和报告文件的整理仍需单独的仓库卫生迭代。数据库迁移未在外部 Supabase 执行，因此 `coding_proposals`、`error_events`、`cron_state`、`payments` 等持久化能力在没有迁移的环境会回退或跳过。

## RoveAgent / RoveAgent 判断

仓库包含 RoveAgent 源码目录，但当前 TypeScript 应用没有把 RoveAgent Python conversation loop 作为运行时依赖；现有 `src/lib/enterprise` 是 RoveFrame 原生组合层，实际复用的是 Agent 角色、工具、内存、任务和审批边界。短期继续保持“适配器而非 fork”：先把租户、权限、审计、业务工具和任务协议稳定，再通过版本化 REST/SSE worker 接入 RoveAgent 的推理循环。不要在 Phase 1 把 130+ 通用终端工具暴露给商业租户。

## 投资人/客户级判断

可以把产品定位为“餐饮 AI COO 受控 Beta”：客户连接 Square 后获得订单洞察、评论/客户分析、营销草稿和需要审批的业务动作。暂时不能承诺支付、ERPNext 自动采购、跨行业模板、远程一键部署或无人值守自愈。完成路线图 Phase 1-2 的验收门槛后，才具备第一批付费客户的可信商业闭环。
