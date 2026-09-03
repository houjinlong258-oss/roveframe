# RoveFrame 开发进度报告

> 更新时间：2026-09-02
> 覆盖范围：从「Ph1 垂直 SaaS」到「AI Business Generator 平台」的全部工作。
> 状态口径分三级：✅ 代码就位（typecheck+lint 通过）｜ ⚠️ 代码就位但未部署激活（等 SQL 迁移）｜ ❌ 未做

***

## 0. 一句话状态

**垂直 SaaS（餐饮）的功能已基本做深**（小费/归因/社交渠道/记忆/技能/多模态），
**平台化（多租户）的地基代码已铺好但未在数据库生效**（缺一次 SQL 迁移 + 一条 `DATABASE_URL`），
**AI 生成器、部署、商业化、生态**尚未启动。

***

## 1. ✅ 已完成（代码就位）

### 1.1 垂直 SaaS 功能

| 功能                       | 说明                                  | 关键文件                                             |
| ------------------------ | ----------------------------------- | ------------------------------------------------ |
| Smart Tip 小费系统           | 下单选 15/18/20/自定义小费；员工归因；AI 小费洞察     | `api/business/tip-insight`、`staff`、`orders.tip*` |
| Smart Order Intelligence | 热销时段 / 菜品组合 / 复购率                   | `api/dashboard`                                  |
| AI COO 归因升级              | 环比/分渠道/差评/库存归因（修了低库存判断 bug）         | `lib/business-context.ts`                        |
| AI 商品创建/优化               | 文本 + **图片多模态** 生成名称/描述/分类/SEO       | `api/business/products/generate`                 |
| Knowledge Brain 长期记忆     | 对话后自动沉淀企业经验、对话前注入（prefetch/sync）    | `lib/memory.ts` + agent 路由                       |
| 行业 Skills 包              | Restaurant/Cafe/Retail/Service 领域能力 | `lib/skills.ts`                                  |

### 1.2 社交通讯渠道（Channels）

| 状态          | 渠道                                                                  |
| ----------- | ------------------------------------------------------------------- |
| ✅ 可用        | Telegram（含双向查询）、WhatsApp、Slack、Discord、Mattermost、Matrix、飞书、企业微信、钉钉 |
| ⚠️ 预设但需自建桥接 | Signal、BlueBubbles(iMessage)、WeChat、QQ Bot                          |

配套：每日简报定时推送 + 异常告警推送 + 消息发送/测试/断开（`lib/channels.ts` + `scheduler`）。

### 1.3 基础设施

| 功能        | 说明                                                           | 关键文件                  |
| --------- | ------------------------------------------------------------ | --------------------- |
| 多模态 AI 路由 | `ChatMessage.content` 支持图片；Anthropic/OpenAI 图片协议             | `lib/ai/router.ts`    |
| AI 路由层    | 10 家服务商 + 平台内置兜底 + auto 分流                                   | `lib/ai/provider*.ts` |
| 自动建表      | `autoMigrate()`（支持 `DATABASE_URL` 或 `SUPABASE_ACCESS_TOKEN`） | `lib/migration.ts`    |
| 启动自检      | `runBootChecks()` 探测缺表/缺列并打印清晰提示                             | `lib/boot-check.ts`   |

***

## 2. ⚠️ 已完成但未「部署激活」（等 SQL 迁移）

下面这些**代码已写、typecheck+lint 已过**，但它们在数据库里**还缺表/缺列**，运行时才会报错：

| 依赖的 SQL                                                                 | 对应代码               |
| ----------------------------------------------------------------------- | ------------------ |
| `cron_state` 表                                                          | scheduler / 定时任务   |
| `staff` 表                                                               | 员工 Tab / 小费归因      |
| `business_memories` 表                                                   | Knowledge Brain 记忆 |
| `orders.tip / tip_percent / tip_staff_id`                               | 小费系统               |
| `tenants/businesses/users/roles/user_roles/audit_logs` + 全表 `tenant_id` | P0 多租户             |

**所需动作**：在 Supabase SQL Editor 跑 `scripts/migrate.sql`，或提供 `DATABASE_URL` 后 `pnpm tsx scripts/run-migrate.ts`（或启动时自动）。

***

## 3. ❌ 未完成（按 P0 → P3）

### P0 多租户（S1 已做地基，S2–S4 未做）

| 项                                                            | 状态                                    |
| ------------------------------------------------------------ | ------------------------------------- |
| 6 张平台表 + 全表 `tenant_id` 的 **DDL**                            | ⚠️ 已写（`migration.ts` / `migrate.sql`） |
| `tenant.ts` / `tenant-db.ts` / `audit.ts` / `rbac.ts`        | ✅ 已写（地基代码）                            |
| **Auth 接入**（`api/auth/*` + Supabase Auth + JWT tenant claim） | ❌ 未做                                  |
| **逐路由接线**（Part F，20+ route 加 tenant 过滤）                      | ❌ 未做（**必须在 SQL 部署后**）                 |
| 前端角色渲染（Owner/Manager/Staff）                                  | ❌ 未做                                  |
| 审计切入（所有 mutation 走 `writeAudit`）                             | ❌ 未做                                  |

### P1 AI 生成核心（除了「商品生成」简化版，其余全没做）

| 项                                                | 状态                    |
| ------------------------------------------------ | --------------------- |
| 商家资料上传中心（PDF/Excel/图片/文本解析）                      | ❌                     |
| Business Understanding Agent（资料 → BusinessDraft） | ❌                     |
| Schema Engine（BusinessDraft → schema\_config）    | ❌                     |
| 组件库 / 行业模板                                       | ❌（仅 `skills.ts` 提示词级） |
| Frontend Generator（schema\_config → 页面）          | ❌                     |

### P2 部署 + 商业化

| 项                                       | 状态                   |
| --------------------------------------- | -------------------- |
| Docker 部署（Dockerfile/compose/nginx/SSL） | ❌（只有 build/start 脚本） |
| Deployment Engine                       | ❌                    |
| AI COO Planning（多步工具调用）                 | ❌                    |
| Stripe 订阅（$99/299/299+ 三档）              | ❌（需 Stripe keys）     |

### P3 生态

| 项                        | 状态    |
| ------------------------ | ----- |
| AI Workforce Marketplace | ❌ 未启动 |

### 需外部凭据才能做的

| 项             | 卡点                               |
| ------------- | -------------------------------- |
| Stripe 订阅     | `STRIPE_SECRET_KEY` + 定价/Webhook |
| Review 真实 API | Google Business / Yelp 授权        |
| 财务只读          | QuickBooks / Xero Token          |

***

## 4. 关键阻塞与待办

1. **SQL 迁移未跑**（最高优先）：`cron_state`/`staff`/`business_memories` 三表 + `orders` 三列 + P0 六表 + 全表 `tenant_id`。跑完后方可激活小费/记忆/定时/多租户。
2. **缺** **`DATABASE_URL`**：自动建表程序已就位，但环境里没有 Postgres 直连串；给了即可一键迁移。
3. **逐路由接线被 SQL 阻塞**：P0 真正生效的「接线」不能抢在 DB 迁移前做，否则线上报列不存在。

***

## 5. 文档索引

| 文档                                                      | 内容                   |
| ------------------------------------------------------- | -------------------- |
| `docs/RoveFrame-AI-Business-Generator-V2-Whitepaper.md` | 架构 + 优先级 + Sprint 总纲 |
| `docs/AI-Generation-System-Design.md`                   | AI 生成管线详设            |
| `docs/P0-Multi-tenant-Plan.md`                          | 多租户改造方案              |
| `docs/P0-S2-Auth-Wiring.md`                             | S2 Auth + 接线清单       |
| `scripts/migrate.sql`                                   | 待跑的完整建表/加列 SQL       |
| `scripts/run-migrate.ts`                                | 自动建表脚本               |

***

## 6. 下一步建议（按顺序）

1. **跑 SQL 迁移**（给 `DATABASE_URL` 或手动 SQL Editor）→ 激活已写功能。
2. **P0-S2 Auth**（`api/auth/*` 代码，可先写）+ **逐路由接线**（迁移后再做）。
3. **P1 生成核心**（上传中心 → Business Understanding → Schema Engine → 前端生成）。
4. **P2**（Docker 部署 + Stripe 商业化）。

