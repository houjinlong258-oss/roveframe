# RoveFrame AI Business OS — 项目现状与目标

> 生成时间：2026-09-03 19:57 CST
> 当前阶段：Sprint 6 已完成，Sprint 7 待开始

---

## 🎯 最终目标

将 RoveFrame 从一个 **AI Business SaaS 餐饮管理系统**，升级为：

> **AI-Native Self-Evolving Business Operating System**
> — 面向中小企业的 AI COO 智能经营操作系统

### 核心能力目标

| 能力 | 描述 |
|------|------|
| 🔍 AI 自动诊断 | 检测生产环境错误，自动分析根因 |
| 🩹 AI 自动修复 | 生成代码修复方案（Patch Proposal） |
| 🔒 沙箱隔离执行 | AI 在隔离环境中修改代码，不触碰生产环境 |
| ✅ 自动测试 | 修改方案经自动化测试验证 |
| 🚀 受控部署 | 人工审批后方可部署，支持一键回滚 |
| 💬 自然语言定制 | 商家用自然语言描述需求，AI 实现功能 |

### 绝对安全红线

- **生产环境永远只读保护**
- AI 所有代码修改必须经人工批准
- 所有修改可回滚
- 禁止 AI 直接触碰 `src/core/`、`auth`、`crypto`、`.env`、`package.json`

---

## 📦 项目技术栈

| 层 | 技术 |
|----|------|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript 5 (strict) |
| UI | shadcn/ui + Tailwind CSS 4 |
| Backend | Supabase (PostgreSQL + pgvector) |
| AI | 10 家模型服务商（Claude 主力，OpenAI 兼容，加密存储 Key） |
| i18n | next-intl（en/zh/es） |
| Package | pnpm only |
| Tests | Node.js 内置 test runner |

---

## ✅ 已完成的工作

### Phase 1 — 核心 SaaS 平台（本会话前完成）

10 个管理页面全部实现：

| 页面 | 功能 |
|------|------|
| 经营仪表盘 | 营收概览、AI 日报 |
| AI COO 助手 | SSE 流式对话，工具调用 |
| 知识大脑 | RAG 问答 + 文档管理 |
| 评论智能 | 负面评论分析 + AI 回复草稿 |
| 客户智能 | 360 视图 + 流失预警 + 挽留 |
| 营销增长 | AI 个性化邮件生成 + 队列发送 |
| 邮件中心 | 真实 SMTP 收发 + AI 分类 |
| 经营数据 | 产品/订单/库存/点餐二维码 |
| 预约管理 | 全状态流转 |
| 设置 | 7 分组，10 家 AI 服务商，邮件绑定 |

扫码点餐闭环：H5 商城（/store）、一桌一码 QR、Supabase Storage 媒体上传。

### Phase 2 — Agent Core 基础设施（本会话前完成）

| 模块 | 说明 |
|------|------|
| Agent Tool Registry | RBAC + Zod 验证 + 超时 + 审计 |
| Agent Gateway | 4 家提供商 tool calling + fallback planner |
| Agent Tasks | 持久化任务调度，原子 claim，重试退避 |
| Event Detection | 库存/评论/销量/流失信号检测 + 去重 |
| Notification Outbox | Web Push VAPID 分发（opt-in） |
| Auth + RBAC | HttpOnly cookie + Bearer，租户隔离 |

### AI-Native OS 升级路线（本会话内完成）

| Sprint | 功能 | 状态 | 新增测试数 |
|--------|------|------|-----------|
| Sprint 1 | Customization Layer（多租户配置层） | ✅ 完成 | 通过 |
| Sprint 2 | Plugin System（插件注册中心 + 权限隔离） | ✅ 完成 | 通过 |
| Sprint 3 | Agent Permission System（细粒度权限引擎） | ✅ 完成 | 通过 |
| Sprint 4 | Natural Language Customization（NL 定制引擎） | ✅ 完成 | 通过 |
| Sprint 5 | Error Self-Healing MVP（检测→分析→Patch 生成） | ✅ 完成 | +16 |
| Sprint 6 | AI Coding Agent（AI 写代码 + 权限守卫 + 提案存储） | ✅ 完成 | +22 |

> **累计测试：63/63 通过，0 失败**

---

## 🔧 各 Sprint 核心管道

### Sprint 5 — Error Self-Healing MVP

```
captureError()          → 环形缓冲区（max 500），自动分类 category / severity
    ↓
analyzeError()          → 6 条启发式规则（JSON / auth / DB / network / null / 500）
    ↓
generatePatchProposal() → 模板匹配 + 安全过滤器
    ↓
PatchProposal { requiresHumanApproval: true, status: 'pending_review' }
```

API：`POST /api/healing`（上报错误）· `GET /api/healing`（查询分析结果）

### Sprint 6 — AI Coding Agent

```
validateTask()              → 权限守卫：拦截非法目标文件
    ↓
buildCodingContext()        → 只读扫描 src/custom/ 等安全目录，关键词排序
    ↓
generateCodingProposal()    → invokeChat('agent') → 结构化 JSON 提案
    ↓
checkPath() × N             → 每条 change 过权限门
    ↓
saveProposal()              → 环形缓冲区（max 200）
```

写权限范围：`src/custom/*` · `docs/*` · `messages/*` · `public/*`
禁止触碰：`src/core/` · `auth/` · `crypto.ts` · `.env` · `package.json`

API：`POST /api/coding-agent`（提交任务）· `GET`（查询）· `PATCH`（审批/拒绝）

---

## 🔴 待完成工作

### 一、AI-Native OS 主线（优先级从高到低）

| Sprint | 功能 | 核心内容 |
|--------|------|---------|
| **Sprint 7** | **Sandbox Container** | 子进程/Docker 隔离环境；AI 在沙箱修改代码；宿主只读挂载；执行结果回传 |
| **Sprint 8** | **Deployment System** | 自动测试 → 安全检查 → Git diff/PR → 人工审批 → 部署 → 快照回滚 |
| **Sprint 9** | **AI Business Generator** | 自然语言描述业务模块 → AI 自动生成完整功能（组件 + API + 测试） |

### 二、生产就绪遗留项

| 类别 | 项目 | 状态 |
|------|------|------|
| 数据库 | Supabase 迁移实际应用 | 待凭据 + preflight |
| 通知 | Owner PWA 通知中心 UI | 调度器完成，UI 未做 |
| 任务控制 | Scheduled Task 控制面板 UI | 未实现 |
| 集成测试 | Mock-Supabase 集成测试（task claim/retry 等） | 未实现 |
| 文档 | README 更新为准确运营手册 | 未更新 |

### 三、RoveAgent → RoveAgent 深度融合（长期规划）

| 项目 | 说明 |
|------|------|
| RoveAgent Memory System 接入 | 将 RoveAgent Memory 层接入 RoveFrame Agent |
| RoveAgent Tool Calling 映射 | RoveAgent Tool → Agent Registry 适配器 |
| RoveAgent MCP / Skills 接入 | 接入 RoveAgent MCP 协议和 Skills 系统 |

---

## 📊 整体进度

```
Phase 1: 核心 SaaS 平台   ████████████████████  100%
Phase 2: Agent Core        ████████████████████  100%
Sprint 1-6 (OS 升级)       ████████████████████  100%  (6/9 Sprints)
Sprint 7-9 (沙箱+部署+生成) ░░░░░░░░░░░░░░░░░░░░    0%
生产就绪遗留项              ████████░░░░░░░░░░░░   40%
RoveAgent 深度融合             ████░░░░░░░░░░░░░░░░   20%
────────────────────────────────────────────────────
总体完成度                  ███████████░░░░░░░░░  ~55%
```

---

## 🗂️ 关键文件导航

| 路径 | 用途 |
|------|------|
| `src/lib/healing/` | Sprint 5 错误自愈模块 |
| `src/lib/coding-agent/` | Sprint 6 AI 编程智能体 |
| `src/lib/customization/` | Sprint 1+4 定制化层 |
| `src/lib/plugins/` | Sprint 2 插件系统 |
| `src/lib/agent/permissions/` | Sprint 3 权限引擎 |
| `src/lib/agent/` | Agent Core（工具注册、网关、调度） |
| `src/app/api/healing/` | Sprint 5 REST API |
| `src/app/api/coding-agent/` | Sprint 6 REST API |
| `tests/` | 63 个单元测试（全部通过） |
| `TASK_STATE.md` | 实时任务状态 |
| `RoveFrame_AI_Business_OS_Fused_Blueprint.md` | 产品完整规划蓝图 |

---

## 🚦 下一步行动计划

```
立即可执行（无外部依赖）
├── Sprint 7: Sandbox Container
│   ├── src/lib/sandbox/runner.ts       — 隔离执行器（child_process / Docker）
│   ├── src/lib/sandbox/file-system.ts  — 只读挂载 + 沙箱写隔离
│   ├── src/lib/sandbox/security.ts     — 资源限制 + 超时 + 系统调用过滤
│   └── src/app/api/sandbox/route.ts    — 执行接口
│
├── Sprint 8: Deployment System
│   ├── src/lib/deploy/pipeline.ts      — 测试 → 安全检查 → 审批流水线
│   ├── src/lib/deploy/git-manager.ts   — Git diff / snapshot 生成
│   └── src/lib/deploy/rollback.ts      — 快照回滚
│
└── Sprint 9: AI Business Generator
    ├── src/lib/generator/templates.ts          — 业务模板库
    └── src/lib/generator/module-scaffolder.ts  — 模块脚手架生成器

需要 Supabase 凭据（随时可独立执行，不阻塞主线）
└── 数据库迁移 preflight + apply
    └── src/lib/migration.ts → Supabase SQL Editor
```
