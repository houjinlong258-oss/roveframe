# 项目上下文

## 项目概述

**RoveFrame AI Business OS** — 面向中小企业的 AI COO 智能经营平台。通过集成 AI Agent、知识库、商业数据分析，为商家提供 24/7 智能运营助手。

当前阶段：Phase 1 已完成——10 个管理页全部按原型实现，Supabase 数据链路、AI 路由层、RAG、真实邮件发送、多语言（en/zh/es）均已打通并通过 test_run 全量验收。Phase 2 已完成——扫码点餐闭环：商品媒体（图片/视频上传至 Supabase Storage）、自动生成的店铺菜单 API、H5 点餐商城（/store）、一桌一码点餐二维码（store_qr_codes 表，商家可备注）。

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
│   │   │   ├── business/           # 经营数据（产品/订单/库存/点餐二维码四 Tab；产品弹窗支持图片视频上传与编辑）
│   │   │   ├── reservations/       # 预约管理
│   │   │   ├── settings/           # 设置（7 分组）
│   │   │   ├── store/              # H5 点餐商城（面向顾客，AppShell 对其旁路，桌号经 ?table= 绑定）
│   │   │   └── layout.tsx          # html/body + NextIntlClientProvider + AppShell
│   │   └── api/            # API 路由（与页面一一对应；api/store/* 为公开接口，api/upload 为媒体上传）
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
│   ├── proxy.ts            # next-intl 中间件(Next.js 16 起改名为 proxy)
│   └── server.ts           # 自定义服务端入口
├── next.config.ts          # Next.js 配置（createNextIntlPlugin 包装）
├── package.json            # 项目依赖管理
└── tsconfig.json           # TypeScript 配置
```

- 项目文件（如 app 目录、pages 目录、components 等）默认初始化到 `src/` 目录下。
- 页面视觉以 `.cozeproj/prototype/web/*.html` 为唯一标准；设计变量在 `src/app/globals.css` 的 `@theme`（原型变量名 + shadcn 别名并存）。

## 数据层（Supabase）

- **当前库为用户自有 Supabase 项目**（ref `omoyrubbsjquadopbjoo`，region us-east-1）：API 凭据在 `.env`（`COZE_SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY/JWT_SECRET`，已被 gitignore，不进 git）
- **DDL 通道**：PostgREST/API key 无 DDL 权限；直连 `db.omoyrubbsjquadopbjoo.supabase.co:5432` 是 IPv6-only（沙箱不可达），需走 Session pooler：`aws-0-us-east-1.pooler.supabase.com:5432`，user `postgres.omoyrubbsjquadopbjoo`，数据库密码由用户提供（不落库不写文件）。psycopg2 可用（无 psql）
- **schema 已于 2026-09-08 与 `schema.ts` 对齐**（历史补丁 `scripts/patch-schema-sync.sql` 留档）：补 3 表（audit_events/health_check/integration_events）、补 52 列（business_id 多租户列为主）、agent_approvals 补 15 列；并修复两类历史脏数据——①列已存在但未回填（orders.business_id 全 NULL）②tenant_id 误填 business id（000...001 → 正确 000...000 Default tenant，含测试遗留 tenant_phase8 等）
- 归属锚点：唯一 tenant=`00000000-0000-0000-0000-000000000000`（Default），唯一 business=`00000000-0000-0000-0000-000000000001`（四川人家）；新表/新数据沿用
- 客户端：`getSupabaseClient()`（**同步导出**，service_role_key，无 Auth 场景），来自 `@/storage/database/supabase-client`
- 19 张表；**易错字段**：`orders.total`（非 total_amount）、`items` 元素用 `qty`（非 quantity）；`settings` 是**单行 jsonb**（business/locale/ai_prefs/model_assign），不是 key-value
- RAG：`match_doc_chunks(query_embedding vector(1024), match_count int)` RPC，余弦距离
- 加密凭据：model_configs.credentials / email_accounts.credentials / integration_configs.credentials 均为 AES-256-GCM JSON 字符串（`@/lib/crypto`）
- seed 数据约定：邮件分类 inquiry/business/complaint/supplier/other；预约状态 pending/confirmed/arrived/cancelled/completed；桌位 A1-A4 包间、B1-B8 大厅（与 store_qr_codes 一一对应）
- **扫码点餐**：`api/store/menu`（公开，商品含 image_url/video_url，带 ?table= 时累计桌码 scan_count）、`api/store/orders`（服务端按商品表计价，source='qr'，orders.table_no/notes）、`api/store/qr-codes`（一桌一码 upsert）；H5 商城 `[locale]/store` 由 AppShell 正则旁路后台框架
- **媒体上传**：`api/upload`（multipart）→ Supabase Storage 公共桶 `product-media`（首次上传自动建桶），图片 ≤5MB、视频 ≤50MB；二维码图用 `qrcode` 包前端转 dataURL
- **连接真相（2026-09-09 修复注册全挂）**：`loadEnv()` 见进程环境已有 `COZE_SUPABASE_*`（平台注入，指向平台默认库）就直接跳过 `.env`——服务曾一直连平台库而非用户库。修复双层：① `scripts/dev.sh`/`start.sh` 启动前 `set -a; source .env(deploy.env); set +a`；② **代码级兜底**（关键）：`supabase-client.ts` 的 `loadEnv()` 最先调 `loadDeployEnvFile()`——存在 `scripts/deploy.env` 就 `dotenv.config({ override: true })` 强制覆盖进程环境，并打日志 `[supabase-client] credentials loaded from scripts/deploy.env -> <host>`。不依赖启动脚本和 cwd，任何启动方式（含部署平台绕过 start.sh 的重启）都生效。改完必须重启服务，并用"直查用户库 auth.users/新增行"验证真实落库，curl 200 不足以证明连对库
- **运行模式**：`COZE_PROJECT_ENV` 由脚本强制（dev.sh=DEV、start.sh=PROD），`.env` 里不要再写该变量（曾导致 dev server 走生产模式崩在缺 `.next`）
- **注册限流**：`src/lib/rate-limit.ts` 内存 Map（每邮箱 5 次/15min、每 IP 10 次/15min，失败指数退避）——重启服务即清零；用户侧报 `too_many_requests` 时优先怀疑注册本身先失败后反复重试累积
- **部署注意**：`.env` 不进 git；部署实例凭据走 `scripts/deploy.env`（进 git，含同一套用户库 COZE_SUPABASE_* 四变量）。加载有双保险：`start.sh` 优先 source 它 + `supabase-client.ts` 代码级 `loadDeployEnvFile()`（override 平台注入，见"连接真相"）。轮换密钥时 `.env` 与 `scripts/deploy.env` 两个文件都要改
- **初始管理员账号（2026-09-09 预置）**：`houjinlong258@gmail.com` / `Rove@2026`，owner 角色，挂 Default tenant（000...000）+ 四川人家 business（000...001），登录即见全部 seed 数据。由 `scripts/ensure-initial-user.ts` 幂等创建（已存在则重置密码）；该脚本跑在**本地凭据上下文**（tsx + supabase admin API），与部署实例无关，账号在用户库里全局有效
- **启动脚本环境加载（防回归）**：`scripts/dev.sh`/`start.sh` 均先 `set -a; source <env>; set +a` 再启动——脚本级 export 会覆盖平台注入的 `COZE_SUPABASE_*`（否则 `loadEnv()` 见进程有值就跳过 `.env`，服务会静默连平台库）；`COZE_PROJECT_ENV` 由脚本强制（dev.sh=DEV、start.sh=PROD），`.env` 里不要写该变量

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
6. **next-intl 翻译键不能含点号**（客户端 NextIntlClientProvider 校验抛 INVALID_KEY 直接崩渲染）：动态键如 `t(\`biz.type.${action_type}\`)`（action_type=`purchase.create_draft` 等）必须把 messages 写成**嵌套对象**（`"purchase": {"create_draft": ...}`），不能写成含点号的平铺键；三语文件同步改
12. **列默认值也会漂移**（2026-09-09 修复 AI 对话建会话报错）：schema.ts 定义了 `.default()` 的列，用户库里可能没有对应 DEFAULT（如 chat_sessions.summary NOT NULL 无默认 → 插入省略该字段即撞约束 `null value in column "summary"`）。已全库对齐（defaults-patch：chat_sessions 2 列 + email_send_tasks 2 列）；新增带 default 的列时部署后要核对库结构
13. **Next.js 路由里 fire-and-forget Promise 会被丢弃**（void promise.then() 不执行）——副作用写库（扫码计数、销量累计）必须 await
7. **api-helpers 导出**是 `json/jsonError/getErrorMessage/sseResponse`，不是 ok/err
8. **supabase-js 共享单例会被登录 session 污染**（2026-09-09 修复 signup RLS 全挂）：`persistSession: false` 只跳过 storage，`signInWithPassword` 仍会把用户 session 存进 client **内存态**；之后共享单例的所有 REST 请求 `Authorization` 被用户 JWT 覆盖（role=authenticated），service_role 失效、撞 RLS（42501）。修复：`signInAndGetToken` 用 `getFreshServiceClient()`（每次全新实例）；任何会调 auth 登录态方法的代码不得用 `getSupabaseClient()` 共享单例
9. **改 supabase-client / auth 等底层模块后 HMR 可能不生效**：Next dev 的旧模块实例持有旧 client 缓存（症状：tsx 脚本同代码正常、dev server 行为异常）。改底层模块后必须重启 dev server 再验证，不要依赖热更新
10. **会话 cookie 的 Secure 属性按请求协议自适应，不能只看 NODE_ENV**（2026-09-09 修复"登录成功后被弹回登录页"）：生产模式 cookie 若固定带 `Secure`，通过 http 访问部署站时浏览器会**静默拒绝存储**该 cookie → 登录 200 但会话丢失 → AppShell 守卫 `/api/auth/me` 401 → 弹回登录。修复：`isSecureRequest(request)` 以 `x-forwarded-proto` 头（回退 request.url protocol）判定，login/signup/logout 三路由的 Set-Cookie 均按实际协议决定是否加 Secure
11. **本地验证登录态全链路用 cookie jar**：`curl -c c.txt login` → `curl -b c.txt /api/auth/me`，别只测 login 200

14. **AI 流式调用的 60s 绝对超时会掐断长回复**（2026-09-09 修复部署站 AI 对话报 "The operation was aborted due to timeout"）：`fetchWithResilience` 的 `AbortSignal.timeout` 从请求发起起算、覆盖整个 SSE 读取期；`streamOpenAICompatible`/`streamAnthropic` 已用 `STREAM_TIMEOUT_MS=300_000` 覆盖（`composeSignal` 优先取 `opts.timeoutMs`），工具决策等非流式调用保持 60s。调 AI 超时不要只改 `DEFAULT_TIMEOUT_MS`
15. **model_configs 表实际名为 `model_configs`**（provider/display_name/base_url/default_model/is_enabled/last_test_ok/timeout_ms 等列），排查 AI 配置问题直查此表（`settings` 表的 model_assign 决定各能力分流到哪个 provider:model）

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
- **`.coze` 配置**（工作区根 `/workspace/projects/.coze`，单层结构 `[subprojects].path=["."]`）：`sub_id = "e679bddf"`，`project_type = "web"`，`requires = ["nodejs-24"]`，`preview_enable = "enabled"`
  - `[dev] build = bash scripts/prepare.sh`，`[dev] run = bash scripts/dev.sh`（端口从 `.preview` 读，fallback 5000）
  - `[deploy] build = bash scripts/build.sh`，`[deploy] run = bash scripts/start.sh`；`[deploy.profile] kind = "service", flavor = "web"`（对外 5000，读 `DEPLOY_RUN_PORT`/`PORT`）
  - 源码位于工作区根（生成物：预览 `prepare.sh`+`dev.sh`；生产 `build.sh` 产出 `dist/server.js`，`start.sh` 生产启动）

## 用户偏好与长期约束

- 包管理器仅使用 pnpm
- UI 组件库使用 shadcn/ui
- 项目目标：AI COO 智能经营平台（详见 Fused Blueprint）
- **目标市场为海外**：界面默认英文（next-intl，en/zh/es），货币默认 USD，支持时区本地化；AI 回复默认跟随客户语言
- 用户主力模型为 **Claude（Anthropic）**，设置页支持 10 家模型服务商自接（Key 加密存储），未接入时回落平台内置模型
- **邮件系统为真实收发通道**：设置页支持绑定 Gmail/Outlook（OAuth2）与自定义 SMTP/IMAP 企业/个人邮箱（凭据加密存储）；营销邮件为 AI 按客户 360 逐人个性化生成（非固定模板），队列限流外发
- **ERPNext 集成**：设置页「系统集成」支持对接用户自部署 ERPNext（REST API + Token 认证 + Webhook），同步库存/供应商/采购单；库存数据驱动经营数据页库存 Tab、缺货告警与 AI 采购建议；未接入时回落平台 seed 数据
- 实施计划以 `.cozeproj/documents/plan.md` 为准（10 页面 + 15 表 + 原型设计先行）
