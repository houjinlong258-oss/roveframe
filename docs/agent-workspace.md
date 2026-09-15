# Agent Workspace 2.0 / 2.1（Model Composer + Artifacts + Failover + 交付运行时）

2.0 把 AI COO 页面从「聊天框」升级为 **AI Agent 工作台**；2.1 修掉真实客户测试
暴露的「能分析、但交付不了结果」断层。2.1 内容在最前面，2.0 基础在后面。

---

# 2.1：交付运行时与聊天内审批

## 0. 2.1 解决的四个真实故障

| 现象（来自真实测试与数据库核对） | 根因 | 修法 |
|---|---|---|
| 老板要 PDF，模型回「当前不支持生成 PDF 格式」；8 条回复 **0 个产物标记** | 把「系统能不能生成某格式」交给 LLM 判断 | 交付运行时 `deliverable.ts` + 系统提示词明令禁止能力声明 |
| 「我无法读取 PDF 二进制内容」 | 附件只内联纯文本格式 | 零依赖抽取器 `extract.ts` 覆盖 pdf/docx/xlsx/pptx |
| 聊天里刷 `custom unavailable(provider_error) — switching to deepseek` | 底层错误直接当用户文案 | 人话提示 + 技术细节折叠 |
| `agnes-image-2.0-flash` 被选中当聊天模型，连续 4 次 400 | Composer 列出 `/models` 里的**全部**模型 | 模型能力分类，非对话模型不可选 |

## 1. 交付运行时（`src/lib/artifacts/deliverable.ts` + `src/lib/agent/deliver.ts`）

**核心原则：模型只写内容，格式由运行时按用户原话决定。**

```
用户原话 ──detectDeliverables()──▶ ['pdf']              （纯函数，可单测）
模型回答 ──parseMarkdownDocument()─▶ DocSpec + TableSpec
                ├─ docx / xlsx / csv / html / md / txt / json → doc-writers
                ├─ pptx → pptx-writer（零依赖 OOXML）
                ├─ pdf  → pdf-writer（base14 Helvetica 或嵌入 TTF）
                └─ png  → image-generation（OpenAI 兼容 /images/generations）
                ▼
        putArtifact（私有桶）→ `<<artifact:UUID>>` 标记 → 聊天里出卡片
```

识别规则（可解释）：
- 明确格式词 + 请求动词 → 该格式；`pdf`/`excel`/`ppt` 这类「裸格式词」不需要动词
- 只说「写一份报告」不给格式 → Word + PDF
- 「所有格式 / 打包」→ docx + pdf + xlsx + pptx + html
- 「海报 / 图片」→ 走图像能力；没接入图像模型时**如实说明并保留设计方案**
- 文档里有表格但没要表格文件 → 顺手补一份 Excel
- 回答短于 80 字符 → 不生成空文件，并说明原因

两条路径并存：模型若主动输出 ```artifact: 围栏（`protocol.ts`）也照样物化，
运行时只补它没产出的格式，不重复交付。生成文件前会 `stripInternalMarkers()`
剥掉正文里的标记 —— 否则 `<<artifact:…>>` 会被写进正式文件。

## 2. 附件抽取（`src/lib/artifacts/extract.ts`）

零依赖：OOXML（docx/xlsx/pptx）走自写 ZIP 读取器 + `inflateRawSync`；
PDF 走**过滤器链解码** + `Tj`/`TJ` 操作符解析 + `ToUnicode` CMap 反查。

**PDF 过滤器链是必须的**（真实客户 PDF 暴露）：ReportLab、很多 Python 报表工具
默认产出 `/Filter [ /ASCII85Decode /FlateDecode ]`。只认单一 `FlateDecode` 时
会解码失败，进而**误报成「扫描件、没有文本层」** —— 老板会看到「我无法读取这份
PDF」，而文件其实完全可读。

现在支持：ASCII85 / ASCIIHex / Flate（含 Predictor 2 与 ≥10）/ LZW / RunLength，
按 `/Filter` 数组从左到右依次解码；未知过滤器报 `pdf-filter-unsupported:<name>`，
解码失败报 `pdf-stream-decode-failed:<对象号>`，**只有确实读到文本操作符为 0 时
才报 `scanned-pdf-no-text-layer`** —— 把「读不了」和「没有」分开。

仍不支持（会如实报 warning，不编造内容）：加密 PDF、DCT/JPX/JBIG2/CCITTFax 图像
过滤器、PDF 1.5+ 对象流（`/ObjStm`）、`/Differences` 字形名、扫描件 OCR。

排查工具：`npx tsx scripts/diag-pdf-text.ts <artifact-id>` —— 打印字节结构 +
`extractText` 的真实判定，用来区分「扫描件」「解码器缺口」「上层内联问题」。

## 2b. PDF 体积（字体子集化）

初版把整份字体嵌入 → 中文 PDF ≈ 11.8 MB，不可用于下载/邮件。
现已实现 **TrueType 字形子集化**（含复合字形递归闭包）：

```
glyphsTotal 30209 → glyphsKept 148
fontBytes 19,583,608 → 345,492
PDF      11.80 MB   → 156.6 KB（77×）
```

**部署注意**：Linux 容器常常没有任何 CJK 字体。此时系统不会产出排版错乱的
PDF，而是如实提示并改交付 Word / 网页版。要启用中文 PDF：

```bash
node scripts/setup-pdf-font.mjs   # 下载 Noto Sans SC(OFL) 到 public/fonts/
```

或用 `RF_PDF_FONT=/abs/path/font.ttf` 指定已有字体。详见 `public/fonts/README.md`。

## 3. 聊天内审批（`approval-card.tsx` + `src/lib/agent/approval-card.ts`）

- **这是 UI 入口，不是绕过审批系统**：点「批准」调用 `POST /api/agent/approvals`
  → `processApproval`，RBAC / 参数哈希 / 审计 / exactly-once 全部原样生效
- 审批卡片以 `<<approval:UUID>>` 标记落库，**刷新页面后仍在对话里**
- 载荷脱敏：只保留标量字段，敏感键写 `[redacted]`，数组只报长度（客户名单不进聊天记录）
- `canDecide` 由 `canApprove(role, required_role)` 决定，权限不够只读展示
- 「修改方案」把输入框预填成修改请求，不擅自改动原审批单
- 审批中心保留为历史 / 审计 / 批量管理的补充入口

## 4. 错误呈现（`friendlyNotice` + `NoticeLine`）

聊天里只说人话：「AI 服务正在自动切换备用引擎…」「已恢复服务（自动切换 2 次）」。
provider / error code / HTTP 状态收进 `technical` 字段，前端默认折叠，
点「技术详情」才展开 —— 老板不被吓到，排查时数据还在。

## 5. 模型能力分类（`classifyModelCapability`）

`chat | image | video | audio | embedding | other`，基于模型 id 命名模式。
Composer 只把 `chat` 做成可选项，其余单列标注「不可用于对话」；
故障切换链同样会挡掉非对话模型（含用户 localStorage 里的旧选择）。
选择器按用途分组：🧠 推理 / 💻 编码 / 👁 视觉 / ⚡ 快速 / ⚙️ 通用。

## 6. 卡片内预览（`GET /api/artifacts/[id]/preview`）

图片直出签名 URL；HTML 放 `sandbox=""` 沙箱 iframe（不注入页面 DOM）；
其余格式由服务端抽取器转成文本展示。前端不引入任何解析库。

---

# 2.0：工作台基础

## 1. 数据流总览

```
Composer(model / reasoning / 附件)
   ↓  POST /api/agent/chat
Model Registry ──→ Failover Chain ──→ Provider（OpenAI 兼容 / Anthropic）
   ↓                                      ↓
类型化 SSE 事件流  ←──── Artifact 围栏过滤 ←──┘
   ↓
Message + Artifact 卡片 + 审批卡片 + Mission Panel
```

## 2. Model Registry（`src/lib/ai/model-registry.ts`）

- **唯一数据源**：`GET /api/ai/models`。Composer 显示的是**当前实际连接成功的模型**，
  不存在写死的模型名。
- 健康度来自两个真实来源：设置页的连接测试（`model_configs.last_test_ok/last_tested_at`）
  和最近 200 条 `ai_usage_ledger`（p50 延迟 + 成功率）。
  **没有数据时返回 `unknown`（灰点），绝不假装在线**；未接入恒为 `offline` 且不可选。
- `tier`（high/medium/low）是**命名模式启发式**，只用于排序与默认推荐，不是官方基准。
  两个已固化的坑：`mini` 必须带词边界（否则会命中 `ge·mini·-2.5-pro`）；`o3/o4` 同理。
- 凭据列只用于判断「有没有 Key」，永不出现在返回值里。

## 3. 推理强度（`src/lib/ai/reasoning.ts`）

`low | medium | high`，影响 `max_tokens` / `temperature` / 系统指令。

**安全边界**：向不支持的上游发送 `reasoning_effort`、或对 o 系列发送 `temperature`
会直接 400，而 400 在故障切换链里会被误判成「这家挂了」。因此只有
`provider === 'openai'` 且模型名匹配原生推理模型时才下发 `reasoning_effort`，
并对 o/gpt-5 系列改用 `max_completion_tokens` 且省略 `temperature`。

默认档位：CEO / CTO 角色 `high`，COO / CMO `medium`，用户可随时手动覆盖。

> 该文件**零依赖**，因为浏览器端要运行时引用它。`model-registry.ts` 会连带引入
> supabase 客户端（`child_process`/`fs`），客户端组件绝不能运行时导入。

## 4. Provider Failover（`src/lib/ai/failover.ts`）

候选链顺序（可解释、去重、不可用项进 `skipped` 而不是静默丢弃）：

1. 用户在 Composer 显式选择的 `provider:model`
2. `settings.model_assign` 指定的服务商
3. 其他已接入（启用 + 有 Key + adapter 可路由）的服务商，按健康度 → p50 延迟排序
4. 平台内置模型（永远最后，永远可用）

三条不可违反的规则：

- **只在还没有产出任何文本时才能切换。** 一旦吐过字就换服务商，答案会拼接错乱，
  此时宁可失败也不切换（`if (emitted) throw`）。
- **全部失败绝不静默**：抛 `AllProvidersFailedError`，逐家带
  `provider / model / code / status / latencyMs`，同时写一条 `alerts` 作为后台故障日志。
  单次失败本身已由 `ai_usage_ledger` 记账（`status='error'`）。
- 每次尝试都发事件：`attempt → switched → settled | exhausted`，前端据此显示
  「GPT-5 unavailable (timeout) — switching to Claude」。

## 5. Artifact 协议（`src/lib/artifacts/`）

### 为什么不用 provider 原生工具调用
企业客户可能接入任何 OpenAI 兼容端点，很多不支持 function calling。改用**带标记的
代码围栏**，任何模型都能产出，且可流式解析、可单测、可回放：

````
```artifact:xlsx:customer-risk.xlsx
{"sheets":[{"name":"Risk","columns":["Customer","Score"],"rows":[["A",88]]}]}
```
````

- `csv / md / txt / json / html`：body 即文件原文
- `xlsx`：body 必须是 `{"sheets":[…]}` JSON
- `docx`：body 必须是 `{"title","sections":[…]}` JSON

`ArtifactStreamFilter`（`protocol.ts`）在**流式过程中**把围栏摘出来，
因此用户看不到原始 JSON 规格；切分点任意（SSE chunk 可能劈开 ``` 或文件名）。
未闭合的围栏按原文吐回，**绝不丢内容**；落库时替换为 `<<artifact:UUID>>` 标记，
刷新历史会话仍能还原成卡片。

### 存储（`store.ts`）
本项目 DDL 需要数据库密码（应用不持有），因此产物索引不依赖新表：
**私有桶 + 一产物一目录 + 目录内 `_artifact.json`**。

```
agent-artifacts/{tenantId}/{businessId}/{artifactId}/{fileName}
                                        /{artifactId}/_artifact.json
```

- 桶是 **private**，前端只拿 1 小时签名 URL（`/api/artifacts/{id}/download` 302 跳转）
- 零 DDL、零迁移；目录间互不干扰，天然并发安全
- `xlsx` / `docx` 由零依赖 OOXML 写入器（`doc-writers.ts`）生成真实 ZIP 包，
  Excel / WPS / Word 可直接打开

## 6. 类型化 SSE（`src/lib/agent/stream-events.ts`）

| type | 用途 |
|---|---|
| `status` | thinking / analyzing / calling_tool / tool_done / generating / creating_file |
| `provider` | 第 N/M 个候选开始尝试 |
| `delta` | 文本增量（同时带 `text` 字段，兼容旧客户端） |
| `artifact` | 新产物（含签名 URL） |
| `notice` | 切模型、产物编译失败等可见提示 |
| `error` | 失败（含全失败时的 `attempts[]`，`error` 字段兼容旧客户端） |
| `done` | 本轮结束 |

`calling_tool` 由 **Tool Registry 的审计回调**上报（`context.audit` 被包了一层），
所以状态条反映的是真实工具执行，不是前端定时器轮转。

## 7. Mission Panel（`src/lib/agent/missions.ts` + `/api/agent/missions`）

每一行都由真实经营数据推导，不是写死的文案：营收 vs 7 日均值、低库存 SKU、
高流失风险客户、差评/待回复、支付失败、待审批动作、未读 error 告警。

服务端只输出稳定的 `code`（i18n 键）与已格式化的 `metric`，
文案由前端按语言渲染（en/zh/es）。点击「执行」即把该任务的 `cta` 提示词交给 Agent。

## 8. 不可破坏的既有契约

- `EnterpriseToolGate` / Approval Bus / RBAC 全部保留：高风险工具仍走原有审批流
- 会话严格绑定 tenant + business + user（`.eq('user_id', ctx.userId)`）
- chat 并发限流 `acquireSlot` 仍在**流结束（含异常）时**释放
- 历史压缩（`RECENT_HISTORY_MESSAGES = 20` + `extendConversationSummary`）未变
- 模型分配（`model_assign`）语义未变：`auto` 仍然只走平台内置模型

## 9. 验证方式

```bash
pnpm ts-check                  # 0 error
pnpm lint                      # 0 error
npx tsx --test tests/*.test.ts # 463/463（需临时移开 scripts/deploy.env，
                               # 否则「无数据库回退」类测试会因真实凭据而失败）
```

新增测试：`tests/model-registry.test.ts`、`tests/ai-failover.test.ts`、
`tests/artifacts-protocol.test.ts`、`tests/agent-missions.test.ts`、
`tests/artifacts-writers.test.ts`。
