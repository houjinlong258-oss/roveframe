# 项目上下文

## 项目概述

**RoveFrame AI Business OS** — 面向中小企业的 AI COO 智能经营平台。通过集成 AI Agent、知识库、商业数据分析，为商家提供 24/7 智能运营助手。

当前阶段：Phase 0（Demo 验证），搭建前端原型与基础架构。

详细产品规划见 `RoveFrame_AI_Business_OS_Fused_Blueprint.md`。

## 版本技术栈

- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5
- **UI 组件**: shadcn/ui (基于 Radix UI)
- **Styling**: Tailwind CSS 4

## 目录结构

```
├── public/                 # 静态资源
├── scripts/                # 构建与启动脚本
│   ├── build.sh            # 构建脚本
│   ├── dev.sh              # 开发环境启动脚本
│   ├── prepare.sh          # 预处理脚本
│   └── start.sh            # 生产环境启动脚本
├── src/
│   ├── app/                # 页面路由与布局
│   ├── components/ui/      # Shadcn UI 组件库
│   ├── hooks/              # 自定义 Hooks
│   ├── lib/                # 工具库
│   │   └── utils.ts        # 通用工具函数 (cn)
│   └── server.ts           # 自定义服务端入口
├── next.config.ts          # Next.js 配置
├── package.json            # 项目依赖管理
└── tsconfig.json           # TypeScript 配置
```

- 项目文件（如 app 目录、pages 目录、components 等）默认初始化到 `src/` 目录下。

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
