# RoveFrame AI OS 2.0 — 架构诊断报告

**日期**：2026-09-12
**角色**：首席架构工程师
**范围**：TS/Next.js 应用面 ↔ Python `roveagent` 内核的接管链路
**约束**：本报告**未修改任何业务代码**。仅新增一个只读探针脚本 `scripts/_probe_roveagent_boot.py`。

---

## 0. 执行摘要

### 0.1 三条结论

1. **内核是可自举的。** 我在本机实测跑通了 `ServiceContext` 全量初始化（kernel + EnterpriseToolGate + enterprise memory + chat sessions + 行业包同步），FastAPI app 正常构建，**16 个端点全部在线**，且与 TS 客户端调用的路径完全对应。第一阶段的启动障碍**不是代码问题，是配置问题**。

2. **接管不只是「连上」那么简单。** 断链有 **4 层**，其中第 3、4 层即使把服务启动起来也依然存在。特别是：**`/api/agent/chat` 是同步非流式的**，而 TS 侧按 SSE 期望消费 —— 只做「启动服务」会得到一个能返回内容但无法流式的内核，以及仍然无法改文件的 Developer Agent。

3. **第二阶段要求的 `Agent → Permission → Toolset` 里，`Permission → Toolset` 已经实现且有生产级质量**（`EnterpriseToolGate`，fail-closed，审批回放，审计）。缺的只有最上面一层：**按 Agent 身份推导 toolset**。这是一个**单一改动点**，不需要新建权限系统。

### 0.2 阶段可行性速判

| 阶段 | 内容 | 现状 | 我的判定 |
|---|---|---|---|
| 一 | 恢复 Runtime 主链路 | 内核可启动，配置缺失，静默降级 | **可做**，但需先补流式契约（见 §3.4） |
| 二 | Agent→Permission→Toolset | 门控已完成 80%，缺 agent→toolset 映射 | **可做**，改动集中在 3 个文件 |
| 三 | Developer Agent 真执行 | 需开 `coding` toolset + 反转 `forbidden` | **可做**，有 1 个产品决策点 |
| 四 | DevOps Agent | `terminal`/`process` 已存在；ssh/docker 缺失 | **部分可做**，ssh/docker 是新增 |
| 五 | Plugin Center | Python 插件系统真实可用 | **可做** |
| 六 | 插件沙箱隔离 | 沙箱模块存在但**未接插件加载路径** | **需新建集成层** |
| 七 | Media Hub | 图像可用；视频/音频缺 provider 与凭据 | **图像可做，视频/音频部分可做** |
| 八 | Search System | 8 后端已实现 | **可做，纯配置+接线** |
| 九 | Social Automation | 22 渠道已有；LinkedIn/TikTok/YouTube/Bilibili/小红书**不在其中** | **部分可做**，5 个目标平台需新增 |
| 十 | Document Runtime | PDF 缺字体；DOCX/PPTX/XLSX 已可用 | **中文 PDF 一行配置可修** |
| 十一 | 性能优化 | 4 轮预算、8 串行 await、假流式 | **可做** |

### 0.3 必须先解决的两个前置阻塞

**阻塞 A：没有 LLM 凭据，内核无法服务任何请求。**

实测探针输出：

```
[probe] LLM configured: False  (ROVEAGENT_LLM_API_KEY/OPENAI_API_KEY)
```

且失败形态是**明确的 503**（`api/app.py:113-116` 主动抛 `RuntimeError`，`app.py:338-339` 转 `HTTPException(503)`）——它**不会伪造回答**，这点设计是对的。

本机也不存在 roveagent 自身的配置文件（`~/.roveagent/` 下只有 `audit/tool_gate.jsonl`，无 `config.yaml`）。

**这件事必须由你决定**：内核要用哪个模型。RoveFrame 的模型配置存在 Supabase `model_configs` 表（TS 侧管理），而内核读的是**进程环境变量**。两者目前**没有任何同步机制**——这是第一阶段必须设计的桥。

**阻塞 B：探针启动时发生了真实的外部 API 调用。**

`ServiceContext.__init__` 触发 aux 模型解析时，探针尝试了 OpenRouter 与 Nous Portal，并**收到真实的 payment/credit 错误**：

```
Auxiliary client: PAID lane engaged for auxiliary task — OpenRouter fallback model
  'google/gemini-3.6-flash' is not a :free SKU and may incur real spend.
Auxiliary: marking openrouter unhealthy for 60s (payment / credit error).
Auxiliary Nous client unavailable: no Nous authentication found (run: roveagent auth).
```

两个含义：① 内核启动路径**存在隐式上游调用**，在计费环境里需要隔离或显式关闭；② 本机的 OpenRouter/Nous 凭据是**无效或缺失**的。启动内核前应先设 `auxiliary.free_only: true` 或禁用 aux。

---

## 1. 系统现状：两套完整运行时并存

```
                        ┌─────────────────────────────────────┐
                        │  Next.js 16 (App Router, React 19)  │
                        │  src/app/api/agent/chat/route.ts    │
                        └───────────────┬─────────────────────┘
                                        │
                        ┌───────────────▼─────────────────────┐
                        │  roveAgentConfigured() ?            │
                        │  client.ts:28                       │
                        └───────┬─────────────────┬───────────┘
                            true│                 │false
                                │                 │
              ┌─────────────────▼──┐    ┌─────────▼──────────────────┐
              │ POST /api/agent/   │    │ TS 兜底 Agent Loop         │
              │      chat          │    │ packages/roveagent-core/   │
              │ (非流式 JSON)       │    │ src/runtime/agent-loop.ts  │
              └─────────┬──────────┘    │ maxIterations=4            │
                        │               │ maxToolCalls=4             │
                        │               │ 工具：12 个，无文件工具      │
                        │               └────────────────────────────┘
              ┌─────────▼──────────────────────────────┐
              │ roveagent/api/app.py::chat()           │
              │ toolsets=("safe","memory","business")  │  ← 硬编码
              └─────────┬──────────────────────────────┘
                        │
              ┌─────────▼──────────────────────────────┐
              │ AIAgent (runtime.py) → 工具循环         │
              │ 每次工具调用经 tool_execution 中间件：   │
              │ EnterpriseToolGate (fail_closed=True)  │
              └────────────────────────────────────────┘
```

**关键事实**：`src/lib/agent/gateway.ts:12` 从 `../../../packages/roveagent-core/src` 导入本地 TS 的 `runAgentLoop`。也就是说 TS 层有**自己的一套 Agent Loop**，与 Python 的 `AIAgent` 完全独立。这不是 fallback，这是**并行实现**。

### 1.1 断链定位（4 层）

| 层 | 位置 | 现状 | 严重度 |
|---|---|---|---|
| L1 配置 | `.env` / `scripts/deploy.env` | 无任何 `ROVEAGENT_*`；服务未运行（:8788 拒连） | 阻塞 |
| L2 降级 | `chat/route.ts:470-476` | 捕获 `RoveAgentUnavailable` → 仅 `console.warn` → 静默走 TS 路径 | **高**（掩盖一切） |
| L3 契约 | `app.py:277-278` vs `client.ts:101` | API 返回**非流式 JSON**；TS 期望 SSE | **高**（阶段一必解） |
| L4 权限 | `app.py:332-337` | `toolsets=("safe","memory","business")` 与 `req.agent` 无关 | **高**（阶段二必解） |

---

## 2. Python 内核启动入口与运行契约（已验证）

### 2.1 启动入口

```
# 脚本（推荐）
scripts/roveagent-service.sh
  └─ exec python -m uvicorn roveagent.api.app:get_app --factory --host 127.0.0.1 --port 8788
       └─ app.py:660  def get_app(): 延迟构建单例
            └─ app.py:228  def create_app(): FastAPI(title="RoveAgent Service", version="1.0.0")
```

`app.py:657` 的模块级 `app = None` 是有意为之（延迟构建，避免无 fastapi 环境 import 失败）。**必须用 `--factory`**，直接 `roveagent.api.app:app` 会拿到 `None`。

### 2.2 环境契约（实测必需）

| 变量 | 必需性 | 用途 | 缺失后果 |
|---|---|---|---|
| `ROVEAGENT_API_KEY` | **必需** | `app.py:234` 校验 `X-RoveAgent-Key` | 401；且脚本 `:25` 直接 `${VAR:?}` 退出 |
| `ROVEAGENT_ROOT` | 建议 | 数据根（kernel/memory/tasks/chat_sessions） | 回落 `.roveagent`（相对 cwd，危险） |
| `ROVEAGENT_APPROVAL_SECRET` | 签名端点必需 | `app.py:253` HMAC 密钥 | 回落用 API_KEY（`:253`），签名仍可工作 |
| `ROVEAGENT_LLM_API_KEY` | **必需（业务）** | `app.py:112` | `/api/agent/chat` → 503 |
| `ROVEAGENT_LLM_BASE_URL` | 可选 | `app.py:120` | 走默认 OpenAI |
| `ROVEAGENT_LLM_MODEL` | 可选 | `app.py:122` | 默认 `gpt-4o-mini` |

### 2.3 探针实测结果

```
[ OK ] import roveagent
[ OK ] get_app(): FastAPI
[ OK ] ServiceContext boot: kernel=RoveAgentKernel gate=EnterpriseToolGate
[ OK ] workforce registry: 5 个 agent 全部在线，tools/forbidden 可读
[ OK ] get_available_toolsets
[FAIL] media providers      ← 探针写错了导入路径（见 §2.5）
[FAIL] sandbox backends     ← 探针写错了模块路径（见 §2.5）
5/7 steps passed
```

**16 个端点全部在线**，与 TS 客户端 `client.ts` 的调用一一对应：

```
GET    /api/health                       ← client.ts 未使用（建议接入）
POST   /api/agent/chat                   ← roveAgentChat
POST   /api/agent/task                   ← roveAgentCreateTask
POST   /api/agent/execute                ← roveAgentExecuteTask（signed）
GET    /api/agent/status/{task_id}       ← roveAgentTaskStatus
POST   /api/agent/tool/resolve           ← roveAgentResolveTool（signed）
GET    /api/agent/memory                 ← roveAgentMemory
GET    /api/agent/skills/market          ← roveAgentSkillMarket
POST   /api/agent/skills/install         ← roveAgentInstallSkill
POST   /api/agent/skill/create           ← roveAgentCreateSkill
GET    /api/agent/sessions               ← 未接
DELETE /api/agent/sessions/{session_id}  ← 未接
GET    /docs /redoc /openapi.json /docs/oauth2-redirect
```

### 2.4 三大认证面（已核实）

| 面 | 位置 | 机制 |
|---|---|---|
| 普通调用 | `app.py:233-237` | `X-RoveAgent-Key` 常量时间比较 |
| 签名调用 | `app.py:246-267` | HMAC-SHA256 over `timestamp.body`，±300s 窗口。用于 `/execute` 与 `/tool/resolve` |
| 工具门控 | `enterprise/gate_hook.py` | 中间件 `tool_execution`，`fail_closed = True`（`:168`） |

签名调用只有 TS 侧 `signRoveAgentPayload()` 能发起——普通前端无法伪造审批。**这个设计是安全的，应保留。**

### 2.5 对我上一份报告的更正（重要）

**更正 1**：`roveagent/sandbox/` **不存在**。沙箱实现实际在：

```
roveagent/tools/environments/{local,docker,daytona,modal,managed_modal,singularity,ssh,vercel_sandbox}.py
```

**更正 2**：媒体注册表不在 `plugins/{image,video}_gen/`，而在：

```
roveagent/core/image_gen_provider.py    roveagent/core/image_gen_registry.py
roveagent/core/video_gen_provider.py    roveagent/core/video_gen_registry.py
```

`plugins/{image,video}_gen/` 是**provider 实现目录**（按厂商分子目录），不是注册表。这两处更正直接影响第六、七阶段的落点，特此留痕。上一份报告的对应表述作废。

---

## 3. 阶段二的关键发现：权限系统已完成 80%

这是本次诊断**最有价值的发现**。

### 3.1 `EnterpriseToolGate` 已实现完整治理链

`roveagent/tools/framework.py`：

```
RiskLevel       LOW / MEDIUM / HIGH / CRITICAL                       (:32)
ApprovalPolicy  NONE / MANAGER / OWNER / ADMIN                       (:39)
ToolPolicy      pattern, permission, risk, approval, audit, schema   (:47)
authorize()     Schema → Context → Permission → Risk → Approval → Audit  (:210)
```

实测已装配：`ServiceContext boot: gate=EnterpriseToolGate`。

### 3.2 现有策略表（`DEFAULT_POLICIES`，`:85-115`）

```python
# 已受控
ToolPolicy("read_*",   "analytics:read", LOW,  NONE)              # :112
ToolPolicy("*_sales",  "analytics:read", LOW,  NONE)              # :113
ToolPolicy("write_file","files:write",   MEDIUM, MANAGER)         # :109  ★
ToolPolicy("patch",     "files:write",   MEDIUM, MANAGER)         # :110  ★
ToolPolicy("deploy_*",  "admin:deploy",  CRITICAL, ADMIN)         # :100
ToolPolicy("process_kill","admin:process",HIGH, ADMIN)            # :101
ToolPolicy("send_*",    "comms:send",    HIGH, MANAGER)           # :106
ToolPolicy("refund_*",  "payments:refund",HIGH, OWNER)            # :96
ToolPolicy("*",         "",              LOW,  NONE)              # :115  ← 兜底
```

**关键结论 1**：`write_file` 与 `patch` **已经在受控范围内**（MEDIUM + MANAGER 审批）。
你要的「修改代码 → 生成 diff → 审批 → 写入」**所需的策略行已存在**。

**关键结论 2**：但 `terminal` / `process` / `ssh` / `docker` / `git` **没有专门策略行**，会命中兜底 `ToolPolicy("*", "", LOW, NONE)` —— 即**无审批直执**（前提是工具已注册，见 §3.3）。

**关键结论 3**：`ToolPolicy.permission` 是**按工具名硬编码**的，注册表里**没有** `required_permission` 字段（`grep permission` 在 `tools/registry.py` 零命中）。所以「给 terminal 加权限点」只能通过**新增策略行**实现。

### 3.3 fail-closed 的精确边界（`:221-241`）

```python
if self._is_fallback(policy) and not self._tool_is_registered(tool_name):
    # 未登记工具 + 兜底策略 → 一律拒绝
```

**已注册** 但命中兜底策略的工具 → **放行且不审批**。这是第六阶段「所有危险操作必须审批」需要补的缺口。

### 3.4 ★ 真正缺失的那一层：Agent → Toolset

`app.py:332-337`：

```python
reply = ctx.agent_chat(
    system, user,
    toolsets=("safe", "memory", "business"),   # ← 与 req.agent 无关
    history=history,
)
```

而 `ChatRequest`（`app.py:170-181`）**根本没有 toolsets 字段**。

同时 `workforce/employees.py` 里每个 Agent 都**声明了**它该有的工具：

```python
ceo        tools=['read_*','*_sales','memory','session_search']  forbidden=[]
operations tools=['read_*','*_sales','inventory_*','todo','memory'] forbidden=['refund_payment','change_pricing']
marketing  tools=['read_*','customers_*','memory']               forbidden=['send_*']
developer  tools=['read_*','search_files','todo']                forbidden=['deploy_*','write_file']   ★
devops     tools=['read_*','process','terminal']                 forbidden=['deploy_*']
```

**这些声明从未被使用。** `app.py:295-298` 只用了 `persona_for()` 改**提示词文案**：

```python
persona = persona_for(req.agent)
display_name = str(persona["name"]) if persona else emp.name
mission      = str(persona["mission"]) if persona else emp.mission
```

→ **这正是你说的「不要通过 prompt 模拟能力」在代码里的确切位置。**

**修复形态（第二阶段核心，单一改动点）**：

```
employees.py 的 tools/forbidden  (已在，权威)
        ↓ 新增映射层
agent → toolsets  (需新增，约 1 个函数 + 1 张表)
        ↓ 经 ChatRequest 传递（需新增字段）
ctx.agent_chat(toolsets=<推导值>, max_iterations=<按 agent>)
```

### 3.5 `PermissionEngine` 与 `EnterpriseToolGate` 是两个独立系统（易踩坑）

| | `permissions/engine.py` | `tools/framework.py` |
|---|---|---|
| 分级 | `auto` / `approval` / `forbidden` | `LOW/MEDIUM/HIGH/CRITICAL` × `NONE/MANAGER/OWNER/ADMIN` |
| 判据 | **动作名**（`apply_patch`, `deploy_production`…） | **工具名 glob** + 权限点 |
| 状态 | 进程内 dict（**不持久化**） | 审计落盘 `audit/tool_gate.jsonl` |
| 装配 | 未在 `app.py` 中实例化 | **已装配**（`gate=EnterpriseToolGate`） |

`PermissionEngine.APPROVAL_ACTIONS`（`:28-31`）恰好包含 `apply_patch` 与 `deploy_production`——与你要的语义一致，但它**当前没有被接进工具执行链**。

**建议**：以 `EnterpriseToolGate` 为唯一权威（它已 fail-closed 且落审计），把 `PermissionEngine` 的动作语义**合并为策略行**，避免两套审批语义漂移。

---

## 4. 各能力现状实测（决定后 9 个阶段的可行性）

### 4.1 Toolset 可用性（探针实测）

```
safe=NO   coding=NO   file=yes   terminal=yes   business=yes
image_gen=NO   video_gen=yes   web=yes   search=NO
```

**这组结果是理解全局的钥匙**：可用性由每个工具的 `check_fn` 探测（TTL 缓存 30s，`registry.py:1047-1068`），**依赖缺失凭据的工具会被从 schema 中过滤掉**。

探针同时捕获了具体的不可用原因：

```
check_fn check_video_generation_requirements returned False
check_fn _check_xai_video_requirements returned False
check_fn check_tts_requirements returned False
check_fn check_vision_requirements returned False
check_fn check_web_api_key raised                                  ← 注意是 raised
check_fn check_x_search_requirements returned False
check_fn _check_spotify_available returned False
check_fn check_cronjob_requirements returned False
check_fn _check_kanban_mode returned False
check_fn check_browser_*_requirements returned False   (11 个浏览器工具)
check_fn check_computer_use_requirements returned False
check_fn check_discord_tool_requirements returned False
check_fn _check_feishu returned False  (×2)
check_fn _check_ha_available returned False
check_fn _check_yuanbao returned False
```

**重要推论**：`safe` 与 `coding` 之所以 `NO`，是因为它们 `includes`/包含 `web` 与 `vision` 等**组合 toolset**，只要子项任一不可用，整个组合就被判不可用。这意味着：

> **第三阶段（Developer Agent 真执行）当前会被这层可用性门控挡住**——不是因为代码没有 `write_file`，而是因为组合 toolset 的可用性判定过严。

`file` 与 `terminal` 单独是 `yes`，所以**按需给 `developer` 直接授予 `("file","terminal","todo")` 比授予 `("coding",)` 更可靠**。这是对阶段三的一个具体设计建议。

### 4.2 Plugin 系统（第五阶段）

真实可用，非死代码：

```
roveagent/plugins/{browser,context_engine,cron_providers,dashboard_auth,disk-cleanup,
  google_meet,image_gen,kanban,memory,model-providers,observability,platforms,
  roveagent-achievements,security-guidance,spotify,teams_pipeline,video_gen,web}

roveagent/plugins/plugin_storage.py   每插件独立数据根 <home>/plugin-data/<name>/
roveagent/plugins/plugin_utils.py
roveagent/clisupport/agent_plugins.py  agent-plugins.org v1 导入器 + mcp.json 校验
```

对比：TS 侧 `src/lib/plugins/` 仍是死代码（全仓 0 引用）。**结论不变：Plugin Center 必须读 Python 侧。**

### 4.3 沙箱（第六阶段）★ 有重要限制

实现存在（`tools/environments/`，8 个后端文件），但**需要核实它是否覆盖插件加载路径**。

`tools/environments/` 的语义是「**Agent 的 terminal / code execution 在哪个环境里跑**」，不是「插件在哪个进程里跑」。当前 `install_enterprise_gate()` 是把中间件 append 进**主进程内**的 `get_plugin_manager()._middleware`（`gate_hook.py:183-188`）——**插件与门控同进程**。

→ 你要的「插件绝不能直接运行在主进程」**当前架构不满足**，需要新建一层：
**插件加载器 → 沙箱进程 → tool gateway → 主进程**。

这是第六阶段的主要工作量，不能靠配置解决。可复用 `tools/environments/docker.py` 作为执行后端，但**需要一个跨进程的工具调用协议**。

### 4.4 Media（第七阶段）

| 能力 | provider 目录 | 实测可用 | 缺口 |
|---|---|---|---|
| 图像 | `plugins/image_gen/{deepinfra,fal,krea,openai,openai-codex,openrouter,xai}` | `image_gen=NO` | 无凭据 |
| 视频 | `plugins/video_gen/{deepinfra,fal,xai}` | `video_gen=yes`* | 无凭据 / `video_generate` check_fn False |
| 音频(TTS) | `tools/tts_tool.py` | `check_tts_requirements=False` | 无凭据 |

\* `video_gen=yes` 但 `check_video_generation_requirements=False` —— 说明该 toolset 的判定与 `video_generate` 工具的 `check_fn` **不同步**，存在不一致。这是一个**待修的缺陷**，值得在阶段七一并处理。

你要的 `flux` 与 `Veo` 不在 provider 列表中（`fal` 通常可代理二者）；`generate_audio()` 的「Music provider」不存在，需新增。

### 4.5 Search（第八阶段）

8 个后端已实现，`web=yes`：

```
plugins/web/{brave_free,ddgs,exa,firecrawl,keenable,parallel,searxng,xai}
plugins/web/keyless_mcp.py   免密钥走 https://mcp.exa.ai/mcp 与 https://search.parallel.ai/mcp，带 failover
```

`search=NO` + `check_web_api_key raised` —— 注意是 **raised**（异常）不是 `returned False`，说明某个 provider 的键校验路径有 bug，值得优先排查（成本极低，收益明确）。

### 4.6 Social（第九阶段）★ 与你的清单有实质差距

```
roveagent/plugins/platforms/ (22 个，实测)：
telegram discord slack teams whatsapp wecom weixin feishu dingtalk line
matrix mattermost irc sms email ntfy simplex photon google_chat
homeassistant a2a buzz raft
```

你的目标清单：**LinkedIn / TikTok / YouTube / Bilibili / 微信公众号 / 小红书**

| 目标 | 现状 |
|---|---|
| 微信公众号 | **有基础**（`weixin.py` + `wecom.py`，可选依赖 `aiohttp`/`qrcode`/`cryptography`） |
| LinkedIn | **无** |
| TikTok | **无** |
| YouTube | **无** |
| Bilibili | **无** |
| 小红书 | **无** |

→ 第九阶段 **5/6 是新增**，不是接线。工作量被显著低估。且这些平台的发布 API 普遍需要：
应用审核、OAuth 授权、企业资质、部分需要付费额度。**建议先做 1 个跑通闭环**（推荐微信公众号，因已有基础），验证「趋势→生成→审批→发布→分析」全链路，再扩平台。

### 4.7 Document（第十阶段）

`src/lib/artifacts/` 已实现且**零依赖**（自身手写 OOXML/PDF）：

```
doc-writers.ts  pdf-writer.ts(1786行，含字体子集化)  pptx-writer.ts  markdown-doc.ts  deliverable.ts
```

DOCX / PPTX / XLSX / HTML / MD / CSV **已可用**。唯一失败项是**中文 PDF**：

```
public/fonts/  只有 README.md，0 个字体文件
pdf-writer.ts:861  discoverPdfFont()  顺序：explicitPath → RF_PDF_FONT → <cwd>/public/fonts
                                        → Linux 字体目录 → Windows 字体目录
deliverable.ts:236  if (!font && needsUnicodeFont(text)) → pdf_font_unavailable
```

**这是整份报告里性价比最高的一处修复**：放一份 OFL 许可的 Noto Sans CJK 进 `public/fonts/`，中文 PDF 立即全线打通。

需附带核实：`loadFont()` 是否支持 `.ttc` 集合字体（影响 Windows `msyh.ttc` 兜底路径）。

---

## 5. 性能问题定位（第十一阶段）

### 5.1 迭代预算

```ts
packages/roveagent-core/src/runtime/agent-loop.ts:26-27
const iterations = new IterationBudget(options.maxIterations ?? 4);
const tools      = new IterationBudget(options.maxToolCalls ?? 4);
```

Python 侧：`app.py:101` 默认 `max_iterations: int = 8`，但 `chat()` 调用时**未传**（`app.py:332-337`）。

→ 两个运行时都用了偏低的预算，且**都不按 Agent 区分**。你要的「简单聊天 4 / 开发 16 / 复杂 32」需要把预算做成与 §3.4 同一条映射链的产物。

### 5.2 串行前置 I/O

`chat/route.ts:380-425` 在进入模型前的 `await` 序列：

```
1. chat_messages 读旧消息（触发摘要时）
2. chat_sessions 写 summary
3. chat_messages 读最近历史
4. chat_messages 写用户消息
5. getBusinessContext()      ← 可并行
6. getSettings()             ← 可并行
7. getRecentMemories(5)      ← 可并行
8. buildAttachmentContext()
```

5/6/7 相互独立却串行，且**每轮都重算**，无缓存。

### 5.3 假流式（体感慢的最大来源）

`chat/route.ts:449-469`：

```ts
const result = await roveAgentChat({...});   // 非流式，等整段
const reply = result.reply;
stream = (async function* () { yield reply; })();   // 包成假流
```

内核侧 `agent_chat()` 签名返回 `str`（`app.py:103`），**整条链路无流式**。用户必然等满全程，且期间前端只能显示 "AI 思考中…"。

内核已有流式基础设施可复用：`gateway/stream_events.py`、`gateway/stream_dispatch.py`、`gateway/stream_consumer.py`——但**未暴露在 `api_server` 的 `/api/agent/chat` 上**。

---

## 6. 阶段一的前置设计问题（必须先定，否则返工）

### 6.1 模型配置的单一事实源在哪里？

| 侧 | 位置 | 形态 |
|---|---|---|
| TS | Supabase `model_configs` 表 | 加密凭据 + `model_assign` 分流 |
| Python | 进程环境变量 `ROVEAGENT_LLM_*` | 明文 env |

内核启动时读 env；用户在设置页改配置时改库。**两者不会自动同步**。

三个选项：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | 内核启动时由 TS 拉取 `model_assign`，通过 `ROVEAGENT_LLM_*` 注入子进程 | 复用现有设置页与加密存储，零重复 | 改配置需重启内核进程（可接受） |
| B | 新增内核端点接收模型配置并热更 | 免重启 | 需新增鉴权面，扩大到内核的攻击面 |
| C | 内核自己读 Supabase | 无中间层 | Python 侧需引入 Supabase 客户端与解密逻辑，凭据泄露面翻倍 |

**建议 A**，并在 `scripts/roveagent-service.sh` 上包一层读取器。

### 6.2 「禁止静默 fallback」的确切语义

你要求「Runtime 不可用必须前端显示明确错误」。这里有一个**需要你决策**的取舍：

| 选项 | 行为 | 风险 |
|---|---|---|
| **硬失败** | 内核不可用 → 请求直接失败，前端红色错误 | 内核挂掉 = **整个产品不可用**，包括纯聊天 |
| **显式降级（推荐）** | 走 TS 路径，但**前端明确标注**「当前为降级模式，文件/终端/媒体能力不可用」+ 上报 | 需前端配合；但产品不至于全挂 |
| 分级 | 只读问答允许降级；需要工具的请求硬失败 | 最精确，实现成本略高 |

我推荐 **显式降级** 或 **分级**。理由：`/api/health` 刚启动有冷启动窗口；把这窗口变成全站不可用是过度反应。但**当前的静默**必须立刻消除——这是所有「假响应」投诉的放大器。

请你在推进阶段一之前明确选一个。

### 6.3 流式改造的范围

阶段一要求「恢复主链路」，但 §5.3 表明**光连上不会变快**。建议把流式纳入阶段一，否则阶段十一要重做一遍链路。

最小代价路径：内核侧把 `chat()` 改为返回 `AsyncIterator`，`api_server` 增加 `GET /api/agent/chat/stream`（或 `Accept: text/event-stream` 分支），TS 侧 `roveAgentChat` 增加流式变体。**保留现有非流式端点**作为兼容路径，避免破坏审批回放与任务执行。

---

## 7. 需要你决策的问题（阻塞后续设计）

| # | 问题 | 影响阶段 | 我的建议 |
|---|---|---|---|
| D1 | 内核用哪个模型？凭据从哪来（方案 A/B/C）？ | 一 | 方案 A |
| D2 | Runtime 不可用时：硬失败 / 显式降级 / 分级？ | 一 | 显式降级或分级 |
| D3 | 流式是否并入阶段一？ | 一、十一 | **是** |
| D4 | Developer Agent 的 `forbidden=["write_file"]` 是否解除？ | 二、三 | 解除，改为「写必审批」（策略行已存在） |
| D5 | 写文件审批级别：MANAGER 还是 ADMIN？ | 二 | 代码改动用 MANAGER，生产部署用 ADMIN |
| D6 | 第六阶段的跨进程沙箱协议：自建 stdio JSON-RPC，还是复用 MCP？ | 六 | **复用 MCP**（内核已有客户端，且天然是隔离边界） |
| D7 | 第九阶段先做哪个平台？ | 九 | 微信公众号（已有基础），跑通闭环再扩 |
| D8 | `terminal`/`process` 是否补策略行（当前无审批直执）？ | 二、四 | **是，必须补**，属安全缺口 |
| D9 | 是否允许内核在启动时发起 aux 上游调用？ | 一 | 否，用 `auxiliary.free_only: true` 或禁用 |
| D10 | 线上部署（Linux）是否也缺 `ROVEAGENT_*`？ | 一 | 需你确认，本机无 `.env` 无法判断 |

---

## 8. 建议的执行顺序（对原 11 阶段的一处调整）

原顺序把「性能优化」放在最后。基于 §5.3，我建议**把流式上移到阶段一**：

```
阶段 0  配置与可观测（阻塞项）
        ├─ 补 ROVEAGENT_* 到 .env + scripts/deploy.env
        ├─ 模型配置注入（D1）
        ├─ 禁用/隔离 aux 上游调用（D9）
        ├─ 探测 docker / python 可用性
        └─ 把静默降级改成显式提示（D2）      ← 先做这个，投诉立刻减少

阶段 1  Runtime 接管 + 真流式              （原阶段一 + 阶段十一的流式部分）
阶段 2  Agent→Permission→Toolset            （核心，改动集中）
        └─ 同时补 terminal/process 策略行（D8）
阶段 3  Developer Agent 真执行              （依赖阶段 2）
阶段 4  DevOps Agent                        （ssh/docker 为新增）
阶段 5  Plugin Center                       （纯接线，低风险）
阶段 6  插件沙箱跨进程隔离                   （工作量最大，建议用 MCP 协议）
阶段 7  Media Hub                           （图像先通，视频次之，音乐需新增）
阶段 8  Search                              （低成本高收益，可提前）
阶段 10 Document（中文 PDF 字体）            （一行配置，可提前到阶段 0）
阶段 9  Social                              （5/6 是新增，最后做）
阶段 11 其余性能项（并行、缓存、预算）        （流式已上移）
```

**可以立即插入而不依赖任何决策的低风险项**（建议阶段 0 一并做）：

1. 中文 PDF 字体投放到 `public/fonts/`（阶段十，一行）
2. 排查 `check_web_api_key raised` 的异常（阶段八的前置 bug）
3. 修复 `video_gen` toolset 判定与 `video_generate` check_fn 不一致（阶段七的前置 bug）

---

## 9. 风险登记

| 风险 | 说明 | 缓解 |
|---|---|---|
| **门控缺口** | `terminal`/`process` 命中兜底策略 → 无审批直执 | 阶段 2 必补策略行（D8），**在开 toolset 之前** |
| **进程内插件** | 插件与主进程同进程，崩溃可拖垮内核 | 阶段 6 前不得加载第三方插件 |
| **审批语义双轨** | `PermissionEngine` 与 `EnterpriseToolGate` 并存且不联通 | 以 gate 为唯一权威，合并动作语义 |
| **aux 隐式计费** | 启动路径存在真实上游调用 | 阶段 0 隔离（D9） |
| **凭据重复** | ts 加密存库 vs python 明文 env | 方案 A 单向注入，不双向同步 |
| **平台 API 资质** | 社交平台发布普遍需审核/付费 | 阶段 9 先验证 1 个平台的可行性再投入 |
| **不可逆操作** | `terminal` 一旦开放，可执行任意命令 | 沙箱（阶段 6）+ 审批（阶段 2）**双闸**，缺一不可 |
| **组合 toolset 过严** | `safe`/`coding` 因任一子项不可用而整体禁用 | 阶段 3 按需授予原子 toolset（`file`+`terminal`） |

---

## 10. Confidence & gaps

### 已取证（可复现，均含文件行号或探针输出）

- 内核自举成功：16 端点、`ServiceContext`、`EnterpriseToolGate` 装配 —— 探针实测
- `ChatRequest` 无 toolsets 字段；`chat()` 硬编码 `("safe","memory","business")` —— `app.py:170-181, 332-337`
- 5 个 Agent 的 `tools`/`forbidden` 声明从未被消费 —— `employees.py` + `app.py:295-298`
- `write_file`/`patch` 已在受控策略内（MEDIUM+MANAGER）—— `framework.py:109-110`
- `terminal`/`process` **无专门策略行**，落兜底 `("*","",LOW,NONE)` —— `framework.py:85-115`
- fail-closed 边界：仅「未注册 + 兜底」拒绝 —— `framework.py:221-241`
- toolset 可用性实测 9 项 —— 探针输出
- 22 个平台、7 图像 provider、3 视频 provider、8 搜索后端 —— 目录实测
- 非流式链路 —— `client.ts:101-119` + `chat/route.ts:449-469` + `app.py:103`
- 迭代预算 4/4 与 8 —— `agent-loop.ts:26-27` + `app.py:101`
- 串行 8 个 await —— `chat/route.ts:380-425`
- 中文 PDF 失败链 —— `pdf-writer.ts:861` + `deliverable.ts:236` + `public/fonts/` 空
- LLM 未配置 → 503 —— 探针输出 + `app.py:113-116, 338-339`
- aux 真实上游调用与计费告警 —— 探针输出

### 未取证 / 需你确认

1. **线上实例是否配了 `ROVEAGENT_*`** —— 本机无 `.env`，只有 `.env.example` 模板（D10）
2. **`agnes` 服务商在 `PROVIDER_CATALOG` 中的 `runtime` 值** —— 决定 TS 侧图像能否走通
3. **`model_configs` 中实际行状态**（`is_enabled` / `api_key_encrypted`）—— 无库访问
4. **真实延迟分位** —— 需读 `ai_usage_ledger`；「很慢」目前是**设计推理**，非实测数字
5. **`loadFont()` 是否支持 `.ttc`** —— 影响 Windows 字体兜底
6. **`tools/environments/docker.py` 的实际隔离强度**（是否限制网络/挂载/资源）—— 未读实现细节
7. **`check_web_api_key raised` 的具体异常** —— 未定位，但属低成本高收益项
8. **`video_gen` toolset 判定与 `video_generate` check_fn 不一致的原因** —— 未定位
9. **「音乐生成」的确切期望**（配音 vs 配乐）—— 决定复用 TTS 还是新增 provider
10. **`roveagent/README.md` 称 23 平台 vs 目录实测 22** —— 哪边为准未核对

### 外部来源

本报告未引用任何外部 URL。全部结论来自本仓源码、目录实测与本地探针脚本
`scripts/_probe_roveagent_boot.py`（只读，可重跑）。

---

## 11. 下一步

按你的要求，诊断到此为止，**未做任何代码修改**。

请先答复 §7 的 **D1、D2、D3、D4、D8** 五项（这五项会改变后续实现形态），
我即可开始阶段 0 与阶段 1 的落地，并按你要求逐阶段交付：
**文件路径 → 修改原因 → 代码 diff → 测试方式 → 实际测试结果**。
