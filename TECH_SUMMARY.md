# RoveFrame AI Business OS — 技术总结

## 一、产品定位

面向中小企业（海外市场为主）的 AI COO 智能经营平台：集成 AI 对话助手、知识库 RAG、客户/评论智能、个性化营销、真实邮件收发、经营数据管理、扫码点餐闭环，为商家提供 24/7 智能运营助手。

## 二、技术栈

| 层 | 选型 |
|---|---|
| 框架 | Next.js 16（App Router）+ React 19 + TypeScript strict |
| UI | shadcn/ui（Radix）+ Tailwind CSS 4，视觉以 HTML 原型为唯一标准 |
| 数据 | Supabase（Postgres 19 表 + pgvector + Storage），service_role 直连 |
| AI | 自研路由层：10 家服务商预设（Claude 走 Anthropic 原生 SSE，其余 OpenAI 兼容），未接入回落平台内置模型 |
| 国际化 | next-intl 4，en/zh/es 三语，localePrefix 'always' |
| 邮件 | nodemailer 真实 SMTP 发送，凭据 AES-256-GCM 加密落库 |
| 二维码 | qrcode 包前端生成 PNG |
| 部署 | 自定义 server.ts（next + http），端口 5000，scripts/build.sh + start.sh |

## 三、架构总览

```
src/
├── app/
│   ├── [locale]/            # 10 个页面（next-intl 路由）
│   │   ├── page.tsx         # 经营仪表盘（KPI/趋势/渠道/告警）
│   │   ├── agent/           # AI COO 助手（SSE 流式对话 + 会话管理）
│   │   ├── knowledge/       # 知识大脑（RAG 问答 + 文档管理）
│   │   ├── reviews/         # 评论智能（AI 回复草稿）
│   │   ├── customers/       # 客户智能（360 视图 + 评分 + 挽留方案）
│   │   ├── marketing/       # 营销增长（AI 内容 + 逐人个性化发送）
│   │   ├── emails/          # 邮件中心（AI 分类 + 真实发送）
│   │   ├── business/        # 经营数据（产品/订单/库存/点餐二维码）
│   │   ├── reservations/    # 预约管理（周视图 + 桌位网格）
│   │   ├── settings/        # 设置（7 分组：业务/语言/模型/邮箱/集成/偏好/数据）
│   │   └── store/           # H5 点餐商城（AppShell 旁路，面向顾客）
│   └── api/                 # 25 个 API 路由
├── components/layout/       # AppShell / Sidebar / Topbar
├── lib/
│   ├── ai/                  # providers.ts（10 家预设）+ router.ts（能力路由）
│   ├── crypto.ts            # AES-256-GCM 凭据加解密
│   ├── embedding.ts         # 1024 维向量嵌入（兼容 SDK 双形态返回）
│   ├── settings.ts          # settings 单行 jsonb 读写 + 缓存
│   └── business-context.ts  # 经营快照（注入 AI 系统提示词）
└── server.ts                # 自定义服务端入口（PORT 5000）
```

## 四、数据层设计

**19 张表**，核心约定：

- `settings`：**单行 jsonb**（business/locale/ai_prefs/model_assign 四列），非 key-value
- `orders`：`total`（非 total_amount）、`items` 元素用 `qty`、`table_no`/`notes` 支撑扫码点餐
- `products`：`image_url`/`video_url`（Supabase Storage 公共桶 `product-media`）
- `store_qr_codes`：一桌一码（`table_no` UNIQUE upsert）、`remark` 商家备注、`scan_count` 扫码统计
- 凭据类（model_configs/email_accounts/integration_configs）：AES-256-GCM JSON 字符串，仅服务端解密
- RAG：`match_doc_chunks(vector(1024), int)` RPC，余弦距离检索

## 五、AI 路由层

```
streamChat / invokeChat(capability, messages, forwardHeaders)
```

- 能力分四档：`agent`（经营问答）/ `content`（文案生成）/ `rag`（知识问答）/ `light`（轻量任务）
- auto 模式按任务复杂度分流，可节省 40-60% 成本
- 外部 Key 已接入时按 model_assign 分流；Claude 用 Anthropic Messages SSE 协议，其余用 OpenAI 兼容 SSE
- 所有 AI 路由必须 `HeaderUtils.extractForwardHeaders(request.headers)` 透传
- 流式返回一律 `sseResponse(streamChat(...))`；路由 handler 不能直接 return AsyncGenerator（RouteHandlerConfig 类型错误）

## 六、扫码点餐闭环（核心链路）

```
商家上传商品(图/视频) → /api/store/menu 自动生成菜单 API
        ↓
点餐二维码 Tab 生成一桌一码（备注 + PNG 下载）
        ↓
顾客扫码 → /store?table=A1（H5 商城，桌号绑定）
        ↓
/api/store/orders 下单（服务端计价，不信任客户端金额）
        ↓
订单带 table_no/notes 回流后台订单管理，销量自动累计
```

安全要点：菜单/下单为公开接口，下单金额以服务端商品表为准；扫码计数与销量累计必须 `await`（Next.js 路由的 fire-and-forget Promise 会被丢弃）。

## 七、关键工程决策

1. **时区**：沙箱 CST(UTC+8)，日期切分一律本地时区解析（`new Date('YYYY-MM-DDT00:00:00')` 无 Z 后缀），禁用 `toISOString()` 切日
2. **EmbeddingClient.embedText**：类型声明返回 `number[]`，运行时实际返回 `{ embedding: number[] }`，lib/embedding.ts 兼容双形态
3. **React Compiler lint**：渲染期禁止重赋值累积变量（环形图 gradient 用 reduce 前缀和）
4. **i18n 键防漂移**：改页面后跑全量 t() 键扫描脚本比对 messages/*.json
5. **PATCH 接口统一校验 id 必填 + 状态白名单**（防止 `.eq('id', undefined)` 假成功）
6. **设计一致性**：原型 @theme 变量全量迁移 globals.css（原型名 + shadcn 别名并存），check_tokens.js 校验通过

## 八、部署

- 构建：`bash scripts/build.sh`（pnpm install → next build → tsup server.ts → dist/server.js）
- 启动：`bash scripts/start.sh`（PORT=5000，COZE_PROJECT_ENV=PROD 切换生产模式）
- `.coze`：`sub_id=e679bddf`，`project_type=web`，`[deploy.profile] kind=service flavor=web`

## 九、质量基线

- `pnpm lint --quiet` + `pnpm ts-check` 零错误
- test_run 全量通过：10 页面 × 三语 + 20 API 冒烟 + 8 个边界用例（非法 JSON/缺 id/越界值/错误文件类型）全部正确拦截
- 生产构建与 PROD 产物实测通过
