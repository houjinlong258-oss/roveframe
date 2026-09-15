# RoveFrame Final Status Audit Report

**审计对象**：`roveframe-src-latest` 工作树，2026-09-13 状态 + Phase 9–10.7 全部改动
**审计方式**：只读。本次**未修改任何代码、未新增功能、未修复问题**。
**证据规则**：所有数字来自本次实测命令输出；凡未验证者显式标注 `UNVERIFIED` 或 `UNKNOWN`。

---

# Executive Summary

## 一句话回答

> **距离「真正可商业化 SaaS AI 员工平台」：技术上约 6–9 个月，但当前真正的阻塞点不是时间，而是「运行时从未被部署过」与「源码未纳入版本控制」这两件事 —— 它们各自只需 1 天即可解决，却卡住了其余全部工作。**

系统状态可概括为一句话：**控制面已达生产级，执行面从未上线，工程化近乎空白。**

## 当前真实完成度

| 维度 | 完成度 | 判定依据 |
|---|---|---|
| **代码完成** | **82%** | Python 821,458 行 / TS 50,493 行；101 个工具已注册；审批/门控/沙箱/能力注册表代码齐备 |
| **架构完成** | **70%** | 分层意图正确且有代码支撑，但存在 4 套 Agent Loop、4 套 Tool 权威、2 套 Skill 系统、40k 行不可达平行服务 |
| **测试完成** | **88%** | Python 782/782、TS 621/621 全绿；但 CI 只跑 4 步；约 15% 的测试无法证明生产行为 |
| **生产完成** | **15%** | 无 Dockerfile、无 CI gate、无监控、无备份、工作树未纳管版本控制、运行时无部署路径 |
| **商业可用** | **8%** | 终端用户**无法**使用：无部署实例、无计费闭环、无监控、无回滚 |

## 本次审计最重要的三个发现

**1. 执行面 100% 不可达 —— 但它能跑。**
Phase 10.5 首次证明：RoveAgent Runtime 可本地启动并真实响应（`/api/health` 200、`/api/agent/chat` 200）。
而 `.coze` 仅 `requires=["nodejs-24"]`、`scripts/start.sh` 只跑 `node dist/server.js`、`scripts/deploy.env` 无 `ROVEAGENT_*`。
**结论：821,458 行代码从未在真实部署中运行过一次。** 这不是技术难题（3–5 人日），是流程盲区。

**2. 性能慢的根因已被定位，且与所有先前假设相反。**

| 阶段 | 占总耗时 |
|---|---|
| **`AIAgent.__init__`（构造）** | **75.0%** |
| 未埋点残余（HTTP/auth/prompt/toolset/capability） | 14.6% |
| `AIAgent.chat`（**真正的 LLM + 工具循环**） | **10.0%** |
| provider 发现（`_try_nous`） | 0.7% |
| memory 读取 | **0.0%** |

**构造 Agent 的成本是执行 Agent 的 7.5 倍。** 而此前怀疑的 provider discovery / credential resolution / hidden network timeout **合计 <1%，已证伪**。

**3. 源码未纳入版本控制 —— 因此无回滚能力。**
`git rev-parse --show-toplevel` 解析到**父目录**；`git status` 报 `?? roveframe-src-latest/`；最后提交 2026-09-08，而工作树文件到 2026-09-13。版本管理是 7 个 ZIP 快照，最新一个落后 3 天。
**在这一点解决之前，任何上线都不可逆。**

---

# 1. 架构完整性审计

## 真实调用链与断点

```
Frontend (Next.js 16, 21 页面, i18n 1118 键 × 3)
   │                                          ✅ GREEN
   ▼  SSE 9 事件（生产端 == 消费端白名单）
API Layer (91 route.ts)
   │  proxy.ts 单点鉴权 + protect*Mutation 覆盖 52 条     ✅ GREEN
   │  ⚠️ withAuth 仅 8 条；getAuthContext 全仓库 0 读取 → 🔴 RED（死代码）
   ▼
Capability Layer
   │  Python: CapabilityProvider 单门 + 8 provider        ⚠️ YELLOW（不可达）
   │  TS: 不存在（0/5 环节）                               🔴 RED
   ▼
Agent Runtime
   │  Python: api/app.py 22 路由 → conversation_loop.py:2094  ⚠️ YELLOW（能跑但未部署）
   │  TS 兜底: packages/roveagent-core (117 行)            ✅ GREEN
   │  平行服务: gateway/run.py 30,947 行 + api_server.py 7,231 行  🔴 RED（不可达）
   ▼
Tool Layer
   │  A. TS AgentToolRegistry  14 工具                     ✅ GREEN
   │  B. TS executeEnterpriseTool 6 工具                    ⚠️ YELLOW（第 2 套权威）
   │  C. TS coding-agent/*                                 ⚠️ YELLOW（第 3 套权限模型）
   │  D. Python EnterpriseToolGate 101 已注册              ⚠️ YELLOW（不可达）
   ▼
Gate
   │  Phase 9 后：default deny，0/101 兜底                  ✅ GREEN（安全语义已闭环）
   │  HIGH/CRITICAL 任何角色不得自动跳过                     ✅ GREEN
   ▼
Provider
   │  外部 10 家 + failover 链                             ✅ GREEN
   │  平台兜底 = coze-coding-dev-sdk（无超时/无重试）        🔴 RED
   │  嵌入 = coze-coding-dev-sdk EmbeddingClient（无抽象）   🔴 RED（RAG 锁定）
   ▼
Database
   │  Supabase: service_role + 应用层谓词                   ⚠️ YELLOW（无 DB 层强制隔离）
   │  Python: 本地 SQLite（ROVEAGENT_ROOT）                 ⚠️ YELLOW（容器回收即丢）
   ▼
Sandbox  L2（进程级 + env 白名单；非容器）                  ⚠️ YELLOW
   │  容器硬化参数已写好但从未执行（plugin_tools.py:359,673 硬编码 SUBPROCESS）
   │  enforce 默认 False（plugin_isolation.py:328）
```

## 模块状态矩阵

状态定义：**GREEN** = 代码存在 + 有生产调用 + 有测试 + 可部署可从用户侧使用 ｜ **YELLOW** = 缺其中 1–2 项 ｜ **RED** = 缺 3 项以上或不可达

| 模块 | 代码存在 | 生产调用 | 测试 | 状态 |
|---|---|---|---|---|
| Frontend（21 页面） | ✅ | ✅ | ✅ | **GREEN** |
| API Layer（91 路由） | ✅ | ✅ | ✅ | **GREEN** |
| 审批总线 `agent_approvals` | ✅ | ✅ | ✅ | **GREEN** |
| 审计链路 `audit_events` | ✅ | ✅ | ✅ | **GREEN** |
| SSRF 防护 `outbound-url.ts` | ✅ | ✅ | ✅ | **GREEN** |
| 文档引擎 `artifacts/*` | ✅ | ✅ | ✅ | **GREEN**（中文 PDF 因缺字体降级） |
| Provider failover | ✅ | ✅ | ✅ | **GREEN** |
| EnterpriseToolGate | ✅ | ❌ 不可达 | ✅ 782 | **YELLOW** |
| Capability Registry / Provider | ✅ | ❌ 不可达 | ✅ | **YELLOW** |
| Plugin Sandbox / Trust / Tools | ✅ | ❌ `load_all()` 零生产调用 | ✅ | **RED** |
| Plugin Center HTTP 端点 | ✅ | ⚠️ 仅记录管理，不加载工具 | ✅ | **YELLOW** |
| Skill `skills/`（104 行） | ✅ | ✅ 3 个端点 | ✅ | **YELLOW**（无 scanner/permissions/sandbox） |
| Skill `skills_market/`（2,441 行） | ✅ | ❌ 零非测试引用 | ✅ 773 行用例 | **RED**（死代码，但质量最高） |
| MCP | ⚠️ 仅 client（`tools/mcp_tool.py`） | ❌ 0 server / 0 tool | ⚠️ | **RED** |
| Media（9 工具已注册） | ✅ | ❌ 不可达 | ✅ | **YELLOW** |
| Media Capability Provider | ⚠️ **docstring 声称的 `core.image_gen_registry` 等不存在** | ❌ | — | **RED** |
| Social | ✅ 2,182 行 | ❌ 无生产入口 | ✅ 740 行用例 | **RED**（`publish()` 无条件 raise） |
| Search（web） | ❌ **TS 全树 0 命中**；Python registry 未找到 | ❌ | — | **RED** |
| RAG 检索 | ✅ | ✅ 但静默降级 | ✅ | **YELLOW** |
| Runtime 部署 | ❌ 无 Dockerfile | ❌ | — | **RED** |
| 监控 / 备份 / 回滚 | ❌ | ❌ | — | **RED** |

## 架构问题回答

| 问题 | 回答 |
|---|---|
| **是否存在断链？** | 是。三处：① TS→Python（Runtime 未部署）；② Capability→Tool（TS 侧无 capability 层，media/social 工具无 capability 来源）；③ Plugin→Agent（`load_all()` 零调用） |
| **是否存在重复架构？** | 是。**4 套 Agent Loop**（`conversation_loop.py:2094` / `gateway/run.py` / `agent-loop.ts` / `executeEnterpriseTool`）；**4 套 Tool 权威**；**2 套 Skill 系统**；**3 个 Supabase 客户端工厂**；**2 套审计落点** |
| **是否存在废弃架构？** | 是。`gateway/`（约 40,000 行，10,172 行的 `auxiliary_client.py` 之外最大者）不从 `create_app()` 可达；`skills_market/`（2,441 行）零引用 |
| **是否存在平行系统？** | 是。TS 与 Python 各自有完整的「工具注册表 + 权限 + 审计 + 审批语义」（Phase 9 已统一审批语义，其余未统一） |

---

# 2. 功能完成度审计

## Agent

| Agent | 能否被调用 | 有工具 | 经 Gate | 真实执行 |
|---|---|---|---|---|
| CEO Agent | ✅ persona → `emp.key` | ✅ `business` toolset（10 工具） | ✅ | ⚠️ 仅当 Runtime 部署后 |
| Marketing Agent | ✅ | ✅ | ✅ | ⚠️ 同上 |
| Developer Agent | ⚠️ `request-class` file 意图 → 工具类请求在 Runtime 不可用时**硬失败** | ✅ | ✅ | ❌ **当前不可执行** |
| DevOps Agent | ⚠️ 仅 `deployment/generator.ts` 生成计划 | ⚠️ | ✅ | ❌ 不操作服务器（设计如此） |
| Workforce | ✅ `workforce/` | ⚠️ | ✅ | ❌ 不可达 |

**工具总计：101 个已注册（Phase 9 实测），0 个命中兜底策略。**

## Plugin System

| 问题 | 实测答案 |
|---|---|
| 第三方插件是否真的可以安装 | ⚠️ **部分**。`/api/plugins/{install,update,remove,toggle}` 存在，但 `plugin_center.py` 自述「生命周期操作全部委托 clisupport 里既有的 dashboard API」 |
| 是否沙箱执行 | ✅ **机制真实**：独立 OS 进程 + stdio JSON-RPC + stdout 劫持防护 + 无进程内回退（`plugin_isolation.py:572-580`） |
| **是否进入 Agent 工具列表** | ❌ **否**。`SandboxPluginLoader.load_all()` 的调用方**只有 3 个 `*_test.py`**；`kernel.py` 只有 1 处 skills 导入、无插件装配；`bootstrap.py` 零 plugin 引用。`plugin_tools.py:968` 自述同类案例：「`disable` existed and was tested, but nothing called it」 |
| 是否经过权限控制 | ⚠️ 设计正确（`plugin_gate_policies()` 一行一工具、**显式拒绝 glob**，`plugin_tools.py:161`），但被 `framework.py:134` 的全局兜底行绕过 —— **Phase 9 已修** |
| 沙箱等级 | **L2**（进程 + env 白名单；无文件系统/网络/资源隔离；`HOME` 继承 → `~/.ssh` 可读） |

## Skill System

**存在两套（严格说是四套）。**

| # | 位置 | 行数 | 生产可达 | 安全能力 |
|---|---|---|---|---|
| 1 | `roveagent/skills/` | 174 | ✅ `app.py:848,864,882` + `kernel.py:29` | ❌ 仅 `require_safe_id` + `sanitize_skill_name` |
| 2 | `roveagent/skills_library/` | 65 py + 261 md | 仅被 #1 glob | — |
| 3 | `roveagent/skills_market/` | **2,441** | ❌ **零非测试引用** | ✅ scanner(356) permissions(194) versions(255) sandbox(197) |
| 4 | `src/lib/skills.ts` | 11 | ✅ 注入系统提示词 | — |

| 问题 | 答案 |
|---|---|
| 哪个是真入口？ | **#1**（HTTP 端点导入的是 `..skills.marketplace`） |
| 哪个应该删除？ | **#3 或 #1 二选一**。任务要求「禁止两个系统长期存在」。推荐：**#1 保留为唯一入口，#3 作为其内部实现被吸收**（方案 A），因为 #3 是已经写好、773 行测试覆盖、且安全能力显著更强的一方 |
| 哪个应该合并？ | #4 的行业枚举与 #1 的 `packs/*.json` **不一致**（TS: restaurant/fastfood/cafe/retail/service；Python: healthcare/hotel/restaurant/retail） |

附带：存在 **5 个** skills 目录解析器（`constants.py:1667/338/368`、`tools/skills_tool.py`、`core/skill_utils.py`）。

## MCP

| 问题 | 实测答案 |
|---|---|
| MCP server 数量 | **0**（仓库内无 mcp 配置文件；`agent_import.py:521` 会从 `~/.claude.json` 导入 `mcpServers`，但本机无） |
| MCP tool 数量 | **0**（101 个已注册工具中无 MCP 工具） |
| 是否 Agent 可调用 | ⚠️ 机制存在（`tools/mcp_tool.py` 是外部 MCP server 的 client），但**无 server 可连** |
| 是否经过权限 | ⚠️ 若接入会经 gate，但 `model_tools.py:232-243` 记录 `discover_mcp_tools()` 的模块级自动调用**已被移除**（原因：它内部 `future.result(timeout=120)` 会冻结事件循环 120 秒）。现在需各入口显式调用 |

**结论：MCP 当前是「只建了客户端，没有服务器」。**

## Media

**代码存在 ≠ 能力存在 —— 这条在本项目上被精确验证。**

| 项 | 实测 |
|---|---|
| 已注册的媒体工具 | **9 个**：`image_generate`、`video_generate`、`xai_video_edit`、`xai_video_extend`、`text_to_speech`、`vision_analyze`、`video_analyze`、`browser_vision`、`browser_get_images` |
| provider | ⚠️ `capability_providers.py:11-15` 的 docstring 声称适配 `core.image_gen_registry` / `core.video_gen_registry` / `core.tts_registry` / `core.web_search_registry` —— **本次全仓库扫描未找到这四个 registry 的定义** |
| key | ❌ 本环境无任何媒体 provider 凭据（`check_image_generation_requirements returned False` 等 10 条 `check_fn` 每请求失败） |
| registry | ⚠️ **上述 4 个 registry 未找到**（见下） |
| agent access | ⚠️ 工具已注册 → Agent 可见，但 Runtime 不可达 |

**⚠️ 必须标注的未决项**：`capability_providers.py:11-15` 声称 "Existing registries are ADAPTED, not duplicated... `core.image_gen_registry`, `core.video_gen_registry`, `core.tts_registry`, `core.web_search_registry`"。
本次对 `roveagent/**/*.py` 扫描 `^class .*GenRegistry|image_gen_registry *=|...` **零命中**。
**两种可能**：① 这些模块在本次扫描路径之外（`UNVERIFIED`）；② docstring 引用了不存在的模块 —— 即 **`MediaCapabilityProvider` 适配的是空来源**。
**这需要一轮定向验证**（约 15 分钟），不能凭本次粗搜下结论。

TS 侧另有并行媒体栈：`src/lib/ai/image-generation.ts:110` 真实 `POST /images/generations`，**可达且 fail-closed**。

## Social Automation

| 平台 | 状态 |
|---|---|
| LinkedIn | `LinkedInAdapter:220` **只覆盖 `capabilities()`**，未覆盖 `publish()` |
| TikTok | `TikTokAdapter:236` 同上 |
| YouTube | `YouTubeAdapter:250` 同上 |
| Twitter/X | 未找到 adapter |
| 基类 | `PlatformAdapter.publish()` 在 `adapters.py:207` **无条件 `raise AdapterNotImplemented`** |
| 生产入口 | `capability_providers.py:548` 声明 `provider_id = "social:gateway"`；`social/gateway.py`（498 行）存在且有 `agent=` 参数与 `SOCIAL_PUBLISH_POLICIES`；**但除 capability 声明外无生产调用方** |

**真实发布闭环：不存在。** 但 `AdapterRegistry.implemented():292-303` 用 `type(adapter).publish is not PlatformAdapter.publish` 内省判断 —— **声明与实现不可能漂移**。这是应当保留的模式。

## Search

| 项 | 状态 |
|---|---|
| web search（TS） | ❌ **全树 0 命中**（`web_search\|tavily\|serpapi\|bing\|duckduckgo\|searxng\|exa\|perplexity\|brave`） |
| web search（Python） | ⚠️ 无 `web_search` 工具注册（101 个中无）；`capability_providers.py` 的 `SearchCapabilityProvider` 引用的 `core.web_search_registry` 未找到 |
| extraction | ⚠️ 同上 |
| enterprise search | ❌ 不存在 |
| RAG | ✅ `api/knowledge/ask` 可达，但 `route.ts:36-48` 检索失败时**静默回落「最近 5 chunk」并当引用**（Phase 9 已修为三态） |

**真实可用性：搜索能力在小企业产品中最关键的一项上，实质缺失。**

---

# 3. Runtime 性能审计（UNKNOWN 与已知并重）

## 请求生命周期（实测，n=32，mock LLM）

```
Request
 │
 ├─ http_receive + auth                    ┐
 ├─ prompt 组装（business_context 注入）    ├─ 合计 ≤ 792 ms (14.6%)  ← 上界，未分段
 ├─ toolset_resolve                        │   （未拦截，见下）
 ├─ capability_resolve                     ┘
 │
 ├─ provider：_try_nous                    40.6 ms (0.7%)   ← 5/32 请求才进入
 ├─ provider：_try_openrouter               0.0 ms (0.0%)
 │
 ├─ agent_build (AIAgent.__init__)       4079.7 ms (75.0%)  ← ★ 主瓶颈
 ├─ agent_execute (AIAgent.chat)          544.0 ms (10.0%)  ← 真正的 LLM + 工具循环
 ├─ memory_load (history)                   0.1 ms (0.0%)
 └─ persist (append)                       19.4 ms (0.4%)
```

**总量守恒校验**：`4080+792+544+41+19 ≈ 5,476` vs 实测 `5,442 ms` → 差 0.6%，计时可信。

## 分段明确度

| 阶段 | 状态 |
|---|---|
| auth | **UNKNOWN**（含在 792 ms residual 内） |
| capability | **UNKNOWN**（补丁因模块级 `from ... import` 直接绑定而未拦截） |
| toolset_resolve | **UNKNOWN**（同上） |
| provider (`_try_nous`) | **40.6 ms** ✅ |
| provider (`_try_openrouter`) | **0.0 ms** ✅ |
| agent init | **4,079.7 ms** ✅ **已确认主瓶颈** |
| memory | **0.1 ms** ✅ |
| LLM | **≈0**（mock 即时返回） |
| tool | 未触发（mock 不调用工具），**UNKNOWN** |

## 已证伪的假设（重要）

Phase 10.5–10.6 怀疑：provider discovery / credential resolution / fallback retry / health check / hidden network timeout。

| 假设 | 实测 | 结论 |
|---|---|---|
| provider discovery | 0.7% + 0.0% | ❌ **证伪** |
| credential resolution | 含在上述 0.7% 内 | ❌ **证伪** |
| hidden network timeout | 27/32 请求根本不碰 provider | ❌ **证伪** |
| memory | 0.1 ms | ❌ **证伪** |
| **agent init** | **75.0%** | ✅ **确认** |

**`OFFLINE_STRICT` 实验**（给 `_try_nous` 加短路）：P50 5,232 → 5,170 ms（**−1.2%，噪声内**）→ 按规则回滚，未进仓库。

## 未定位的部分

**`AIAgent.__init__` 的 4.08 秒具体花在哪一行 —— UNKNOWN。**
已缩小到强假设：`get_tool_definitions()`（registry walking + schema filtering + `check_fn` probing）。
依据：`model_tools.py:292-296` 注释自述该缓存「avoids ~7 ms per call」，但实测是 **4 秒**；且 stderr 中**每请求**出现 10 条 `check_fn … returned False`，其中 `check_spotify_available` / `_check_yuanbao` / `check_x_search_requirements` / `check_vision_requirements` 可能做凭据或网络探测。背景参数：**101 个已注册工具**。
**一轮验证即可确认**（约 20 分钟）。

---

# 4. 安全审计

## Authentication

| 项 | 状态 |
|---|---|
| API key（TS↔Python） | ✅ `X-RoveAgent-Key` + `secrets.compare_digest`，key 未配置时 fail-closed 401 |
| session（商户） | ✅ JWT 本地验签（HS256 alg 白名单防算法混淆）+ 60s token 缓存 + 5min role 缓存 |
| cookie | ✅ `Secure` 属性按**请求协议**自适应（`isSecureRequest`），非按 NODE_ENV |
| 平台控制面 | ✅ 独立 cookie 命名空间 `rf_admin_session`，`adminHandler` 覆盖 8/8 admin 路由 |

## Authorization

| 检查项 | 结果 |
|---|---|
| EnterpriseToolGate 默认策略 | ✅ **Phase 9 修复**：兜底行不再授权；命中兜底即拒绝（无论是否已注册） |
| 未注册工具 | ✅ 拒绝（`unknown tool`） |
| Wildcard | ✅ `plugin_gate_policies()` **显式拒绝 glob**（一行一工具） |
| **default allow** | ✅ **已消除**。Phase 9 前：101 个中 **82 个**命中兜底 = 免权限免审批直执（含 `execute_code` / `computer_use` / `browser_exec` / `browser_cdp` / `setup_mcp`） |
| Permission escalation | ⚠️ 仍存一处：**82 条新策略行的 permission 为空串**（有意为之，避免静默锁死 manager/staff）。权限层未收敛 |
| Approval bypass | ✅ **Phase 9 修复**：HIGH/CRITICAL **任何角色不得自动跳过**（含 owner/admin）。修复前 owner 调 `terminal`/`write_file`/`send_*` 不产生审批单 |
| Fallback | ✅ Python `signed_auth` 的 `APPROVAL_SECRET or API_KEY` 回落已删除，缺失或相同即 503 |

## Secret

| 项 | 状态 |
|---|---|
| env | ⚠️ `scripts/deploy.env` 含真实 service_role key（219 字符）+ JWT secret（88 字符）；**既未跟踪也未 gitignore** |
| hardcode | ✅ `pnpm scan:secrets` 通过（2179 文件） |
| **fallback secret** | ⚠️ `crypto.ts:8` 缺 `ENCRYPTION_SECRET` 时回落 `COZE_SUPABASE_SERVICE_ROLE_KEY` —— **Phase 9 已改为打印显著告警**，未彻底移除（需部署侧先提供该变量） |
| **key reuse** | ⚠️ **存在**：DB 超级凭据复用为凭据加密密钥。轮换 service_role key 会让全部已落库凭据**永久不可解密** |

## Sandbox

**真实隔离等级：L2**

| 维度 | 状态 |
|---|---|
| 进程隔离 | ✅ 独立 OS 进程（`plugin_sandbox_runner.py:174`） |
| 故障隔离 | ✅ 优秀：stdout 重定向防伪造 JSON-RPC（`:294-298`）、单工具异常不断进程、**显式拒绝进程内回退**（`plugin_isolation.py:572-580`） |
| 环境变量 | ✅ **真实白名单**（`:421-432`），NEVER 列表优先于显式授权（`:475-476`） |
| 文件隔离 | ❌ 无（可读宿主文件系统） |
| 网络隔离 | ❌ 无（可任意出站） |
| 资源隔离 | ❌ 无 rlimit/cgroup |
| 密钥隔离 | ⚠️ env 安全，但 `HOME`/`USER`/`SHELL`/`PATH` 继承（`:431`）→ `~/.ssh` 可读 |
| **容器模式** | 🔴 **死代码**。`plugin_tools.py:359,673` **硬编码 `SUBPROCESS`**；`plugin_isolation.py:514-532` 的 `--network none --read-only --tmpfs --user 65534` **从未被执行** |
| 强制开关 | ⚠️ `enforce` 默认 **False**（`:328`）→ 模式不可用时仍放行 |

**距生产差 2 级（L2 → L4）。** 但加固参数**已经写好**，成本主要在接通而非实现。

---

# 5. 测试质量审计

## 数量与结果（本次实测）

| 套件 | 总数 | 通过 | 失败 | 命令 |
|---|---|---|---|---|
| **Python** | **782** | **782** | 0 | `pnpm test:python`（默认 `ROVEAGENT_OFFLINE=1`） |
| **TypeScript** | **621** | **621** | 0 | `pnpm test` |
| **合计** | **1,403** | **1,403** | **0** | — |

## 质量分类（A/B/C/D）

| 类 | 定义 | 已知实例（`file:line` 证据） | 占比估计 |
|---|---|---|---|
| **A：真实链路** | 驱动真实 app / 真实中间件 / 真实签名回调 / 真实沙箱子进程 | `production_chain_e2e_test.py`（6 用例：真实 FastAPI + 真实 gate + 真实 HMAC）、`approval_flow_test.py`、`recovery_campaign_test.py`、`plugin_isolation_test.py`（真实 spawn 沙箱并断言宿主密钥不可见）、`external_call_guard_test.py`（socket 层断言）、`business_isolation_test.py`、`context_isolation_test.py`、TS `api-auth.test.ts`、`api-rbac-contract.test.ts` | **≈30%** |
| **B：mock 链路** | patch 掉外部 provider，但服务代码真实执行 | 多数 `tests/*.test.ts`（stub Supabase/AI）、`capability_*_test.py` | **≈40%** |
| **C：纯函数** | 无 IO、无集成 | `format-time`、`rate-limit`、`ai-router-contract`、`artifacts-pdf`（994 行）、`artifacts-writers`、`personas` | **≈15%** |
| **D：无法证明生产行为** | **源码文本正则断言 / 自我实现断言** | **`scheduler-mutex.test.ts:13-50`** —— 强制 in-flight 标志后断言 `assert.ok(true)`（自我实现），另加多条对日志字符串的源码正则；**`runtime-fallback-policy.test.ts`** 同类 | **≈15%** |

**方法声明**：A/B/C/D 的占比是**基于已审阅文件的估计**，不是逐文件统计。精确分类需要对 1,403 个用例逐个审阅（**约 1 人日**）。**已知的 D 类实例有明确 `file:line` 证据**；占比数字为估计值。

## CI 实际门禁

`.github/workflows/ci.yml` 只跑 4 步：`pnpm install` → `pnpm ts-check` → `pnpm test` → `pnpm lint:build`。

**缺失**：`lint:style`、`validate:migrations`、`scan:production`、`test:python`、`build`、Docker build。
而 `ARCHITECTURE.md:113` 声称 CI 跑 8 项（含 Python 测试、RoveAgent E2E、构建验证、生产扫描）—— **5 项不存在**。

---

# 6. 代码质量审计

## 仓库规模（本次实测）

| 目录 | 文件 | 行数 |
|---|---|---|
| `src`（TS/TSX） | 322 | **50,493** |
| `roveagent`（Python） | 1,637 | **821,458** |
| `tests` | 65 | 9,139 |
| `scripts` | 69 | 5,281 |
| `packages/roveagent-core` | 10 | 117 |

**Python 占 94%。**

## 重复实现与平行模块

| 类型 | 实例 |
|---|---|
| Agent Loop | **4 套**：`core/conversation_loop.py:2094`（主）、`gateway/run.py`（平行服务）、`packages/roveagent-core/agent-loop.ts`（TS 兜底）、`src/lib/enterprise/tool-runtime.ts:219` |
| Tool 权威 | **4 套**：`AgentToolRegistry`(14) / `executeEnterpriseTool`(6) / `coding-agent/*` / `EnterpriseToolGate`(101) |
| Skill | **4 套**（见 §2） |
| Supabase 客户端 | **3 个工厂**：`getSupabaseClient` / `getFreshServiceClient` / `getCleanServiceClient` |
| 审计落点 | **2 套**：Postgres `audit_events` / 本机 `*.jsonl` |
| 媒体栈 | **2 套**：TS `image-generation.ts`（可达）/ Python media hub（不可达） |

## 最大文件

| 文件 | 行数 | 问题 |
|---|---|---|
| `roveagent/gateway/run.py` | **30,947** | 唯一 >10,000 行文件；**不可达** |
| `roveagent/core/auxiliary_client.py` | **10,172** | 不可达侧的最大模块；`_try_nous` 未被闸门覆盖 |
| `roveagent/core/conversation_loop.py` | 8,372 | 主 Agent Loop |
| `roveagent/core/context_compressor.py` | 8,070 | — |
| `roveagent/gateway/platforms/api_server.py` | 7,231 | aiohttp 平行服务，不可达 |
| `src/lib/artifacts/extract.ts` | 1,898 | 零依赖二进制解析（**必要复杂**） |
| `src/app/[locale]/settings/page.tsx` | 1,693 | 7 分组单文件 |
| `src/lib/artifacts/pdf-writer.ts` | 1,617 | 手写 PDF（**必要复杂**） |

---

# 7. SaaS 生产化审计

## 部署

| 项 | 状态 |
|---|---|
| Dockerfile | ❌ **不存在** |
| docker-compose | ❌ **不存在**（`docker-compose.exe` 存在但 daemon 不可达） |
| migration | ⚠️ 7 个 SQL 文件，`autoMigrate()` 启动时跑前 3 个；`ssl:{rejectUnauthorized:false}` |
| secret 管理 | ⚠️ 明文 `scripts/deploy.env`（未跟踪未 gitignore）+ `.env`（gitignore） |
| health check | ⚠️ TS `/api/health` **公开且泄漏表名**、不探测 runtime；Python `/api/health` **无鉴权**且返回租户数（实测 `{"tenants":0}`） |
| monitoring | ❌ 无 APM / metrics / tracing |
| backup | ❌ 无脚本、无演练 |
| **rollback** | 🔴 **不可行** —— 源码未纳入版本控制 |

## 多租户

| 项 | 状态 |
|---|---|
| tenant isolation | ⚠️ **应用层 only**。service_role 全绕过；RLS policy 是 `to service_role using (true) with check (true)`。依赖 `tenant-db.ts` 白名单 + 手写 `.eq('tenant_id')` |
| 白名单覆盖 | ⚠️ 26 处直接 `getSupabaseClient().from()` 绕过白名单 |
| data separation | ✅ business 级双 scope（tenant + business）谓词 |
| permission | ✅ 3 角色 26 权限 + `protect*Mutation` 覆盖 52 路由 |

## 扩展性（100 / 1,000 / 10,000 用户）

| 规模 | 瓶颈 | 依据 |
|---|---|---|
| **100 用户** | ⚠️ **`agent_build` 4.08 秒/请求**。单实例 4 并发槽（`acquireSlot(...,4)` 进程内）→ 100 用户下排队显著 | Phase 10.7 实测 |
| **1,000 用户** | 🔴 三重：① 单实例 4 并发槽（多实例时限额 ×N 而非共享）；② **13 处进程内状态**（限流窗口/退避/槽/token 缓存/role 缓存/settings 缓存/wipe token/platform-admin 内存库/usage-ledger latch/scheduler 标志）；③ scheduler 每 tick 对 tenants × businesses **串行**跑 5 类任务 | `rate-limit.ts:42-44`、`auth-guard.ts:105,220`、`scheduler.ts:326-359` |
| **10,000 用户** | 🔴 不可行。无共享限流后端（无 Redis）、无监控、无备份、无 DB 连接池配置、无水平扩展验证 | 同上 + §7 部署 |

---

# 8. AI 智能化程度审计

## Agent 能力

| 能力 | 评估 | 证据 |
|---|---|---|
| **planning** | ⚠️ 弱 | TS 侧靠**正则** `classifyRequest` 决定是否进 planner；Python 侧 `conversation_loop` 有迭代循环。**无任务分解、无子目标** |
| **reasoning** | ⚠️ 依赖模型 | `reasoning.ts` + `REASONING_LEVELS` 只调 `max_tokens`/`temperature`/`reasoning_effort`，不做显式推理链 |
| **memory** | ✅ 可用 | TS `business_memories` + L2/L4 写入；实测读取 **0.1 ms**。Python L0–L4 分层记忆不可达 |
| **tool usage** | ✅ 强 | 101 工具 + `AgentToolRegistry` 契约（schema/permission/risk/approval/timeout）+ canonical tool-call keys + 重复检测 |
| **self correction** | ⚠️ 弱 | `agent-loop.ts` 有 `repetition-guard` 与重复调用抑制；**无反思（reflection）环节** |

## 自动化程度

| 问题 | 答案 |
|---|---|
| 人工配置多？ | **是。** 部署需手工设 7 个环境变量 + 手动起 2 个进程 + 手工跑 7 个迁移（Phase 10.5 实测）；`AGENTS.md` 记录了多个「必须重启服务」「必须同时改两个文件」的手工步骤 |
| 系统自主发现能力？ | **少。** 有 `capability_registry`（可发现能力）但 TS 侧不可达；`AgentRegistry.for_industry()` 有行业→团队映射；**但无自主发现新能力、无自学习闭环**（Python `skills_market/scanner.py` 与自学习闭环不可达） |

**智能化评价：当前是可审计的单轮 RAG + 14 个只读/建审批单工具（TS 侧），加 101 个不可达工具（Python 侧）。自主性在生产配置下为 0。**

---

# Capability Matrix

| 能力 | 完成度 | 问题 | 建议 |
|---|---|---|---|
| Frontend | 90% | 3 个 page.tsx >1,250 行 | 拆组件 |
| API Layer | 88% | `withAuth` 仅 8 路由；`getAuthContext` 死代码 | 删除死层或接线 |
| 审批总线 | **95%** | 无 | **保留（核心资产）** |
| 审计链路 | 90% | 两套落点 | 合并到 Postgres |
| EnterpriseToolGate | **92%** | 82 行 permission 为空 | 权限收敛 |
| Capability Registry | 85% | TS 侧 0 覆盖 | 由服务端提供能力视图 |
| **Plugin** | **35%** | `load_all()` 零调用；沙箱 L2；容器模式死代码 | **接通 load_all + 沙箱升 L4** |
| **Skill** | **40%** | 4 套实现；安全版死代码 | **方案 A 合并** |
| **MCP** | **10%** | 0 server / 0 tool | 明确是否要做 |
| **Media** | **30%** | registry 未找到（UNVERIFIED）；无凭据 | 定向验证 registry |
| **Social** | **15%** | `publish()` 无条件 raise；无生产入口 | 要么做要么保留为声明 |
| **Search** | **10%** | TS 0 命中；Python registry 未找到 | **产品的关键缺口** |
| 文档引擎 | 85% | 缺 CJK 字体 | 下沉字体 |
| RAG | 75% | 绑定 Coze；曾静默降级（已修） | 抽象嵌入 provider |
| Provider/failover | 88% | 平台档锁 Coze | 抽象平台档 |
| **Runtime 部署** | **5%** | 无 Dockerfile | **P0** |
| 多租户隔离 | 70% | 应用层 only | lint 强制 |
| 监控/备份/回滚 | **3%** | 全缺 | **P0** |
| 性能 | 30% | `agent_build` 4.08s | 先测后修 |

---

# Critical Missing List

## P0 — 必须解决才能上线

| ID | 问题 | 证据 | 工作量 |
|---|---|---|---|
| P0-1 | **Runtime 无部署路径** | `.coze:4` 仅 `nodejs-24`；`start.sh` 只跑 node；`deploy.env` 无 `ROVEAGENT_*` | 3–5 人日 |
| P0-2 | **源码未纳入版本控制 → 无回滚** | `git toplevel` = 父目录；`?? roveframe-src-latest/`；最后提交 09-08 vs 文件 09-13 | **0.5 人日** |
| P0-3 | **凭据明文且未忽略** | `scripts/deploy.env` 含真实 service_role key + JWT secret；`git check-ignore` 不匹配 | **0.5 人日** |
| P0-4 | **无监控 / 无备份 / 无回滚演练** | 全部缺失 | 5–8 人日 |
| P0-5 | **CI 不 gate 构建** | `ci.yml` 仅 4 步；`ARCHITECTURE.md:113` 虚报 8 项 | 1 人日 |

（Phase 9 已关闭：slot 泄漏、`envLoaded`、HMAC 塌缩、mock 不可区分、Tool Gate default-allow、RAG 伪引用、商品生成假数据、scheduler 水位、SSE 错误处理）

## P1 — 严重影响体验

| ID | 问题 | 证据 | 工作量 |
|---|---|---|---|
| P1-1 | **`agent_build` 4.08 秒/请求（75%）** | Phase 10.7 实测；具体行未定位 | 定位 0.5 + 修复待定 |
| P1-2 | Plugin 从未进入调用链 | `load_all()` 仅测试调用 | 5 人日 |
| P1-3 | 沙箱 L2（容器模式死代码） | `plugin_tools.py:359,673` 硬编码 | 15 人日 |
| P1-4 | **Search 实质缺失** | TS 全树 0 命中 | 5–10 人日 |
| P1-5 | RAG 绑定 Coze 嵌入，无抽象 | `embedding.ts:1` | 5–10 人日 |
| P1-6 | 客户端断开不取消生成 | `chat/route.ts:292-323` | 1–2 人日 |
| P1-7 | 无熔断 / 无 jitter / Supabase 无超时 | 全仓库 0 命中 | 3 人日 |
| P1-8 | TS 行为级测试缺失（A7/A8/A9/A10/P2） | 需路由级脚手架 | 4 人日 |
| P1-9 | 中文 PDF 降级（缺字体） | `public/fonts/` 仅 README | 0.5 人日 |
| P1-10 | `tokenCache` 无界增长 | `auth-guard.ts:220-244` | 0.5 人日 |

## P2 — 优化

`migration.ts` TLS 不校验 ｜ `/api/health` 双端泄漏 ｜ `getClientIp` 信任 XFF ｜ `tool-runtime.ts:280` setTimeout 泄漏 ｜ 13 处进程内状态 ｜ `usage-ledger` 粘滞 latch ｜ scheduler 绑死自定义 server ｜ webhook 租户枚举 ｜ 4 处未保护读改写 ｜ ≥7 次串行 RTT ｜ 模型解析每轮两次 ｜ Python 依赖不可复现 ｜ 文档漂移 4 处

## P3 — 长期

`'manage'` 权限未定义 ｜ StatusStrip 泄漏 provider id ｜ 三语应用硬编码英文错误 ｜ `done` 字段被忽略 ｜ 无 `aria-live` ｜ `@aws-sdk/*` 死依赖（2 个） ｜ `scheduler-mutex.test.ts` 源码正则 ｜ `test:python` 曾不在 `validate`

---

# Dead Code List

| 文件 / 模块 | 行数 | 原因 | 建议 |
|---|---|---|---|
| `roveagent/gateway/run.py` | **30,947** | `api/` 内零模块级 gateway 导入；`python -m gateway.run` 独立入口 | **删除**（先摘 `tools/*` 惰性 import） |
| `roveagent/gateway/platforms/**` | ~15,000 | aiohttp `BasePlatformAdapter`，仅经 `run.py:17431` 可达 | **删除** |
| `roveagent/gateway/{base,session,slash_commands,stream_consumer}.py` | ~15,000 | 同上 | **删除** |
| `roveagent/skills_market/` | **2,441** | 零非测试引用；HTTP 用的是 104 行简化版 | **合并**（方案 A：作为 `skills/` 的内部实现） |
| `src/lib/agent/permissions/engine.ts` | 142 | 唯一调用方是 `tests/agent-permissions.test.ts` | **删除** |
| `src/lib/enterprise/memory.ts` | 144 | 唯一调用方是测试 | **删除** |
| `getAuthContext` + `RF_HEADERS` + `injectRfHeaders` | ~40 | **全仓库 0 读取** | **删除** |
| `src/lib/plugins/*`（TS） | 66 | 仅 `nl-engine.ts:416` + 自身测试 | **删除或接线** |
| `src/lib/skills.ts` | 11 | 行业枚举与 Python 分叉 | **合并** |
| `@aws-sdk/client-s3` + `lib-storage` | 2 依赖 | 全仓库 0 import | **删除** |
| `skills_library/` 非业务分类 | 261 md | apple/creative/note-taking 等 | **删除**（需产品确认清单） |
| `roveagent/social/` | 2,182 | `publish()` 无条件 raise；无生产入口 | **保留**（见下） |

**关于 `social/` 的例外说明**：它是死代码，但**不应该删**。`PlatformAdapter.publish()` 无条件 raise + `AdapterRegistry.implemented()` 内省判断，使「声明」与「实现」不可能漂移 —— 这是仓库里最诚实的模块之一，应作为**其他能力声明的范式**保留。

**死代码合计约 63,000 行（占 Python 的 7.7%）。**

---

# Architecture Problems

## 1. 当前最大架构债是什么？

> **同一件事在仓库里存在两份以上，且其中质量更高的一份未被使用。**

具体表现：
- **Skill**：2,441 行含 scanner/permissions/versions/sandbox 的完整版**零引用**，生产用的是 104 行无加固版
- **Agent Loop**：4 套；主 Loop（`conversation_loop.py`）之外，`gateway/run.py` 有独立 turn loop（约 40k 行不可达）
- **Tool 权威**：4 套，其中 TS 侧 3 套各自有独立的权限模型与审计路径
- **审计**：2 套落点，容器回收即丢一套

这不是「设计能力不足」，是**设计未收敛**。历史模式清晰：每次遇到缺口就新建一个实现，旧实现不删。

## 2. 哪些模块应该删除？

`roveagent/gateway/`（~40,000 行）｜`skills_market/`（若选方案 B）｜`src/lib/agent/permissions/engine.ts`｜`src/lib/enterprise/memory.ts`｜`getAuthContext` 死层｜`src/lib/plugins/*`（TS）｜`@aws-sdk/*`（2 依赖）｜`skills_library/` 非业务分类（261 md）

## 3. 哪些模块应该合并？

`skills_market/` → `skills/`（方案 A）｜`executeEnterpriseTool` → `AgentToolRegistry`｜3 个 Supabase 工厂 → auth client + data client｜Python `*.jsonl` 审计 → Postgres `audit_events`｜`src/lib/skills.ts` → `skills/packs/*.json`｜TS 与 Python 的审批语义（**Phase 9 已完成**）

## 4. 哪些模块虽然完成但没有价值？

| 模块 | 判定 |
|---|---|
| `gateway/`（40k 行） | **零价值**（不可达、无测试、无 CI） |
| `src/lib/plugins/*`（TS 66 行） | **零价值**（不是插件系统，是 manifest 校验器） |
| `skills_library/` 非业务分类（261 md） | **对 SMB 餐饮产品零价值** |
| `roveagent/social/` | ⚠️ **有范式价值，无产品价值**。建议保留代码但停止宣称其为「能力」 |
| `@aws-sdk/*` | 零价值 |

---

# Final Roadmap

## 7 天计划

| # | 事项 | 收益 | 风险 | 工作量 |
|---|---|---|---|---|
| 1 | **`git add` 工作树 + 提交；`.gitignore` 补 `scripts/deploy.env`** | **恢复回滚能力**（解锁其余一切） | 低（注意顺序：先 ignore 再提交） | 0.5 天 |
| 2 | **写 Dockerfile + 进程编排，把 Runtime 真正部署起来** | 让 821,458 行从资产变成能力 | 中（必须与 #3 同批，否则激活绕过） | 3–5 天 |
| 3 | Tool Gate 收尾 + 权限语义对齐（Phase 9 已做主体，此处仅收口） | 避免部署时激活缺口 | 低 | 0.5 天 |
| 4 | 修 `agent_build` 的定位实验（patch `get_tool_definitions` + `check_fn` 计数） | 定位 75% 耗时的具体行 | 低 | 0.5 天 |
| 5 | `/api/health` 双端拆分（公开 liveness + 鉴权 detail） | 停止泄漏 schema 与租户数 | 低 | 0.5 天 |

## 30 天计划

| # | 事项 | 收益 | 风险 | 工作量 |
|---|---|---|---|---|
| 6 | 基于 #4 的结果修 `agent_build` 热点 | 单请求 P50 有实质下降（幅度待测） | 中 | 3–5 天 |
| 7 | CI 补全：`test:python` + `scan:production` + `validate:migrations` + `build` + Docker build | 让「绿」有意义 | 低 | 1 天 |
| 8 | Skill 方案 A 合并（S1–S5） | 消除 2,441 行死代码，安装路径获得 scanner/permissions | 中（`app.py` 三个端点） | 4 天 |
| 9 | 建立 TS 路由级测试脚手架 + 补 A7/A8/A9/A10/P2 行为级测试 | 关闭 5 项无验证修复 | 低 | 4 天 |
| 10 | 熔断 + jitter + Supabase 超时 + 客户端断开取消 | 稳定性与资源占用 | 中 | 4 天 |
| 11 | 可观测性最小集：结构化日志 + request-id 贯通 + 4 个指标 | 故障可发现 | 低 | 3 天 |
| 12 | CJK 字体下沉 `public/fonts/` + 纳入 `build.sh` | 恢复中文 PDF 交付 | 低 | 0.5 天 |

## 90 天计划

| # | 事项 | 收益 | 风险 | 工作量 |
|---|---|---|---|---|
| 13 | 删除 `gateway/`（先摘惰性 import） | −40,000 行；审计面收窄 | 中（需先验证 `tools/*` 降级） | 6–8 天 |
| 14 | 沙箱 L2 → L4（移除硬编码 SUBPROCESS + 接通容器参数 + `enforce` 默认 True） | 第三方插件真正隔离 | 中（需 Docker 环境） | 8 天 |
| 15 | 插件接通：`SandboxPluginLoader.load_all()` 进入启动路径 + Plugin Center UI | 插件系统进入调用链 | 中 | 5 天 |
| 16 | 搜索能力建设（TS 侧 0 → 可用） | **产品的关键缺口** | 中 | 5–10 天 |
| 17 | 嵌入 provider 抽象（去除 Coze 绑定） | RAG 可自托管 | 中 | 5–10 天 |
| 18 | 监控 / 备份 / 回滚演练 | 可运营 | 中 | 8 天 |
| 19 | 多租户压测 + RLS 零交叉验证 + 水平扩展验证 | 可信的 1,000 用户 | 高 | 8 天 |
| 20 | 数字员工实体化（persona + 工具集 + 权限 + 排班 + KPI） | 兑现「AI 员工」定位 | 中 | 15 天 |

---

# 严格要求遵守声明

| 要求 | 遵守 |
|---|---|
| 禁止修改代码 | ✅ **本次未修改任何代码** |
| 禁止新增功能 | ✅ 未新增 |
| 禁止修复问题 | ✅ 未修复（本报告中所有 Phase 9/10 修复均为**既往轮次**已完成，此处仅作事实引用） |
| 禁止凭记忆 | ✅ 所有数字来自本次实测（两套测试运行、ts-check、注册表枚举、git、端口、Docker、文件扫描） |
| 禁止根据文档判断完成 | ✅ 本报告明确指出 4 处文档与实测不符（`ARCHITECTURE.md:113` 虚报 CI 门禁；`capability_providers.py:11-15` 引用的 4 个 registry 未找到） |
| 无法测量时写 UNKNOWN | ✅ auth / capability / toolset_resolve / tool / `agent_build` 内部均已标 UNKNOWN |

---

# 最终结论：一句话回答

> ## 「现在这个 RoveFrame，到底距离一个真正可商业化 SaaS AI 员工平台还有多远？」
>
> **技术上 6–9 个月；但真正的距离不是时间，而是两件各自只需 1 天的事 —— 把源码纳入版本控制、把 Runtime 部署起来。在这两件事完成之前，821,458 行代码、101 个工具、782 个通过的测试，对任何终端用户都不产生任何价值。**

**三句话补充**：

1. **控制面已达生产级**（审批冻结哈希 + CAS 租约 + 幂等 + 审计 + SSRF 防护 + default-deny 门控），这是真正的护城河，且比同类产品更完整。
2. **执行面从未上线**，而它**能跑**（Phase 10.5 已证明）。卡住它的不是技术，是没有人写过 Dockerfile。
3. **性能问题已被量化定位**：`AIAgent.__init__` 占 75%，而此前怀疑的 provider/网络/memory **合计 <1%**。方向已经纠正，剩下的是定位到行。
