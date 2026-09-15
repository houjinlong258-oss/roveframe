# 能力审计与升级计划 — 2026-09-12

审计范围：`roveframe-src-latest` 全仓（TS/Next.js 应用面 + `roveagent/` Python 内核）。
审计方式：只读代码取证 + 本机服务探测。所有结论都给出文件行号，未取证项标注 `unverified`。

---

## 0. 一句话结论

**绝大多数「缺失能力」并不缺失，而是断线的。**

仓库里同时存在两套完整实现：

| 层 | 位置 | 规模 | 当前状态 |
|---|---|---|---|
| TS 应用层 | `src/` | 319 文件 / 2.1 MB | **在跑** |
| Python 内核 | `roveagent/` | 1586 文件 | **没在跑** |

`roveagent/` 是一个功能远比 TS 层完备的 Agent 运行时（含文件读写、终端、图像、视频、TTS、
22 个渠道、8 个搜索后端、6 种沙箱后端、MCP 客户端、345 个技能）。但它在**本机根本没启动**，
于是一切请求都被静默降级到一个能力极弱的 TS 兜底循环上。

---

## 1. 「生成不了图片/音乐/视频」的真因

### 1.1 图像：代码在，配置链断了

TS 侧确实实现了出图，且接进了 Agent 交付管线：

- `src/lib/ai/image-generation.ts:91` — `generateImage()` 走 OpenAI 兼容 `/images/generations`
- `src/lib/agent/deliver.ts:149-204` — 用户说「海报/配图」时触发 `png` 交付
- `src/lib/artifacts/deliverable.ts:68,150` — `IMAGE_INTENT` 正则识别出图意图

失败发生在候选模型挑选：

```
src/lib/ai/image-generation.ts:44-48
for (const provider of registry.providers) {
  const imageModels = provider.models.filter((m) => m.capability === 'image');
  if (imageModels.length === 0) continue;
  if (!provider.configured) continue;        // ← 断点
```

`pickerImageCandidate` 要求该服务商 `configured === true`。而按
`src/lib/ai/model-registry.ts:352`：

```ts
const configured = Boolean(stored?.is_enabled) && (hasKey || entry.authType === 'local') && routable;
```

`screenshot #3`（模型下拉）显示：用户的服务商确实探测到了 `agnes-image-2.0-flash`、
`agnes-video-2.5-flash` 等模型，但全部被归入「不可用于对话」分组。这说明
`classifyModelCapability()`（`model-registry.ts:53-60`）**正确定性出了图像/视频能力**——
问题不在识别，而在这些图像模型能否让服务商整体 `configured` 成立。

用户侧的可见症状因此是 `deliver.ts:158-164` 这条 notice：

> 「还没有接入可出图的模型，所以本次只给了设计方案」

即模型回答「无法生成图片」的观感，实际是运行时如实报告了配置缺口。

**关键推断**：用户的图像/视频模型来自一个叫 `agnes` 的服务商（截图 #3 模型名前缀）。
`PROVIDER_CATALOG` 里是否有 `agnes` 条目 **需在设置页确认**（`unverified`——本机无 `.env`，
无法查库）。若 `agnes` 不在 catalog 中、而是走了「自定义 OpenAI 兼容」条目，
则 `entry.runtime` 可能被判为 `declared`，`routable` 为 false → `configured` 恒 false
→ 出图永远不可达。

### 1.2 视频 / 音乐：TS 侧真的没有

- 全仓 `src/` 内搜索 `generateVideo|generateMusic|generateAudio` → **0 命中**
- `src/lib/` 下不存在任何 video/music/audio 模块（`src/lib/ai/` 只有 `image-generation.ts`）
- Python 侧**有**：`roveagent/tools/video_generation_tool.py`、`image_generation_tool.py`、
  `tts_tool.py`（TTS = 音乐/语音那一类）

Python 侧的媒体供应商是**插件式**、默认不启用：

| 能力 | 可用 provider 插件 | 位置 |
|---|---|---|
| 图像 | fal / openai / openai-codex / xai / deepinfra / krea / openrouter | `roveagent/plugins/image_gen/` |
| 视频 | fal / xai / deepinfra | `roveagent/plugins/video_gen/` |
| 语音 | `tts_tool.py` | Edge TTS(免费) / ElevenLabs / OpenAI / xAI |

toolset 定义（`roveagent/toolsets.py`）：

```
"image_gen": { "tools": ["image_generate"] }                      # 行 142
"video_gen": { "tools": ["video_generate", "xai_video_edit", "xai_video_extend"] }  # 行 148
"safe":      { "includes": ["web", "vision", "image_gen"] }        # 行 386
```

注意 **`safe` 不含 `video_gen`**。而 API 的聊天处理器硬编码只用
`("safe", "memory", "business")`（见 §2），所以即使把服务启起来，
图像可用、**视频仍不可用**。

### 1.3 音乐

「音乐」在两侧都没有专门实现。最接近的是 TTS（语音合成）与
`src/lib/artifacts` 下的音频容器工具（`roveagent/tools/audio_container.py`）。
若需真实音乐生成（Suno/Udio 类），属于**新增能力**，不是修复。

---

## 2. 「开发 Agent / 运维 Agent 只能假响应」的真因 ★ 最高优先级

这是本次审计最确凿的一条，有三个独立原因**叠加**。

### 原因 A：Python 内核没启动，请求被静默降级

`src/app/api/agent/chat/route.ts:449-476`：

```ts
if (roveAgentConfigured()) {
  try { ... usedRoveAgent = true; ... }
  catch (error) {
    if (error instanceof RoveAgentUnavailable) {
      console.warn('[agent/chat] roveagent unavailable, fallback to TS agent path:', error.message);
    }
  }
}
```

`roveAgentConfigured()`（`src/lib/roveagent/client.ts:28`）要求
`ROVEAGENT_API_URL` 或 `ROVEAGENT_API_KEY` 存在。

本机取证：

| 检查项 | 结果 |
|---|---|
| `<repo>/.env` | **不存在** |
| `<repo>/scripts/deploy.env` 中的 `ROVEAGENT_*` | **无任何一行** |
| `.env.example` 中的 `ROVEAGENT_*` | 存在（模板） |
| `http://127.0.0.1:8788/api/health` | **连接被拒绝**（服务未跑） |
| 监听端口 8788 | **无** |

→ `roveAgentConfigured() === false` → **每次请求都走 TS 兜底路径**，只在 console 留一行 warn，
前端完全无感。这就是「假响应」的第一层。

### 原因 B：TS 兜底路径的工具集里**没有任何文件工具**

`src/lib/agent/tools/index.ts:7-12` 注册的全部工具：

| 工具 | 风险 | 实际动作 |
|---|---|---|
| `analytics.get_sales_summary` | read | 查销量 |
| `reviews.get_negative_trend` | read | 查差评 |
| `customers.get_risk_summary` | read | 查流失 |
| `inventory.get_low_stock` | read | 查库存 |
| `purchase.create_draft` | write | 建**审批单** |
| `marketing.create_draft_campaign` | write | 建**审批单** |
| `reviews.draft_reply` | write | 建**审批单** |
| `analytics_tool` / `reviews_tool` / `customer_tool` / `inventory_tool` | read | 与上重复 |
| `marketing_tool` | write | 建**审批单** |
| `report_tool` | read | 拼快照 |
| `notification_tool` | write | 入队通知 |

**没有 `read_file` / `write_file` / `patch` / `search_files` / `terminal`。**
所有 `write` 类工具的真实效果都是 `createPendingApproval()`——写一条待审记录。
所以「开发 Agent 说它改了代码」而文件毫无变化，是**结构必然**，不是模型偷懒。

### 原因 C：即使内核启动，工具集仍然被硬编码屏蔽

`roveagent/api/app.py:332-337`（`/api/agent/chat` 处理器）：

```python
reply = ctx.agent_chat(
    system, user,
    toolsets=("safe", "memory", "business"),   # ← 与 req.agent 无关
    history=history,
)
```

对比 `roveagent/employees.py` 里两个 Agent 的**声明**：

```python
AIEmployee(key="developer", role="系统改进",
           permissions=["files:read", "analytics:read"],
           tools=["read_*", "search_files", "todo"],
           forbidden=["deploy_*", "write_file"],   # ← 显式禁止写文件
           ...)

AIEmployee(key="devops", role="基础设施与自愈",
           permissions=["admin:process"],
           tools=["read_*", "process", "terminal"],
           forbidden=["deploy_*"],
           ...)
```

三重脱节：

1. `emp.tools` / `emp.forbidden` / `emp.permissions` **从未传入** `agent_chat()`。
   处理器只在 system prompt 里用 `persona_for()` 改**文案**（`app.py:295-298`）。
2. Developer Agent 的档案**主动**把 `write_file` 列入 `forbidden`，只有 `files:read`。
   也就是说「开发 Agent 不能改文件」是**当初的设计决定**，不是 bug。
3. DevOps 声明了 `terminal`/`process`，但 `safe` 不含 `terminal`，声明被丢弃。

另外 `roveagent/workforce/personas.py:44-48` 里 CTO persona 的 mission 原文写着
「**暂不承担产品研发职责**」——运维 Agent 也被定性排除在写代码之外。

### 可用的工具集（修好之后能开什么）

`roveagent/toolsets.py` 已经准备好了正确的工具集，只是没人调用：

```
"file":     ["read_file", "write_file", "patch", "search_files"]        # 行 201
"terminal": ["terminal", "process"]                                    # 行 170
"coding":   [ web_search, web_extract, terminal, process,
              read_file, write_file, patch, search_files, vision_analyze,
              skills_*, browser_*, todo, memory, session_search,
              clarify, execute_code, delegate_task ]                   # 行 401
```

**`"coding"` 就是开发/运维 Agent 该用的工具集**，且它标了 `"posture": True`——
注释明确写着「per-session 由 `agent/coding_context.py` 选择，绝不自动恢复」。

---

## 3. 「PDF 生成不了」的真因

PDF 写入器是零依赖手写的（`src/lib/artifacts/pdf-writer.ts`，1786 行，含字体子集化），
逻辑本身完好。卡点是**字体**：

```
pdf-writer.ts:861  discoverPdfFont()
  候选顺序：explicitPath → env RF_PDF_FONT → <cwd>/public/fonts → Linux 字体目录 → Windows 字体目录
```

两处事实：

1. `<repo>/public/fonts/` **存在但只有一个 `README.md`**，`0` 个 `.ttf/.otf/.ttc`。
2. 全仓 `public/` + `assets/` + `src/` 内 **0 个字体文件**。

而 `deliverable.ts:236-245` 的降级判断：

```ts
if (!font && needsUnicodeFont(plainText)) {
  return { ok: false, reason: 'pdf_font_unavailable', ... };
}
```

`needsUnicodeFont()`（`pdf-writer.ts:283`）对任何 CJK 字符返回 true。
→ **所有中文 PDF 请求都返回 `pdf_font_unavailable`**，用户看到的就是
`deliver.ts:70-82` 那条「PDF 需要中文字体…已改用 Word / 网页版交付」。

英文内容理论上可以走 `windowsFontCandidates()` 的 `arial.ttf` 兜底
（`pdf-writer.ts:830-833`），但中文必然失败。

**注意**：生产部署在 Linux 上，`public/fonts/` 同样为空，所以线上同样失败——
不是本机问题。

---

## 4. 「处理任务很慢」的真因

TS 兜底路径的 Agent 循环在 `packages/roveagent-core/src/runtime/agent-loop.ts`：

```ts
const iterations = new IterationBudget(options.maxIterations ?? 4);
const tools      = new IterationBudget(options.maxToolCalls ?? 4);
```

默认 **最多 4 轮迭代 / 4 次工具调用**。这既造成「任务做不完」，也让长任务显得卡顿
（反复重试、不能完成）。

每轮请求在进入模型前的串行 I/O（`src/app/api/agent/chat/route.ts:380-425`）：

1. `chat_messages` 读旧消息（触发摘要时）
2. `chat_sessions` 写 summary
3. `chat_messages` 读最近历史
4. `chat_messages` 写用户消息
5. `getBusinessContext()` — 经营快照
6. `getSettings()`
7. `getRecentMemories(5)`
8. `buildAttachmentContext()`

全部 `await` 串行，且 5/6/7 每轮都重算。这是明显的首字节延迟来源。

其他已取证的设计特征：

- `roveAgentChat()` **非流式**（`client.ts:101-119`），整段 reply 一次返回后
  用 `stream = (async function* () { yield reply; })()` 包成假流
  （`chat/route.ts:469`）→ 内核路径**没有真实流式**，用户必然等满全程。
- 部署区服务未跑时，每次请求都先尝试一次会失败的 `fetch` 到 `127.0.0.1:8788`，
  超时上限 30 s（`client.ts:19`）——本机实测是**立即** ECONNREFUSED，
  但在有防火墙/半开连接的环境会变成 30 s 白等。

**未量化项**（`unverified`）：真实 p50 延迟需读 `ai_usage_ledger`
（`src/lib/ai/model-registry.ts:333` 有该表）。本机无 `.env`，无法连库取数。

---

## 5. 「插件系统」的真因：现在有两个半成品，一个已死

### 5.1 TS 侧的 `src/lib/plugins/` 是**死代码**

取证：全仓搜索 `@/lib/plugins` → **0 处引用**。

文件很小：`types.ts` 31 行、`registry.ts` 66 行、`validator.ts`。
`registry.ts` 是一个内存 `Map`：

- 无文件加载（`PluginManifest.files` 从未被读取）
- 无执行（没有 `entry` 的动态 import）
- 无持久化（进程重启即清空，注释自承「primarily for unit tests」）

→ 设置页里**无法**基于它做出真正的插件管理。它不能承载「插件系统」。

### 5.2 Python 侧 `roveagent/plugins/` 是**真实可用**的插件系统

`roveagent/plugins/` 已有 17 个插件族，含 `plugin_storage.py`（每插件独立数据根
`<home>/plugin-data/<name>/`，install/update/remove 不碰用户数据）、
`plugin_utils.py`、`plugins/*/plugin.yaml` 清单约定。

`roveagent/clisupport/agent_plugins.py` 还实现了 **agent-plugins.org v1 规范**的导入器：
`plugin.json` + `mcp.json`，含 `_inside()` 路径逃逸校验、`MCP_SCHEMA_V1` 校验、
`streamable-http` → 原生 MCP 转换。

### 5.3 「沙箱」这件事，Python 侧已经有 6 种后端

`roveagent/sandbox/`：

```
local.py  docker.py  daytona.py  modal.py  managed_modal.py
singularity.py  ssh.py  vercel_sandbox.py   ( + path_utils.py, file_sync.py )
```

加上 `tools/code_execution_tool.py` 的 `execute_code` 与 `core/` 的隔离工作树
（`tools/subagent_worktree.py`）、`tools/path_security.py`、`tools/url_safety.py`、
`tools/threat_patterns.py`、`tools/plugin_guard.py`、`tools/skills_guard.py`。

**这就是用户想要的「插件坏了不影响主系统」的既有基础设施**——
`docker` 后端天然提供进程/文件系统隔离，`local` 是降级选项。

---

## 6. 「搜索 / 社交 / 短视频接口」的真因

全部已经存在，在 Python 侧：

### 6.1 搜索引擎（8 个后端）

`roveagent/plugins/web/`：`brave_free` / `ddgs` / `exa` / `firecrawl` /
`keenable` / `parallel` / `searxng` / `xai`，外加

- `plugins/web/keyless_mcp.py` — **免密钥**走 Exa / Parallel 的公共 MCP 端点
  （`https://mcp.exa.ai/mcp`、`https://search.parallel.ai/mcp`），带 failover
- `tools/x_search_tool.py` — X/Twitter 搜索

### 6.2 渠道 / 社交（22 个平台适配器）

`roveagent/plugins/platforms/`：

```
telegram  discord  slack  teams  whatsapp  wecom  weixin  feishu  dingtalk
line  matrix  mattermost  irc  sms  email  ntfy  simplex  photon
google_chat  homeassistant  a2a  buzz  raft
```

`roveagent/README.md:9` 自述「23 平台」，目录实测 **22 个**——文档与代码有 1 的出入
（`unverified` 哪边为准）。这些适配器含 `media.py`、`chunked_upload.py`、`crypto.py`、
`keyboards.py`——即**具备发媒体文件（视频/图片）的能力**。

### 6.3 「自动发视频」缺的不是通道，是**绑定**

`src/lib/channels.ts` + `channels-presets.ts` 在 TS 侧有渠道概念，
但 Python 的 22 个平台适配器与 TS 的渠道配置**没有打通**——
TS 侧的 `roveAgentChat()`（`client.ts:101`）只调 `/api/agent/chat`，
该端点没有任何渠道/发布相关参数。

→ 「自动发视频」= 开启 `video_gen` toolset + 启用一个平台插件 + 建一条
「生成 → 审批 → 发布」的链。前两者是配置，第三者是新代码（较小）。

---

## 7. 关于两个上传的压缩包

### 7.1 `deepseek-harness-dsh-v0.1.5-rc.2.zip` — 用户要我参考的那个

已解压核对：10178 个文件，是 **DSH（DeepSeek Harness）本身的 v0.1.5-rc.2 完整源码**
（`apps/{cli,desktop,desktop-host,web}`、`packages/{sandbox,guard,extensions,mcp,skill,
hooks,credentials,fs,subprocess,...}`、`native/`、`python/`、`website/`）。

**关于 fork：不建议把 DSH fork 进 RoveFrame。** 理由：

1. **它是另一个产品**，不是库。`apps/` 下是完整 CLI/桌面应用；
   没有发布成可嵌入的 SDK 形态。
2. **和你已有的 Python 内核职责重叠**：`packages/sandbox`、`packages/extensions`、
   `packages/mcp`、`packages/skill`、`packages/guard` 这些，`roveagent/` 里
   都有对应实现（§5.3、§6.1）。再引入一套 = 两套 Agent 运行时并存。
3. **技术栈冲突**：DSH 是 TS/Node monorepo + 原生二进制（`native/system/packages/`
   下有 darwin-arm64/darwin-x64/linux-arm64/linux-x64 预构建），
   RoveFrame 是 Next.js 应用 + Python 服务。混装会把构建链复杂化。

**该抄的是设计，不是代码。** DSH 有几点值得直接采纳（详见 §8 的 P3）：

- `SAFETY.md`（根目录存在）+ `packages/guard` + `packages/sandbox`：
  职责切得比我们清楚
- `packages/extensions` + `packages/preset`：插件与「预设」分离，预设是
  composition 文件，插件是能力单元——这正是 RoveFrame 缺的中间层
- `native/system/docs/flock-contract.md`、`cli-contract.md`：契约文档先行的做法

### 7.2 `argument-comment-lint-aarch64-apple-darwin.tar.gz`

解压后只有 3 个文件：

```
argument-comment-lint/bin/argument-comment-lint
argument-comment-lint/bin/cargo-dylint
argument-comment-lint/lib/libargument_comment_lint@nightly-2025-09-18-aarch64-apple-darwin.dylib
```

魔数取证 `cf fa ed fe 0c 00 00 01` = **Mach-O 64-bit little-endian**，aarch64。
这是一个 **Rust dylint lint 工具**（检查函数实参注释是否与形参一致），
由 `cargo-dylint` 驱动，内嵌 `nightly-2025-09-18` 工具链。

**对 RoveFrame 无直接价值**：

- 平台不符 — 本机是 Windows x64，这是 macOS ARM64 二进制，**无法执行**
- 语言不符 — 它 lint 的是 Rust，RoveFrame 没有 Rust 代码
  （`package.json` 无 Rust 依赖，仓库无 `Cargo.toml`）

**建议**：归档留存，不要接入构建链。它不解决任何当前问题。
（`unverified`：上传意图未知；若你想让它 lint 的是**别的** Rust 项目，
那与 RoveFrame 无关，需要单独的任务。）

---

## 8. 升级计划

排序原则：**先接通已有的，再补缺失的**。P0/P1 是修复（小改动能拿到大能力），
P2/P3 才是新建。

### P0 — 让已存在的能力跑起来（预计 1–2 天，改动很小）

| # | 动作 | 触及文件 | 验收 |
|---|---|---|---|
| P0-1 | 恢复 `.env`，写入 `ROVEAGENT_API_URL=http://127.0.0.1:8788` + `ROVEAGENT_API_KEY=<随机>` + `ROVEAGENT_APPROVAL_SECRET`；同步写 `scripts/deploy.env` | `.env`(新建)、`scripts/deploy.env` | `roveAgentConfigured() === true` |
| P0-2 | 启动内核：`bash scripts/roveagent-service.sh`；给它配 LLM：`ROVEAGENT_LLM_API_KEY/BASE_URL/MODEL` | 环境 | `curl :8788/api/health` 200 |
| P0-3 | 跑既有链路自检 `scripts/e2e-roveagent-link.ts` | — | 通过 |
| P0-4 | **把降级从静默改成可见**：`RoveAgentUnavailable` 时向前端 emit 一条 notice（而不是只 `console.warn`） | `chat/route.ts:470-476` | 内核挂掉时 UI 明确提示 |

P0-4 是最重要的工程改进：**静默降级是本次所有「假响应」投诉的放大器**。

### P1 — 开对工具集，让开发/运维 Agent 真能干活（预计 3–5 天）

| # | 动作 | 触及文件 | 说明 |
|---|---|---|---|
| P1-1 | 在 `ChatRequest` 增加 `toolsets` 字段（或按 `agent` 服务端映射） | `roveagent/api/app.py:170-181` | 服务端推导，不信客户端 |
| P1-2 | 建立 agent → toolset 映射表：`developer`/`devops` → `("coding",)`；业务高管 → `("safe","memory","business")` | `api/app.py:332-337` | 这是解开「假响应」的关键一处 |
| P1-3 | 把 `emp.permissions` / `emp.forbidden` 真正接进门控 | `api/app.py` + `permissions/engine.py` | 目前 `forbidden` 只是文档 |
| P1-4 | 移除 `employees.py` 中 Developer 的 `forbidden=["write_file"]`，或改为「需审批的写」 | `roveagent/employees.py:117` | 产品决策：允许写但每步审批 |
| P1-5 | 把工具集从 `("safe","memory","business")` 加入 `video_gen`（媒体诉求） | `api/app.py:335` | 视频能力随之解锁 |

**P1-4 是本计划唯一需要用户做产品决策的点**：开发 Agent 到底该
(a) 能自由改文件、(b) 只能改文件但每步要审批、还是 (c) 只能出 diff 让人工应用。
推荐 **(b)**——`EnterpriseToolGate` + `approvals` 已经具备这个能力。

### P2 — 补齐真实缺口（预计 1–2 周）

| # | 动作 | 说明 |
|---|---|---|
| P2-1 | **PDF 字体**：把一份可自由分发的 CJK 字体（思源黑体/Noto Sans CJK，OFL 许可）放进 `public/fonts/`，或设 `RF_PDF_FONT` | 一次性解决所有中文 PDF。注意确认 `loadFont()` 是否吃 `.ttc`（`msyh.ttc` 是集合字体，有解析风险） |
| P2-2 | **图像走通**：确认 `agnes` 服务商在 `PROVIDER_CATALOG` 中的 `runtime` 是否为 `declared`；若是，补一个 `openai_compat` 适配 | `src/lib/ai/provider-catalog.ts` |
| P2-3 | **视频生成**：TS 侧新增 `video-generation.ts`（对称于 `image-generation.ts`），并在 `deliverable.ts` 加 `VIDEO_INTENT` → 复用 Python 的 `video_gen` 或直连 fal/xAI | 新文件 + `deliverable.ts:68-150` |
| P2-4 | **音乐生成**：确认真实需求。若只是「配音/语音」→ 已有 TTS；若是「配乐」→ 需新增 provider | 需求澄清优先 |
| P2-5 | **流式**：把内核路径改成真 SSE（`roveagent` 侧已有 `gateway/stream_events.py`、`stream_dispatch.py`） | 直接改善「很慢」的体感 |
| P2-6 | **延迟**：为 `getBusinessContext` / `getSettings` / `getRecentMemories` 加 TTL 缓存；把 8 个串行 await 并行化 | `chat/route.ts:380-425` |
| P2-7 | **迭代预算**：`maxIterations`/`maxToolCalls` 从 4 提到合理值（如 12/16），做成按 persona 可配 | `agent-loop.ts:26-27` |

### P3 — 插件系统与沙箱（预计 3–4 周，用户明确要的那一块）

**核心判断：不要新建插件系统，把 `roveagent/plugins/` 暴露到设置页。**

架构建议：

```
设置 → 插件
   ├─ 已加载插件列表（读 roveagent/plugins/*/plugin.yaml）
   ├─ 启用/禁用（写 plugin 配置，重启对应子系统）
   ├─ 凭据录入（写 secret scope，不回显）
   └─ 能力预览（该插件贡献哪些 tool / channel / provider）

运行时隔离（三层，全部复用已有件）：
   层1 进程隔离  → sandbox/docker.py（首选）/ local.py（降级）
   层2 权限门控  → tools/framework.py 的 EnterpriseToolGate
                   + permissions/engine.py + approvals
   层3 故障隔离  → plugin_guard.py + tools/registry.py 热插拔
                   + ctx.effect 式可逆注册（插件卸载不留副作用）
```

要点：

1. **插件崩溃必须不传播**。`roveagent/tools/mcp_tool.py` 已有先例
   （`model_tools.py:232-237` 注释记录了「MCP discovery 作为模块级副作用导致
   每次启动白等 120s」并被移除）——同样的原则要用于插件加载：**超时 + 熔断 + 降级**。
2. **DSH 的 `packages/extensions` + `packages/preset` 分层值得抄**：
   插件 = 能力单元，preset = 一组插件的组合声明（YAML）。
   RoveFrame 缺的正是「一次启用哪几个插件」的声明层。
3. **`src/lib/plugins/` 那份死代码**：要么删掉，要么改造成「插件清单的 TS 侧读取器」
   （读 Python 的 `plugin.yaml`，只做展示与开关，不执行）。
   **不要**让 TS 侧执行插件——那才会真的把主系统搞崩。
4. 渠道（§6.2 的 22 个平台）应该以**插件形态**出现在同一个设置页里，
   而不是像现在这样在 `channels.ts` 里另起一套。

### P4 — 可选：搜索与发布闭环

- 把 `plugins/web/` 的 8 个搜索后端接进设置页（含**免密钥**的 exa/parallel 公共 MCP 端点，
  可零成本先用起来）
- 「生成视频 → 审批 → 发到某平台」的编排链（§6.3）

---

## 9. 风险与不做的事

| 事项 | 结论 |
|---|---|
| fork DSH 进本仓 | **不推荐**。职责重叠、技术栈冲突、它是产品不是库。抄设计即可。 |
| 接入 `argument-comment-lint` | **不做**。macOS ARM64 二进制 + Rust 目标，与本仓无关。 |
| 让 TS 侧执行不可信插件代码 | **禁止**。TS 进程持有 service_role key 与全部业务数据。插件执行必须在 Python 沙箱侧。 |
| 直接给开发 Agent 无审批写权限 | **不推荐**。走 `EnterpriseToolGate` + 审批（P1-4 选项 b）。 |
| 一次性全量切换 | **不推荐**。P0 先跑通，P1 再开工具集，每步都有可回滚点。 |

---

## 10. 取证清单（可复现）

```bash
# 内核未运行
curl -sS http://127.0.0.1:8788/api/health     # → connection refused

# 未配置
Test-Path .env                                 # → False
Select-String -Path scripts/deploy.env -Pattern ROVEAGENT   # → 无匹配

# 工具集硬编码
# roveagent/api/app.py:332-337   toolsets=("safe","memory","business")

# Developer Agent 被禁止写文件
# roveagent/workforce/employees.py:117   forbidden=["deploy_*", "write_file"]

# TS 兜底工具集无文件工具
# src/lib/agent/tools/index.ts:7-12 + write-tools.ts（write 均落 createPendingApproval）

# PDF 字体缺失
Get-ChildItem public/fonts          # → 仅 README.md
# src/lib/artifacts/pdf-writer.ts:861 discoverPdfFont()

# TS 插件系统是死代码
# grep "@/lib/plugins" src → 0 matches

# 迭代预算
# packages/roveagent-core/src/runtime/agent-loop.ts:26-27   ?? 4

# 媒体插件默认未启用
# roveagent/plugins/image_gen/{fal,openai,xai,deepinfra,krea,openrouter,openai-codex}
# roveagent/plugins/video_gen/{fal,xai,deepinfra}
```

---

## 11. Confidence & gaps

**已取证（代码行号可复核）**：内核未运行、环境未配置、工具集硬编码、
Developer Agent 的 `forbidden` 含 `write_file`、TS 兜底无文件工具、
PDF 字体目录为空、TS 插件系统零引用、迭代预算为 4、22 个平台与 8 个搜索后端存在、
6 种沙箱后端存在、DSH 与 argument-comment-lint 的真实身份。

**未取证 / 需用户或环境确认**：

1. 线上部署实例是否配了 `ROVEAGENT_*`（本机无 `.env`，只有 `.env.example` 模板）。
   若线上也没配，则线上同样是兜底路径。
2. `agnes` 服务商在 `PROVIDER_CATALOG` 中的 `runtime` 值 —— 决定图像能否走通。
3. `model_configs` 中 `agnes` 行的 `is_enabled` / `api_key_encrypted` 实际状态。
4. `ai_usage_ledger` 的真实延迟分位 —— 「很慢」目前是**设计推理**，不是实测数字。
5. `loadFont()` 是否支持 `.ttc` 集合字体（影响 Windows 上 `msyh.ttc` 能否兜底中文）。
6. 「音乐生成」的确切期望（配音 vs 配乐）——决定是复用 TTS 还是新增 provider。
7. `roveagent/README.md` 说 23 平台，目录实测 22 —— 哪边为准未核对。

**外部来源**：本报告未引用任何外部 URL；全部结论来自本仓源码与本机探测。
`deepseek-harness` 与 `argument-comment-lint` 的判定基于解压后的文件内容
（文件清单、魔数），未联网核对上游仓库。
