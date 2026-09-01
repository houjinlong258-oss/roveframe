# 项目上下文

## 项目概述

**RoveFrame AI Business OS** — 面向中小企业的 AI COO 智能经营平台。通过集成 AI Agent、知识库、商业数据分析，为商家提供 24/7 智能运营助手。

当前阶段：Phase 1 已完成——10 个页面全部按原型实现，Supabase 数据链路、AI 路由层、RAG、真实邮件发送、多语言（en/zh/es）均已打通并通过 test_run 全量验收。

详细产品规划见 `RoveFrame_AI_Business_OS_Fused_Blueprint.md`。

## 版本技术栈

- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5
- **UI 组件**: shadcn/ui (基于 Radix UI)
- **Styling**: Tailwind CSS 4

## 目录结构

```
├── messages/               # next-intl 三语文案（en/zh/es，按页面命名空间）
├── public/                 # 静态资源
├── scripts/                # 构建与启动脚本
│   ├── build.sh            # 生产构建（pnpm install + next build + tsup server.ts → dist/）
│   ├── dev.sh              # 开发环境启动脚本
│   ├── prepare.sh          # 预处理脚本
│   ├── start.sh            # 生产启动（PORT=5000，node dist/server.js）
│   └── seed.ts             # Supabase 种子数据（四川人家餐厅示例）
├── src/
│   ├── app/
│   │   ├── [locale]/       # 10 个页面（next-intl 路由，localePrefix 'always'）
│   │   │   ├── page.tsx            # 经营仪表盘
│   │   │   ├── agent/              # AI COO 助手（SSE 流式对话）
│   │   │   ├── knowledge/          # 知识大脑（RAG 问答 + 文档管理）
│   │   │   ├── reviews/            # 评论智能
│   │   │   ├── customers/          # 客户智能（360 视图 + 评分 + 挽留）
│   │   │   ├── marketing/          # 营销增长（AI 内容生成 + 逐人个性化发送）
│   │   │   ├── emails/             # 邮件中心（AI 分类 + 草稿 + 真实 SMTP 发送）
│   │   │   ├── business/           # 经营数据（产品/订单/库存三 Tab）
│   │   │   ├── reservations/       # 预约管理
│   │   │   ├── settings/           # 设置（7 分组）
│   │   │   └── layout.tsx          # html/body + NextIntlClientProvider + AppShell
│   │   └── api/            # API 路由（与页面一一对应）
│   ├── components/
│   │   ├── layout/         # app-shell / sidebar / topbar（顶栏在上、侧栏在下）
│   │   ├── ui/             # Shadcn UI 组件库
│   │   └── markdown.tsx    # react-markdown 封装（AI 流式内容渲染）
│   ├── hooks/              # use-sse.ts（手写 SSE reader 解析）
│   ├── i18n/               # routing / request / navigation（en 默认，zh/es）
│   ├── lib/
│   │   ├── ai/             # providers.ts（10 家服务商预设）+ router.ts（streamChat/invokeChat）
│   │   ├── api-helpers.ts  # ok/err/sseResponse
│   │   ├── business-context.ts  # 经营快照（供 AI 系统提示词）
│   │   ├── crypto.ts       # AES-256-GCM 加解密（API Key / 邮箱凭据）
│   │   ├── embedding.ts    # 向量嵌入（1024 维，pgvector）
│   │   ├── format.ts       # fmtCurrency/fmtDate/fmtDateTime/timeAgo/maskEmail
│   │   ├── settings.ts     # settings 表单行 jsonb 读写 + 缓存
│   │   └── utils.ts        # 通用工具函数 (cn)
│   ├── middleware.ts       # next-intl 中间件
│   └── server.ts           # 自定义服务端入口
├── next.config.ts          # Next.js 配置（createNextIntlPlugin 包装）
├── package.json            # 项目依赖管理
└── tsconfig.json           # TypeScript 配置
```

- 项目文件（如 app 目录、pages 目录、components 等）默认初始化到 `src/` 目录下。
- 页面视觉以 `.cozeproj/prototype/web/*.html` 为唯一标准；设计变量在 `src/app/globals.css` 的 `@theme`（原型变量名 + shadcn 别名并存）。

## 数据层（Supabase）

- 客户端：`getSupabaseClient()`（**同步导出**，service_role_key，无 Auth 场景），来自 `@/storage/database/supabase-client`
- 18 张表；**易错字段**：`orders.total`（非 total_amount）、`items` 元素用 `qty`（非 quantity）；`settings` 是**单行 jsonb**（business/locale/ai_prefs/model_assign），不是 key-value
- RAG：`match_doc_chunks(query_embedding vector(1024), match_count int)` RPC，余弦距离
- 加密凭据：model_configs.credentials / email_accounts.credentials / integration_configs.credentials 均为 AES-256-GCM JSON 字符串（`@/lib/crypto`）
- seed 数据约定：邮件分类 inquiry/business/complaint/supplier/other；预约状态 pending/confirmed/arrived/cancelled/completed；桌位 A1-A4 包间、B1-B8 大厅

## AI 路由层

- `streamChat/invokeChat(capability, messages, forwardHeaders)`，capability: agent/content/rag/light
- 外部 Key 已接入时按 model_assign 分流（auto 模式轻任务走 light）；未接入回落平台内置模型
- Claude 用 Anthropic Messages SSE 协议，其余用 OpenAI 兼容 SSE
- **API 路由里必须** `HeaderUtils.extractForwardHeaders(request.headers)` 并透传
- 流式返回一律 `sseResponse(streamChat(...))`；**路由 handler 不能直接 return AsyncGenerator**（ts-check 会报 RouteHandlerConfig 错误）

## 常见陷阱（已踩过）

1. **时区**：沙箱为 CST(UTC+8)，但 `toISOString()` 是 UTC——日期切分用本地时区解析（`new Date('YYYY-MM-DDT00:00:00')` 无 Z），API 默认日期也要本地计算
2. **EmbeddingClient.embedText**：类型声明返回 `number[]`，运行时实际返回 `{ embedding: number[] }`，`lib/embedding.ts` 已兼容两种形态
3. **invokeChat 返回 string**，不是 `{ text }`
4. **React Compiler lint**：渲染期不能重赋值累积变量（如环形图 gradient stops），用 reduce 前缀和
5. **i18n 键**：改页面后跑 `messages/*.json` 与源码 t() 比对（见 git 历史中的扫描脚本模式），杜绝 MISSING_MESSAGE

## 包管理规范

**仅允许使用 pnpm** 作为包管理器，**严禁使用 npm 或 yarn**。
**常用命令**：
- 安装依赖：`pnpm add <package>`
- 安装开发依赖：`pnpm add -D <package>`
- 安装所有依赖：`pnpm install`
- 移除依赖：`pnpm remove <package>`

## 开发规范

### 编码规范

- 默认按 TypeScript `strict` 心智写代码；优先复用当前作用域已声明的变量、函数、类型和导入，禁止引用未声明标识符或拼错变量名。
- 禁止隐式 `any` 和 `as any`；函数参数、返回值、解构项、事件对象、`catch` 错误在使用前应有明确类型或先完成类型收窄，并清理未使用的变量和导入。

### next.config 配置规范

- 配置的路径不要写死绝对路径，必须使用 path.resolve(__dirname, ...)、import.meta.dirname 或 process.cwd() 动态拼接。

### Hydration 问题防范

1. 严禁在 JSX 渲染逻辑中直接使用 typeof window、Date.now()、Math.random() 等动态数据。**必须使用 'use client' 并配合 useEffect + useState 确保动态内容仅在客户端挂载后渲染**；同时严禁非法 HTML 嵌套（如 <p> 嵌套 <div>）。
2. **禁止使用 head 标签**，优先使用 metadata，详见文档：https://nextjs.org/docs/app/api-reference/functions/generate-metadata
   1. 三方 CSS、字体等资源可在 `globals.css` 中顶部通过 `@import` 引入或使用 next/font
   2. preload, preconnect, dns-prefetch 通过 ReactDOM 的 preload、preconnect、dns-prefetch 方法引入
   3. json-ld 可阅读 https://nextjs.org/docs/app/guides/json-ld

## UI 设计与组件规范 (UI & Styling Standards)

- 模板默认预装核心组件库 `shadcn/ui`，位于`src/components/ui/`目录下
- Next.js 项目**必须默认**采用 shadcn/ui 组件、风格和规范，**除非用户指定用其他的组件和规范。**

## 运行与预览

- **预览方式**：`bash scripts/prepare.sh` (build) → `bash scripts/dev.sh` (run)
- **端口**：从 `.preview` 读取 `expose_port`，默认 5000
- **预览类型**：web，支持 HMR 热更新
- **`.coze` 配置**：`sub_id = "e679bddf"`，`project_type = "web"`

## 用户偏好与长期约束

- 包管理器仅使用 pnpm
- UI 组件库使用 shadcn/ui
- 项目目标：AI COO 智能经营平台（详见 Fused Blueprint）
- **目标市场为海外**：界面默认英文（next-intl，en/zh/es），货币默认 USD，支持时区本地化；AI 回复默认跟随客户语言
- 用户主力模型为 **Claude（Anthropic）**，设置页支持 10 家模型服务商自接（Key 加密存储），未接入时回落平台内置模型
- **邮件系统为真实收发通道**：设置页支持绑定 Gmail/Outlook（OAuth2）与自定义 SMTP/IMAP 企业/个人邮箱（凭据加密存储）；营销邮件为 AI 按客户 360 逐人个性化生成（非固定模板），队列限流外发
- **ERPNext 集成**：设置页「系统集成」支持对接用户自部署 ERPNext（REST API + Token 认证 + Webhook），同步库存/供应商/采购单；库存数据驱动经营数据页库存 Tab、缺货告警与 AI 采购建议；未接入时回落平台 seed 数据
- 实施计划以 `.cozeproj/documents/plan.md` 为准（10 页面 + 15 表 + 原型设计先行）
