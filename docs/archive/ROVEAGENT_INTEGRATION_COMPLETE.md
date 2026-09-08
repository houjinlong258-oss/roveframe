# ROVEAGENT_INTEGRATION_COMPLETE.md
# RoveAgent × RoveFrame 深度融合完成报告（第二阶段）

日期：2026-09-05 ｜ 状态：✅ 十个 Phase 全部落地

终态产品身份：**RoveFrame AI Business OS — Powered by RoveAgent Core**。
RoveAgent 不再是独立 Python 包，而是 RoveFrame 的 AI 操作系统内核。

---

## 1. 架构（最终形态）

```
Next.js Frontend (src/app/[locale])
        │  SSE / fetch
RoveFrame API Layer (src/app/api/*)
        │  src/lib/roveagent/client.ts  ← 唯一接口面
RoveAgent Service (FastAPI, roveagent/api/)   ← ROVEAGENT_API_URL + X-RoveAgent-Key
        │
RoveAgent Runtime (core/: Agent Loop / 上下文 / 子代理并行 / 学习闭环)
        │
Agent Organization Layer (workforce/: 7 岗 AI 员工 + 目标引擎)
        │
Enterprise Tool Framework (tools/framework.py + enterprise/gate_hook.py)
        │
Business Connectors (connectors/: Square / Toast / Clover)
```

降级策略：RoveAgent 未配置/不可达时，`/api/agent/chat` 自动回退既有 TS
Agent 路径并日志告警——融合不以牺牲可用性为代价。

## 2. API 设计（roveagent/api/app.py，FastAPI）

| 端点 | 作用 | 验证 |
|---|---|---|
| `POST /api/agent/chat` | 与指定 AI 员工对话：**完整 Agent Loop 多轮工具循环**（`runtime.AIAgent.chat`，企业安全工具集 safe+memory，工具调用全量过门控；无 LLM 配置 503，不伪造回答） | ✅ |
| `POST /api/agent/task` | 自然语言目标 → 目标引擎拆解为分工任务（含审批步骤识别） | ✅ |
| `POST /api/agent/execute` | 执行已审批动作；未审批的高风险步骤保持 awaiting_approval | ✅ |
| `GET /api/agent/status/{task_id}` | 任务跟踪 | ✅ |
| `GET /api/agent/memory` | 企业经营记忆检索（强制租户过滤） | ✅ |
| `POST /api/agent/skill/create` | 创建业务技能（落盘 SKILL.md + 记忆 + 审计） | ✅ |
| `GET /api/health` | 健康检查 | ✅ |

认证：`X-RoveAgent-Key` 共享密钥；服务只监听内网/回环，信任边界在
RoveFrame 服务端。六个业务端点全部通过真实 HTTP 冒烟（uvicorn + requests，
`tests/e2e/roveagent_api_smoke.py`）。

## 3. 数据库变更

蓝图要求 `ai_providers / ai_credentials / ai_usage_logs`。经核查，RoveFrame
已有等价物理实现并内置更高标准的安全契约（AES-256-GCM 加密、掩码返回、
测试连接、模型目录）：

| 蓝图命名 | 物理实现 | 说明 |
|---|---|---|
| ai_providers | `model_configs` + `PROVIDER_CATALOG` | 连接/默认模型/启用状态/模型缓存 |
| ai_credentials | `model_configs.api_key_encrypted` | AES-256-GCM 密文，GET 仅返回掩码 |
| ai_usage_logs | `ai_usage_ledger` | token/成本/延迟/关联 ID 台账 |

决策：**不建平行表**（避免双数据源），新增
`scripts/migrate-ai-provider-views.sql` 以只读视图提供蓝图命名，继承底层
RLS 租户隔离。前端设置页 `src/app/[locale]/settings` 与
`api/settings/models`（增删改 + 连接测试 + 掩码）已存在并继续生效。

## 4. Agent 系统（Workforce）

`roveagent/workforce/employees.py`：7 岗 AI 员工，每位具备
Identity / Role / Department / Mission / Skills / Permissions / Tools /
Forbidden / KPIs / Escalation：

CEO（战略仲裁）、Operations（经营优化）、Marketing（增长留存）、
Customer（口碑沟通）、Finance（营收成本）、Developer（系统改进）、
DevOps（基础设施与自愈）。

`roveagent/workforce/goals.py`：Business Goal Engine ——
"月营收提升 20%" → 指标/目标值解析 → 5 步策略骨架（分析→分析→提案→
审批→度量）→ 自动分工到员工 → 审批步骤识别。营收/成本/口碑/库存四类
目标内置策略模板，其余走通用骨架。

行业包（Phase 8）：`roveagent/skills/packs/` 现有
restaurant / **retail / hotel / healthcare（本次新增）**，各含
agents / connectors / skills / templates / knowledge_base。

## 5. Provider 系统

多模型由两层共同满足：

- **TS 层（已存在）**：`provider-catalog.ts` 声明式目录（OpenAI / Anthropic /
  Gemini / DeepSeek / OpenRouter / 本地 OpenAI 兼容端点…），
  `settings/models` 管理连接，`usage-ledger.ts` 记账。
- **Python 层（RoveAgent）**：`roveagent/providers/` 声明式 ProviderProfile；
  chat 端点经 `ROVEAGENT_LLM_BASE_URL/API_KEY/MODEL` 走任意 OpenAI 兼容端点。

## 6. 安全模型

- **工具门控（Phase 6，已闭环）**：`EnterpriseToolGate` 注册为 Agent Loop
  原生 `tool_execution` 中间件（`enterprise/gate_hook.py`），每次工具调用
  强制 Schema → Permission → Risk → Approval → Audit；`RoveAgentKernel`
  启动即自动安装，宿主经 `set_tool_context_resolver` 注入身份。
  实测：无权限拒绝 / 经理发起 send_* 转 manager 审批 / admin 直执 /
  全部留痕。
- **记忆隔离（Phase 7）**：`state/enterprise_memory.py` L0–L4 分层，
  L2+ 强制 tenant_id（代码级不变量），FTS5 trigram 中文子串检索 +
  BM25/时效/重要度排序 + 过期策略。实测跨租户不可见。
- **凭据**：密钥 AES-256-GCM 落库、接口仅返回掩码、密钥永不进前端。
- **审计**：门控事件 + 内核动作双路留痕（JSONL + 租户 AuditLog）。

## 7. 部署模型

```
[RoveFrame Next.js]  pm2/docker, 既有部署不变
        │  ROVEAGENT_API_URL / ROVEAGENT_API_KEY（已写入 .env）
[RoveAgent Service]  bash scripts/roveagent-service.sh [--port 8788]
                     （= uvicorn roveagent.api.app:get_app --factory，
                       密钥从 .env 读取，ROVEAGENT_ROOT 默认 ./.roveagent）
```

RoveAgent 以独立进程/容器运行（Python 3.11–3.13）；渠道网关
（Telegram/Discord/Slack…）同源 `roveagent.gateway`，按需启用。

**部署验证（2026-09-05 实测）**：
- `scripts/roveagent-service.sh` 启动 → `/api/health` 200；无 key 401 ✅
- TS↔Python 链路（`scripts/e2e-roveagent-link.ts`，经真实
  `src/lib/roveagent/client.ts`）：task 创建（中文目标"月营收提升 15%"
  → metric=revenue/target=15%/5 步）→ status → execute（审批后 done）
  → memory → skill/create → chat（无 LLM key 时 503，不伪造）全通 ✅
- `pnpm dev` 启动无编译错误，`POST /api/agent/chat` 未登录返回规范
  401（路由编译运行正常，登录会话后进入 RoveAgent 分支）✅
- 修复记录：外部 tenant（Supabase 体系）审计不再 500，降级服务级日志 ✅

## 8. 端到端验证（Phase 9，tests/e2e/roveagent_e2e_scenario.py）

场景："本周销售为什么下降？"——

1. 一句话开店：租户 + 6 人 AI 团队 + Square 沙盒同步 ✅
2. Operations 分析 POS（只读工具门控放行，营收环比 -12%）✅
3. CEO 汇总生成建议（审计留痕）✅
4. Marketing 发起唤回活动 → 门控拦截转 manager 审批 ✅
5. 批准后执行：发送 86 人 ✅
6. 记忆：L2 写入、trigram 检索命中、跨租户隔离 ✅
7. 目标引擎："月营收提升 20%" → 5 步策略 + 审批识别 + 分工 ✅

另：全仓 `pnpm ts-check` 通过（chat 路由改造 + 新 TS 客户端零类型错误）。

## 9. 后续路线图

1. ~~chat 端点接完整 Agent Loop~~（已完成 2026-09-05：`agent_chat()` 经
   `runtime.AIAgent` 跑多轮工具循环，默认企业安全工具集 safe+memory，
   工具调用全量过 EnterpriseToolGate；接线验证：构造→工具 schema→
   HTTP 分发全通，伪端点下返回干净错误叙述）。
2. 审批回调：Python 侧 `requires_approval` 事件推送 RoveFrame 审批 UI
   （src/lib/agent/approvals.ts），批准后回调节点已预留（/api/agent/execute）。
3. 目标引擎策略模板接入 LLM 细化（骨架 → 具体文案/预算）。
4. 行业包扩充 knowledge_base 真实内容；Skill Marketplace。
5. 渠道网关上线 Telegram/Discord/Slack 企业经营通知。
6. chat 端点后续可选增强：会话级多轮上下文（当前每轮注入企业记忆，
   loop 内消息列表跨调用不持久）、按员工定制工具集。

**迁移质量修复记录（2026-09-05）**：首轮机器重写时，动态导入字符串
规则误伤了约 1,088 处裸字符串字面量（dict 键 "tools"、配置节 "cron"/
"gateway"、argparse dest "agent" 等被改成模块路径）。已全部还原并对齐
品牌（217 个 py 文件 + 14 个对齐文件），全量编译 + 912 模块导入扫描
0 内部断链 + Agent Loop 接线实测确认修复。该事件凸显：fork 机械重写
必须有"导入扫描 + 运行时冒烟"双门禁，已补入流程。

## 10. 合规

沿用第一阶段链路：roveagent/LICENSE（MIT，Nous Research）+ NOTICE。
本阶段新增代码（api/ workforce/ gate_hook enterprise_memory TS 客户端）
为 RoveFrame 自有。

## 11. 微信渠道接入（2026-09-05，iLink 个人微信）

按 RoveAgent 原生方式接入（腾讯 iLink Bot API），roveagent 源码零改动：

1. **登录**：`weixin_login.py`（工作区与仓库根目录）复用
   `gateway/platforms/weixin.py` 的 `qr_login` 端点逻辑，拆为
   `fetch`（取二维码）/ `poll`（轮询确认）两段。扫码确认后凭证自动写入
   `C:\Users\24749\AppData\Local\roveagent\.env`：
   `WEIXIN_ACCOUNT_ID` / `WEIXIN_TOKEN` / `WEIXIN_BASE_URL` /
   `WEIXIN_CDN_BASE_URL` / `WEIXIN_DM_POLICY=pairing` /
   `WEIXIN_ALLOWED_USERS`（已授权 1 个微信 ID）。
2. **依赖**：托管 Python 新增 `aiohttp`、`qrcode`、`rich`；
   pyproject 补充 `weixin` extra（aiohttp+qrcode+cryptography）。
3. **CLI 入口**：pyproject 新增 `[project.scripts] roveagent`，
   `pip install -e . --no-deps` 后可直接敲 `roveagent gateway run`
   （--no-deps 避免 exact-pin 依赖清单扰动共享运行时）。
4. **验证**：`roveagent gateway run` 实测 `✓ weixin connected`，
   iLink 长轮询收到 3 条真实入站私信；白名单授权生效。
   出站回覆链路（入站 → Agent 生成 → sendmessage）交由用户自测。
5. **常驻**：`roveagent gateway install` 可注册为 Windows 计划任务
   （登录自启）；前台调试用 `roveagent gateway run`。
6. **风险提示**：个人微信机器人存在封号风险，建议使用非主力微信号；
   企业经营场景可后续切换企业微信通道。

## 12. 后续路线图补充

- 渠道网关：微信 ✅（本条）→ Telegram/Discord/Slack 依次接入。

## 13. 渠道网关三平台上线工具链（2026-09-05，Telegram/Discord/Slack）

- 依赖已安装：python-telegram-bot 22.8 / discord.py 2.7.1 / slack-bolt 1.30 + slack-sdk 3.44（托管 Python）。
- 新增 `scripts/gateway-channels.py`：四渠道（telegram/discord/slack/weixin）就绪体检
  （deps / token / enabled 三栏），`--enable` 把 token 就绪的平台写入
  `config.yaml` 的 `gateway.platforms.<name>.enabled: true`（幂等，list 形态自动升级 dict）。
- 沙盒实测：模拟 token → --enable → GatewayConfig.from_dict 解析 enabled=true 全通。
- **待用户提供**：TELEGRAM_BOT_TOKEN（@BotFather）、DISCORD_BOT_TOKEN（Developer Portal）、
  SLACK_BOT_TOKEN + SLACK_APP_TOKEN（api.slack.com）。token 写入
  `%LOCALAPPDATA%\roveagent\.env` 后跑 `python scripts/gateway-channels.py --enable`
  再 `roveagent gateway run` 即上线。

## 14. chat 端点会话级多轮上下文持久化（2026-09-05）

- 新增 `state/chat_sessions.py`：按 (tenant_id, session_id) 隔离的 SQLite 会话存储
  （`<root>/chat_sessions.db`），注入窗口 20 轮、每会话落库上限 200 条自动截断。
- `/api/agent/chat`：新增 `session_id`（缺省落 `default-<agent>` 会话），调用前把历史
  以 `prefill_messages` 注入 Agent Loop，完成后本轮 user/assistant 落库；
  响应新增 `session_id` / `history_turns`。
- 新端点：`GET /api/agent/sessions`（会话列表）、`DELETE /api/agent/sessions/{id}`。
- RoveFrame 侧：TS chat 路由把既有 chat_sessions 表的 session id 透传给
  RoveAgent，两侧会话对齐；`roveAgentChat` 支持 sessionId。
- 验证：存储 5 场景单测（正序回放/租户隔离/截断/列表/窗口）+ 服务端点实测
  （503 不伪造、会话列表、跨租户不可见、删除生效）全过。
