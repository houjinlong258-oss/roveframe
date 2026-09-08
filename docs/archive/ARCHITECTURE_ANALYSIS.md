# RoveAgent Enterprise AI Kernel 架构融合分析报告 (ARCHITECTURE_ANALYSIS.md)

> **角色**：Principal AI System Architect  
> **目标**：将 RoveAgent Agent 架构升级改造为 **RoveAgent Enterprise AI Kernel**，并与 RoveFrame AI Business OS 无缝融合，打造面向中小企业的 AI Operating System。

---

## 一、 当前 RoveFrame 架构分析 (Enterprise SaaS Layer)

RoveFrame AI Business OS 是一个基于 Next.js 16 (App Router) + React 19 + TypeScript + Supabase + shadcn/ui 的多语言 AI COO 经营平台。

```
RoveFrame AI Business OS
├── src/app/[locale]/              # 10 个管理仪表盘页面 + 面向顾客的 H5 点餐商城 (/store)
├── src/app/api/                   # 业务 API 路由层 (包含 store API, upload API, agent API)
├── src/custom/                    # Customization Layer (租户样式、定制提示词、业务规则与工作流)
├── src/lib/
│   ├── ai/                        # AI 路由层 (streamChat/invokeChat, 多模型 Key 加密)
│   ├── agent/
│   │   ├── permissions/           # Agent Permission System (细粒度角色路径与资源策略)
│   │   ├── tools/                 # Tool System (解耦注册表, Human-in-the-Loop 工具, 风险拦截)
│   │   ├── tasks/                 # Agent Task Engine (工作线程与重试机制)
│   │   └── scheduler/             # Scheduled Task Engine (定时任务与幂等控制)
│   ├── plugins/                   # Plugin System (安全路径插件注册中心)
│   └── customization/             # Natural Language Customization (Template+Component+Config 范式)
└── storage/database/              # Supabase Client (19 张真实生产表, RAG pgvector 1024 维)
```

### 核心特性优势
1. **多租户经营数据链路**：涵盖订单、客户 360 视图、评论智能、库存/ERPNext、邮件/SMTP、扫码点餐等 19 张核心业务表。
2. **高安全性权限控制**：拥有一套完善的 `AgentPermissionEngine`，防止未知角色修改核心系统代码或触碰真实敏感数据。
3. **人类在环 (Human-in-the-Loop)**：写操作工具（如草稿生成、补货订单预建）强制进入审批队列。

---

## 二、 当前 RoveAgent 架构分析 (Open-Source Autonomous Agent Engine)

RoveAgent Agent (`RoveAgent Core-2026.8.31`) 是一个功能极其强大且高度解耦的 Python 自主 Agent 引擎。

```
RoveAgent Core/
├── agent/                         # 核心 Conversation Loop, Memory Manager, Prompt Builder, MoA, Task Lifecycle
├── tools/                         # 130+ 内置工具 (File Operations, Terminal, Browser, MCP, Code Kernel)
├── skills/                        # 动态 Skill Ledger, Skill Linter, AST Audit
├── plugins/                       # LLM 驱动与 Hook 拦截插件
├── RoveAgent_state.py                # 会话状态持久化与状态搜索
└── cli.py / RoveAgent_cli/           # 强大交互式终端与 CLI 指令中心
```

### 核心特性优势
1. **强大的 Agent Reasoning & Conversation Loop** (`agent/conversation_loop.py`)：支持单步/多步推导、上下文压缩 (`context_compressor.py`) 与混合专家 (`moa_loop.py`)。
2. **丰富的 Tool Runtime** (`tools/registry.py`, `tools/mcp_tool.py`)：原生支持 MCP 协议、终端隔离运行与动态 Tool Dispatching。
3. **完善的 Skill / Memory 体系** (`agent/memory_manager.py`, `tools/skills_hub.py`)：具备长期记忆检索与 AST 安全审计。

---

## 三、 RoveAgent Enterprise AI Kernel 融合架构设计

我们不会将 RoveFrame 变成 RoveAgent 的简单插件，而是将 RoveAgent 的核心 Agent 循环与推理引擎抽象为 **RoveAgent Core**（企业级 AI Kernel），作为 RoveFrame Business OS 的中央大脑。

```
                     +---------------------------------------+
                     |              RoveAgent                |
                     |         Enterprise AI Kernel          |
                     +---------------------------------------+
                     | Agent Runtime  |  Reasoning Engine    |
                     | Planning Engine|  Enterprise Memory   |
                     | Task Engine    |  Tool Security Gate  |
                     | Workflow Engine|  Self-Healing Sandbox|
                     +---------------------------------------+
                                        | (IPC / REST / SSE)
                     +---------------------------------------+
                     |        RoveFrame Business Layer       |
                     +---------------------------------------+
                     | Restaurant SaaS| CRM 360  | Orders    |
                     | Marketing AI   | Reviews  | Inventory |
                     | Deployment Agt | Business Generator   |
                     +---------------------------------------+
```

### 1. 目录结构设计 (`roveagent/`)
在项目中建立专属的企业级 Kernel 源码目录：
```
roveagent/
├── core/                           # 继承自 RoveAgent 核心 (Agent Loop, LLM Provider, Dispatcher)
└── enterprise/                     # 扩展的企业级模块
    ├── tenant/                     # 多租户隔离 (TenantContext, BusinessInstance)
    ├── permissions/                # 权限门禁与资源白名单策略 (PermissionEngine Gate)
    ├── business/                   # 行业经营快照与上下文注入
    ├── skills/                     # 商业技能库 (Business Skills: Restaurant, Retail, Hotel)
    ├── workflows/                  # 自动化经营工作流引擎
    ├── deployment/                 # 多云一键部署 Agent (AWS, DigitalOcean, Azure, 阿里云)
    ├── repair/                     # AI Developer Agent & 自愈沙箱 (Docker Sandboxing)
    └── audit/                      # 审计日志与 Human-in-the-Loop 拦截器
```

### 2. 多租户 Agent 架构 (Multi-Tenant Architecture)
升级单用户 Agent 结构为多租户架构：
$$\text{Organization} \longrightarrow \text{Business (店铺)} \longrightarrow \text{Agent Instance} \longrightarrow \text{User}$$
每个 Agent 实例拥有：
- 独立的 `tenant_context` (租户隔离 ID)
- 独立的 `business_context` (经营快照、菜单、库存)
- 独立的 `memory_space` (隔离的记忆索引)
- 独立的 `tool_permissions` (安全工具白名单)

### 3. 5 级企业记忆体系 (5-Tier Enterprise Memory System)
```
Global Memory (通用商业知识)
  └── Industry Memory (餐饮/零售行业 SOP 与最佳实践)
        └── Business Memory (店铺菜单、价格、老板偏好、历史营收)
              └── Customer Memory (客户 360 习惯、偏好、消费历史)
                    └── Conversation Memory (当期 SSE 会话上下文)
```

### 4. 商业技能体系 (Business Skill System)
在 `business_skills/restaurant/` 下划分标准化商业技能包：
- `sales_analysis`: 销售额同比环比、热销品与毛利分析
- `menu_optimizer`: 菜品关联度分析与价格优化策略
- `review_management`: 美团/Google 评价智能分析与自动差评挽留草稿
- `customer_retention`: 流失客户识别与 360 个人化营销推送
- `marketing_strategy`: 节日与周末优惠活动 AI 规划

### 5. 企业级 Tool 统一运行时 (Enterprise Tool Runtime)
所有 Agent 的工具调用必须走统一校验流程：
$$\text{Agent Intent} \longrightarrow \text{Permission Check} \longrightarrow \text{Audit Log} \longrightarrow \text{Execution / Approval Gate}$$
标准命名规范：
- `restaurant.sales.analyze`
- `restaurant.review.monitor`
- `customer.segment.create`
- `marketing.create_campaign`
- `deployment.deploy_instance`
- `system.health_check`

### 6. RoveAgent CLI 指令中心
在项目根路径提供 `roveagent` 统一命令行中心：
- `roveagent status`: 查看当前 Kernel 运行状态与连接池
- `roveagent business list`: 列出当前挂载的商户 Agent 实例
- `roveagent deploy`: 一键执行 Docker/Nginx 容器化部署
- `roveagent diagnose`: 诊断系统错误并触发 Self-Healing
- `roveagent task`: 管理后台 Task 队列与定时任务
- `roveagent plugin`: 管理及审计插件注册中心

### 7. AI Developer Agent & Docker 沙箱 (Self-Healing System)
当产生系统异常时：
$$\text{Runtime Error} \longrightarrow \text{Repair Agent} \longrightarrow \text{Docker Sandbox} \longrightarrow \text{Generate Patch} \longrightarrow \text{Run Tests} \longrightarrow \text{Human Approval} \longrightarrow \text{Deploy}$$
**绝对禁止 Agent 直接写生产环境数据库或覆盖生产代码**。

---

## 四、 需要修改与新增的文件

| 文件 / 目录 | 变更类型 | 职责与描述 |
| :--- | :--- | :--- |
| `roveagent/` | **[NEW]** | RoveAgent Enterprise AI Kernel 主目录 |
| `roveagent/core/` | **[NEW]** | Fork 移植 RoveAgent 核心 Agent Loop, Prompt Builder, Context Manager |
| `roveagent/enterprise/tenant/` | **[NEW]** | 多租户与 Agent Instance 隔离管理模块 |
| `roveagent/enterprise/permissions/` | **[NEW]** | 细粒度工具与路径安全门禁 (对接 `src/lib/agent/permissions`) |
| `roveagent/enterprise/skills/` | **[NEW]** | 商业技能加载器 (`business_skills/restaurant/*`) |
| `roveagent/enterprise/repair/` | **[NEW]** | AI Developer Repair Agent 与补丁生成器 |
| `src/app/api/kernel/` | **[NEW]** | Next.js 与 RoveAgent Kernel 通信的 REST/SSE 桥接接口 |
| `src/lib/agent/` | **[MODIFY]** | 将现有 Task Worker, Permission Engine 与 Tool Registry 对接 RoveAgent Kernel |
| `tests/roveagent-kernel.test.ts` | **[NEW]** | Kernel 融合集成测试套件 |

---

## 五、 风险分析与规避策略

1. **跨语言/环境通信风险 (Python Kernel + Next.js Platform)**
   - *风险*：RoveAgent 为 Python 实现，RoveFrame 为 Next.js (Node.js/TypeScript)。
   - *规避*：建立基于 IPC / Fast-HTTP / SSE 的极简桥接协议，或将核心 Agent Loop 思想用原生 Node.js/TypeScript 重构包装（或作为驻留 Daemon 服务通信），确保毫秒级响应。
2. **生产数据安全风险**
   - *风险*：AI Developer Agent 试图操作生产代码或数据库。
   - *规避*：在 Permission System 中设置不可逾越的只读硬边界；所有修改必须在 Docker 隔离 Sandbox 中完成，且必须由人类点击 Confirm 审批。
3. **多租户隔离与记忆泄露风险**
   - *风险*：A 店铺的客户/营收数据泄露给 B 店铺。
   - *规避*：记忆查询必须包含强校验的 `tenant_id` 与 `business_id` 前缀，向量索引分租户空间存储。
4. **渐进式升级防破坏原则**
   - *规避*：严格按照 7 个 Sprint 步调推进，每个 Sprint 完成后强制跑通 `pnpm ts-check`、`pnpm test` 和 `pnpm lint:build`，确保 Restaurant SaaS、扫描点餐、AI 日报等已有功能 100% 不受影响。
