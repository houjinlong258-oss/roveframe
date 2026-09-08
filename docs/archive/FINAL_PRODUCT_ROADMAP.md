# RoveFrame AI Business OS — Final Product Roadmap

路线围绕一个可验收闭环推进：**真实数据进入 → AI 找到问题 → 生成可解释方案 → 人批准 → 执行 → 记录结果 → 持续改进**。每阶段都保留现有系统，禁止在没有迁移、回滚和客户验收的情况下大规模重写。

## Phase 1 — Production foundation（4–6 周，P0）

**目标：** 让一个真实租户安全、可恢复、可观测地运行。

**代码：** 完成 production preflight（必需环境变量、加密密钥、数据库版本、Webhook secrets）；统一 `withAuth`/`getTenantContext`；为所有公共写接口增加限流、幂等和请求体上限；把 `error_events`、`coding_proposals`、`cron_state`、`agent_actions` 的持久化探测加入启动门禁；统一错误码与 correlation id；补 schema drift 检查。

**数据库：** 在事务中执行 `migrate.sql`、`migrate-business-tables.sql`、`migrate-production-hardening.sql`；为所有业务表完成 tenant/business 外键、RLS policy、租户索引；增加 payment 基础表、Webhook event 去重表；备份、恢复和迁移 checksum。

**UI：** 增加 Setup checklist（数据库、加密、邮件、连接器、通知）；显示“演示数据/真实数据”状态和最后同步时间；Owner 的安全与审计页。

**测试：** Supabase 临时项目迁移 smoke、RLS 跨租户负例、并发 QR 幂等、401/403 全路由矩阵、Playwright 登录/登出/回跳、备份恢复演练。

**复杂度：** 中高。  **出口标准：** 无生产默认密钥；迁移可重复；跨租户读写负例全部拒绝；scheduler 有心跳；所有公共写请求有幂等策略。

## Phase 2 — Restaurant AI COO MVP（6–8 周，P0/P1）

**目标：** 五家餐厅连续两周使用真实数据，并每天得到可行动结果。

**代码：** 完成 Square OAuth、location 选择、订单/目录同步游标、Webhook 重放和死信；实现 ERPNext client、库存/供应商/采购单同步；把销售下降、差评、低库存检测生成事件、简报和审批草稿；加入结果反馈（采纳、忽略、效果）。

**数据库：** `integration_sync_runs`、`integration_events`、`dead_letter_events`、`business_goals`、`recommendation_outcomes`；外部 ID 条件唯一约束；库存批次/供应商字段；支付流水表为 Stripe Phase 2 预留。

**UI：** 首次配置向导：自然语言描述 → 行业/地点/币种确认 → 连接 Square/ERPNext → 选择简报渠道；Dashboard 用“事实、原因、建议、批准”四段式卡片；同步错误和重放页面。

**测试：** Square/ERPNext mocked contract tests、Webhook 签名/重放/乱序、订单幂等、真实客户脱敏回放、简报连续运行 14 天、AI 洞察与原始指标一致性。

**复杂度：** 高。  **出口标准：** 连接后 15 分钟内有真实订单；同步失败可重试；每日简报成功率 ≥99%；五家客户每周至少批准一次建议。

## Phase 3 — RoveAgent Enterprise Kernel（6–10 周，P1）

**目标：** 将现有企业层变成可版本化、可配额、可扩展的 Agent Runtime。

**代码：** 定义 Agent Run/Tool Call/Approval/Outcome 协议；租户级 Agent instance、skill registry、prompt/version 管理；任务取消、预算、token/cost 统计；将 RoveAgent 作为可替换的 REST/SSE reasoning worker 适配，不直接暴露终端工具；统一 business memory 的 tenant/business/customer 过滤。

**数据库：** `agent_instances`、`agent_versions`、`agent_skills`、`agent_runs`、`tool_calls`、`usage_ledger`；审计 append-only 策略和 retention job；RLS 与敏感字段分离。

**UI：** Agent Center 显示每个员工的职责、权限、最近运行、成本、暂停/恢复；Skill 版本和变更审批；运行详情可查看输入事实、工具调用、结果和人工决定。

**测试：** tool fuzzing、权限矩阵、预算超限、取消/重试/租约、跨租户 memory 负例、RoveAgent adapter contract、长上下文压缩。

**复杂度：** 高。  **出口标准：** 每次外部写操作都有 approval/audit/idempotency；租户能暂停单个 Agent；运行成本可追踪。

## Phase 4 — POS ecosystem（8–12 周，P0/P1）

**目标：** 覆盖餐厅客户最常见的系统，不要求客户替换 POS。

**代码：** Square production hardening 后依次加入 Toast、Clover、Shopify POS、Lightspeed、Oracle MICROS；统一 OAuth token refresh、分页/游标、字段映射、时区和货币；Webhook 统一入口、签名验证、事件版本和 DLQ；目录/客户/退款状态同步。

**数据库：** 每个 connector 的 account/location/cursor、raw event（加密/脱敏）、mapping、sync checkpoint、DLQ、replay audit；source + external_id 唯一性。

**UI：** Connector marketplace、权限范围说明、连接健康、字段映射预览、首次同步预览和冲突处理。

**测试：** 每家供应商 sandbox contract、token 过期、限流、乱序/重复 webhook、部分失败、数据回放和租户隔离。

**复杂度：** 很高。  **出口标准：** 每个 connector 有 sandbox 订单从接入进入 Dashboard 的证据；同步延迟、失败率和重放指标可见。

## Phase 5 — Autonomous deployment（6–8 周，P2）

**目标：** 让非技术商家安全上线，而不是只下载脚本。

**代码：** 将 deployment generator 接入部署 provider adapter；环境预检、域名验证、证书、密钥注入、迁移锁、健康检查、版本发布、回滚；短期支持一类 VPS/云 provider，后续扩展。

**数据库：** `deployments`、`deployment_releases`、`deployment_checks`、`deployment_secrets_refs`；发布制品 digest、操作者、审批和 rollback 关系。

**UI：** Deployment wizard、进度日志、健康状态、域名、版本、回滚按钮；所有远程动作显示范围和风险。

**测试：** 临时 VPS/容器验收、网络中断、迁移失败、证书失败、健康检查失败自动回滚、密钥不出日志。

**复杂度：** 高。  **出口标准：** 新租户可在 15 分钟内完成部署；失败不会留下半配置实例；回滚可重复。

## Phase 6 — Self-healing production system（8–12 周，P2）

**目标：** 技术问题能被发现、诊断、验证并在人工控制下修复。

**代码：** error collector → analyzer → coding proposal → sandbox worker → test gate → approval → signed release → deploy → health monitor → rollback；加入错误预算、冷却时间、同指纹去重和人工升级；修复 proposal 只能改白名单定制层，核心代码走人工工程流程。

**数据库：** `repair_incidents`、`repair_attempts`、`sandbox_runs`、`release_artifacts`、`health_checks`；不可变审计和保留策略。

**UI：** Incidents、根因证据、补丁 diff、测试结果、风险、批准/拒绝、部署和回滚时间线；明确“建议/已验证/已部署”。

**测试：** 注入已知故障、未知故障人工升级、恶意 patch、路径穿越、sandbox 出网限制、发布签名、自动回滚和审计完整性。

**复杂度：** 很高。  **出口标准：** 任何修复都不能绕过审批；已知故障在 sandbox 验证后能安全回滚；线上无 silent failure。

## Phase 7 — Multi-industry expansion（持续，P3）

**目标：** 在餐饮闭环稳定后复制到 Hotel、Retail、Healthcare 等行业。

**代码：** `IndustryPack` 接口（schema、skills、metrics、workflows、connectors、compliance）；行业模板市场；每行业独立 feature flags 和数据保留规则；Healthcare 先做非医疗运营，避免越界到诊疗建议。

**数据库：** industry/version、字段扩展、模板安装记录、行业指标定义、合规策略；迁移按 pack 版本。

**UI：** 行业选择、模板预览、可配置业务目标和工作流；模板安装/升级/回滚。

**测试：** 每行业 golden datasets、模板升级/回滚、权限与合规负例、连接器 contract tests、客户可用性测试。

**复杂度：** 很高。  **出口标准：** 每个新行业至少有一个真实业务闭环和明确不支持范围；不会复制餐饮字段造成数据污染。

## 依赖和发布顺序

Phase 1 是所有生产发布的门槛；Phase 2 必须先于行业复制；Phase 3 的协议稳定后再深度接 RoveAgent；Phase 4 与支付可并行但必须共享事件幂等/DLQ；Phase 5/6 不应在没有审计和发布回滚的情况下开放；Phase 7 以餐饮两周稳定数据为前置条件。

## 第一批执行清单（接下来 10 个工作日）

1. 在临时 Supabase 项目跑三份迁移，记录 checksum、RLS 和回滚验证。
2. 完成 Square OAuth/location/sync cursor/webhook replay，并用 sandbox 订单验收。
3. 用 Stripe test-mode 验收现有 payment session/payment_events 切片，补预约订金状态机、退款和每日对账。
4. 建立 IMAP adapter 的 OAuth/password 两种凭据路径，先做收件入库和 message-id 去重。
5. 加入启动 preflight、schema drift CI、QR 并发幂等测试和全路由 Playwright smoke。
6. 让五家餐厅试用两周，记录建议采纳率、同步失败率、简报成功率和人工节省时间，再决定 Phase 3 投入。
