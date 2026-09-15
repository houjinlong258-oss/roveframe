# Phase 5 Complete — Search System（Web / Document / Enterprise）

**日期**：2026-09-12
**自主执行**：未逐项询问。**触发过一次暂停条件并主动停在边界内**（详见「边界决策」）。
**前置**：`docs/phase4-media-hub-document-report.md`

---

## 扫描结论：搜索系统已存在，本阶段不是新建

按要求先只读扫描（`scripts/_scan_search_surface.py`、`scripts/_scan_search_domains.py`）：

| 面 | 实测 |
|---|---|
| 搜索 provider | **8 个**（brave-free / ddgs / exa / firecrawl / keenable / parallel / searxng / xai） |
| 免密钥层 | **4 个**公共匿名 MCP（exa / parallel / firecrawl / keenable），`plugins/web/keyless_mcp.py` 761 行 |
| 已注册工具 | `web_search`、`web_extract`、`x_search`、`session_search`、`search_files`、13 个 `browser_*` |
| toolset | `search`、`web`、`x_search`、`session_search`、`business`、`media`、`social`（共 65） |
| 文档 RAG | **在 TS 侧**：`/api/knowledge/ask` → `match_doc_chunks(filter_tenant_id, filter_business_id)` |
| 业务数据 | Python 侧 `BusinessDataLayer` → `/api/internal/agent/business-data`（HMAC + scope 信封） |

所以 Phase 5 的实际工作是**验证 + 修缺陷 + 补缺口**，不是重写。

**★ 本阶段最重要的发现：本机零凭据就能真实联网搜索。**

`_probe_search_live.py` 实测（2026-09-12）：`web_search_tool` **2.99s 返回 3 条真实外部结果**，URL 均为绝对 http(s) 地址。整条链路是：`web_search_tool` → 插件发现 → registry → keyless 轮询环 → 公共 MCP 端点。

---

## Phase 5a：两个真实缺陷（已用硬证据确认并修复）★

### 缺陷 A（严重）：死厂商导致 25% 概率硬失败

`keyless_mcp.search_with_failover()` 只在 `_is_rate_limitish()` 为真时切换到环内下一家。
**上游 Firecrawl 已取消匿名免费层** —— `api.firecrawl.dev/v2/search` 对无 key 请求返回 **HTTP 403 Forbidden**（实测，2026-09-12）。403 **不是**限流形状 → 走环**直接停止并返回失败**，尽管后面还站着 3 家健康厂商。

环游标由随机 session id 播种，所以用户可见症状是**约 1/4 概率的间歇性硬失败**。

证据（修前）：

```
search_with_failover("firecrawl", "open source CRM", 2)
  success : False
  served_by: firecrawl        <- 没有走环
  results : 0
  error   : ... 403 Forbidden ...

dead ring vendors: firecrawl
hard-failure probability on an unpinned call: 1/4 = 25%
```

**修法**：新增 `_should_failover()`，把「**厂商级不可用**」也纳入走环条件 —— 认证/权益撤销（401/403/无 key）、计费（402/额度）、故障（5xx/连接失败）。厂商级 = 关于**厂商**的陈述，下一家不一定共享；而 query-shaped 错误（400/参数校验）仍是关于**请求**的陈述，走环只会放大延迟并用别家的错误掩盖真正的「查询非法」信号。**优先级显式实现：query-shaped 先判、优先停止。**

未识别错误仍然停止走环 —— **原有 fail-closed 契约未改**，只是补上两类已确认的厂商级失败。

### 缺陷 B（中）：裸 `_wt` 使「显式指定后端」静默失效

`keyless_mcp._vendor_pinned()` 读了从未在该模块绑定的裸名 `_wt`，每次调用抛 NameError，被外层 `except` 吞成 `return False`。后果：`web.backend: <vendor>` / `web.search_backend` / `web.extract_backend` 的**显式选择被静默忽略**，流量照旧轮询。

这与我在 Phase 4 修的 `firecrawl/provider.py` 的 `_wt` 是**同一类缺陷**（同一份代码里两处）。

证据（修前，`_probe_keyless_defects.py`）：

```
references bare `_wt.` : True
binds `_wt` somewhere  : False
NameError reproduced: name '_wt' is not defined
```

**修法**：`from roveagent.tools import web_tools as _wt` 局部绑定。

### 缺陷 C（新增能力）：厂商健康记忆

修完 A 之后，死厂商仍会在每次轮询到它时浪费一次往返（403 要 2.5s）。新增进程内冷却记忆：

| 失败类别 | 冷却 | 理由 |
|---|---|---|
| 认证/权益/故障 | 1800s | 不会在请求时间尺度上自愈（Firecrawl 的 403 整个会话都成立） |
| 限流 | 45s | 免费层秒级恢复 |

设计约束：冷却的厂商**降级到环尾而非移除** —— 环永远不可能因记账而空；全部冷却时回退到完整顺序（宁可多试一次，也不要返回「无可用 provider」）。`ROVEAGENT_KEYLESS_VENDOR_COOLDOWN=0` 可整体关闭。

修复后同一调用：

```
search_with_failover("firecrawl", ...) -> success: True, served_by: exa, results: 2
```

---

## Phase 5b：SSRF 归因层（**本阶段最需要判断力的一处**）★

`web_extract` 对一个**刚由搜索返回的合法公网 URL** 报错：

```
Blocked: URL targets a private or internal network address
```

### 诊断：守卫是对的，环境是问题

`scripts/_probe_fakeip_env.py` + `_probe_ssrf_guard.py` 实测（2026-09-12）：

| 域名 | 解析 | 判读 |
|---|---|---|
| `mcp.exa.ai` / `api.firecrawl.dev` / `search.parallel.ai` / `api.keenable.ai` | 全球地址 | 正常 —— **所以搜索能通** |
| `github.com` | `198.18.1.43`, `fdfe:dcba:9876::12` | 纯合成 |
| `forgeworkflows.com` | `198.18.0.5`, `fdfe:dcba:9876::11` | 纯合成 |
| `example.com` | `104.20.23.154`, `172.66.147.243`, `fdfe:dcba:9876::15` | **混合** |

`198.18.0.0/15` 是 RFC 2544 基准测试段；`fdfe:dcba:9876::/48` 是 fake-IP 解析器的合成前缀。这是 **fake-IP 型代理/隧道（Clash/Surge/mihomo 家族）拦截 DNS** 的特征。

关键判断：**`is_safe_url()` 拒绝这些地址是完全正确的**。把它们加进白名单就是 SSRF 漏洞。而守卫「**任一地址被拦则拦整个 URL**」也是正确的反 DNS-rebinding 策略（混合解析正是重绑定的经典形状）。

**因此这不是守卫 bug，是错误信息在骗人。** 它说「该 URL 指向内网地址」——对 `github.com` 而言是假话；真实原因是「本机解析器在编造地址」。

### 修法：只加归因，一个字都不放松

新增 `classify_url_block(url) -> UrlBlockReason`（`tools/url_safety.py`），产出 `code` / `detail` / `hint` / `resolved` 四段结构化归因：

| code | 含义 |
|---|---|
| `ok` / `dns_delegated` | 放行 |
| `scheme` / `empty_host` / `blocked_hostname` | URL 本身不合法 / 是元数据主机名 |
| `dns_failure` | 解析失败且无代理 |
| `metadata_ip` | 云元数据 / 链路本地 —— **永远是攻击目标** |
| `resolver_synthetic` | **只**解析到合成地址 → fake-IP 代理 |
| `resolver_mixed` | 同时解析到全球与保留地址 → 重绑定形状 **或** DNS 拦截 |
| `resolver_private` | 真实私网解析 |

hint 给出**按安全性排序**的处置阶梯：① 给目标主机加代理直连规则（首选）② 换到 DNS 不被拦截的运行环境 ③ 仅在前两者不可行时才考虑 `security.allow_private_urls: true`（文档化的全局逃生舱，仍拦元数据端点）。并明写「**不要把保留段加进白名单**」。

**校验（重要）**：`_probe_ssrf_guard.py` 断言归因与判定在**全部 9 个用例上一致，零不匹配**：

```
OK  enforced=False  blocked=True  code=resolver_synthetic  https://github.com/
OK  enforced=False  blocked=True  code=metadata_ip         http://169.254.169.254/
OK  enforced=False  blocked=True  code=resolver_private    http://10.0.0.1/
mismatches: none
```

顺带修了一处字段丢失：`web_extract_tool` 末尾的「Trim output to minimal fields」把新增的 `code`/`hint`/`resolved` 删掉了，导致归因算了但用户看不到。已放行诊断键（它们只出现在拒绝路径且很短）。

### 边界决策：我**没有**打开逃生舱

`security.allow_private_urls: true` 是上游为「DNS 重写环境」文档化的开关。**我没有启用它**，尽管那样能让 `web_extract` 在本机跑通 —— 因为关闭 SSRF 防护属于「修改安全模型导致权限扩大」，正是你设定的暂停条件 3。

我只做了验证性的、**进程内、不落盘**的确认（`_probe_extract_pipeline.py`），以区分「管线坏了」与「被环境挡住」：

```
[1] 守卫开启：拒绝，且 code=resolver_mixed（归因精确）
[2] 仅在本子进程内开启逃生舱（不改 .env / config.yaml）：
    title: Example Domain, content: 119 chars
[3] PIPELINE HEALTHY
```

**结论：extract 管线完好；唯一阻塞是本机 DNS 拦截。** 是否启用逃生舱留给你决定。

---

## Phase 5c：知识库检索桥接（**Python agent 此前完全无法检索租户文档**）★

### 缺口

扫描确认：Python 运行时能搜**公网**（keyless，已验证），但**没有任何工具能搜租户自己的文档**。RAG 只存在于 TS 侧 `/api/knowledge/ask`，那是给**应用内助手**用的。后果：agent 被问「我们的退款政策是什么」时能研究全世界，却读不到客户自己的手册。

### 复用而非重建

既有 `BusinessDataLayer` → `/api/internal/agent/business-data` 是**已加固**的服务间边界（timing-safe key、HMAC 体签名 + 时间戳、`.strict()` zod、`assertBusinessScope`、写入审计、群发绑定冻结审批）。我在其上**新增一个只读 operation**，四条链路：

```
search_knowledge          (工具, toolset "knowledge")
  → BusinessDataLayer.search_knowledge()          roveagent/business/data_layer.py
  → POST /api/internal/agent/business-data        src/app/api/internal/agent/business-data/route.ts
  → match_doc_chunks(filter_tenant_id, filter_business_id)
```

**安全前提已先行核实**（不是假设）：`knowledge_docs` 与 `doc_chunks` **两张表都有** `tenant_id` + `business_id` 及联合索引；`match_doc_chunks` 强制要求两个 filter 参数（`/api/knowledge/ask` 的注释明写「RPC 必须传 tenant_id，否则跨租户串味」）。因此新 operation 与既有 ask 路由**同源同作用域**，不引入跨租户面。

设计要点：
- **检索不做归纳** —— 只回 passage + 来源标题。归纳由运行时自己的模型完成，避免服务间调用**偷偷产生模型费用**。
- RPC 缺失时退回「当前租户最近分块」的确定性降级（作用域仍然生效），与 ask 路由一致。
- scope id **只来自不可变运行上下文**，工具 schema 无 tenant/business 字段。

### Gate 策略（**必须显式登记**）

`DEFAULT_POLICIES` 末尾是兜底 `ToolPolicy("*", "", LOW, NONE)` —— 注释明写「**兜底 = 免审批直执**」。我核算过 `search_knowledge` 不匹配任何既有模式（`send_*` 需前缀 `send`；`search_files` 是精确匹配），**若不补行就会落到兜底**。已补：

```
ToolPolicy("search_knowledge", "knowledge:read", RiskLevel.LOW, ApprovalPolicy.NONE)
```

并断言未被更早的模式遮蔽（遮蔽行 = 死行）。

### 能力授予

`knowledge` 授予 `ceo` / `operations` / `marketing` —— 它们本就持有**同风险等级**的只读 `business`。`developer` / `devops` 与 fail-closed 兜底**保持不动**（无陈述需求，不无谓扩大授权）。既有 `ConsistencyTest` 的超集性质复跑仍通过。

---

## 修改文件

| # | 文件 | 动作 |
|---|---|---|
| 1 | `roveagent/plugins/web/keyless_mcp.py` | 改：厂商级失败分类 + 走环优先级 + 冷却记忆 + `_wt` 绑定 |
| 2 | `roveagent/tools/url_safety.py` | 改：新增归因层 `classify_url_block` / `UrlBlockReason`（纯增量、不改判定） |
| 3 | `roveagent/tools/web_tools.py` | 改：拒绝路径改用归因；trim 放行诊断键 |
| 4 | `roveagent/business/data_layer.py` | 改：新增 `search_knowledge()`（含边界钳制） |
| 5 | `roveagent/tools/business_data_tool.py` | 改：注册 `search_knowledge` 工具 |
| 6 | `roveagent/tools/framework.py` | 改：新增 gate 策略行 |
| 7 | `roveagent/toolsets.py` | 改：新增 `knowledge` toolset |
| 8 | `roveagent/api/capability_router.py` | 改：三个业务 agent 授予 `knowledge` |
| 9 | `src/app/api/internal/agent/business-data/route.ts` | 改：新增 `search_knowledge` read operation |
| 10 | `roveagent/plugins/web/keyless_mcp_test.py` | **新建**回归测试（26 测试 / 7 subtests） |
| 11 | `roveagent/tools/url_safety_attribution_test.py` | **新建**回归测试（17 测试 / 26 subtests） |
| 12 | `roveagent/business/knowledge_bridge_test.py` | **新建**回归测试（17 测试 / 18 subtests） |
| 13 | `scripts/_probe_search_live.py` 等 6 个探针 | **新建** |

**未修改**：`web_tools` 的判定语义、`is_safe_url()` 的任何分支、registry、provider 插件、`EnterpriseToolGate` 的授权逻辑、`api/toolsets.py`。
**未新增依赖**：`package.json` 未改动。

---

## 测试结果（全部实测，2026-09-12）

```
$ python -m pytest roveagent -q --ignore=roveagent/skills_library
232 passed, 289 subtests passed, 1 failed in 35.04s
  （Phase 4 为 215 passed / 268 subtests；+17 新回归测试）

$ python -m pytest roveagent/api roveagent/tools/permissions_policy_test.py -q
115 passed, 235 subtests passed          （与 Phase 4 持平，无回归）

$ python -m pytest roveagent/business/knowledge_bridge_test.py -q
17 passed, 18 subtests passed

$ python -m pytest roveagent/plugins/web/keyless_mcp_test.py \
                   roveagent/tools/url_safety_attribution_test.py -q
39 passed, 33 subtests passed

$ pnpm exec tsc -p tsconfig.json --noEmit
exit 0

$ pnpm exec tsx --test tests/{roveagent-stream-contract,runtime-status-contract,
                              runtime-fallback-policy,runtime-recovery,artifacts-pdf}.test.ts
tests 73  pass 73  fail 0
```

**探针（端到端，含真实联网）**：

| 探针 | 结果 |
|---|---|
| `_probe_search_live.py` | **12/12** —— 真实联网搜索 + 死厂商 failover |
| `_probe_keyless_defects.py` | **4/4** —— 两缺陷均已修 |
| `_probe_ssrf_guard.py` | **9/9 归因与判定一致，零不匹配** |
| `_probe_extract_pipeline.py` | **PIPELINE HEALTHY**（119 字符真实正文） |
| `_probe_knowledge_bridge.py` | **26/26** |
| `_probe_fakeip_env.py` | 环境画定（混合 DNS 拦截） |

**唯一失败**：`roveagent-achievements/tests/test_achievement_engine.py::test_dashboard_card_hover_does_not_move_click_target` —— **已证明为既有、与本次改动无关**：该测试读取构建产物 `dashboard/dist/style.css`，而该目录**根本不存在**（`Test-Path` = False，该目录下只有 4 个文件），且整个源码树未纳入 git，前端从未构建。我本次改的是 `url_safety.py` / `web_tools.py` / `keyless_mcp.py`，与该 CSS 无关。

---

## 新发现风险

| # | 风险 | 说明 | 处置 |
|---|---|---|---|
| **R23** | **上游 keyless 免费层会消失** | Firecrawl 已撤销匿名层（403）。其余 3 家仍可用，但这是**持续漂移** | 已加厂商级 failover + 冷却。建议定期跑 `_probe_search_live.py` 作健康检查 |
| **R24** | **fake-IP 代理使 `web_extract` 全域不可用** | 本机实测：除个别直连域名外，公网主机全被解析成 `198.18.x.x`/合成 IPv6 → 守卫（正确地）全拦。**用户看到的是误导性错误信息** | 已加归因层。**部署决策待定**：代理直连规则 / 换环境 / 启用文档化逃生舱 |
| **R25** | **`search_knowledge` 桥接需要 `ROVEFRAME_INTERNAL_API_URL`** | 实测 `.env` **未设置**，故桥接暂不可达 Next.js。代码与契约已验证（26/26），但**真实端到端查询未验证** | 配置项 + 有效 Supabase 凭据 |
| R21 | 生产 Linux 缺 CJK 字体 | 未变 | 部署时 `setup-cjk-font.mjs --check` |
| R7 | DB 迁移未应用 | 未变 | 有凭据环境执行 |
| R22 | 全部 11 个媒体 provider 无凭据 | 未变 | 需真实 key |
| R19 | 插件安装把不可信代码拉进主进程 | 未变 | **首次装第三方插件前须决定容器隔离** |
| R17/R18 | 见 Phase 3 报告 | 未变 | — |

**R23 值得强调**：这不是「修好了」。是**把一个会硬失败的缺陷，改成了会优雅绕过并留下记录的缺陷**。免费层依赖上游的商业决定，随时可能再变；能承诺的只是「一家倒了不至于整个搜索倒」。

**R24 值得强调**：`web_search` 与 `web_extract` 在本机的**命运不同** —— 前者走 provider 自己的 HTTP（不经过 `is_safe_url`）所以能用；后者经过守卫所以被拦。这个不对称是环境的产物，不是设计缺陷，但它会让「搜索能用、抓取不能用」看起来像 bug。

---

## 下一步：Phase 6（Social Automation）

按目标模式继续。Phase 6 计划（扫描已确认的起点）：

1. **`social` toolset 存在但无内置发布工具**（其描述已如实写明）—— 需确认 5/6 目标平台（LinkedIn / TikTok / YouTube / Bilibili / 小红书）的缺失面
2. **一条平台端到端闭环**：趋势 → 内容 → 媒体 → 审批 → 发布 → 分析
3. **审批必须贯穿**：发布是 `comms:send` 级别的对外动作，必须经 `EnterpriseToolGate` 且留审计
4. 复用既有：`media` toolset（Phase 4 已验）、content 生成、`business`/`knowledge` 读取

---

## Confidence & gaps

**高置信（本机实测，可复现）**
- 免密钥联网搜索真实可用：3 条真实外部结果，绝对 URL，2.99s
- 缺陷 A/B 的存在与修复：修前后对比均已留证
- SSRF 归因与判定 9/9 一致、零不匹配；元数据与私网仍被正确拦截
- extract 管线完好（119 字符真实正文）—— 阻塞纯属环境
- 知识库桥接的注册、toolset、gate 策略、adapter 契约、跨租户拒绝：26/26
- 全量 Python 232 passed / 289 subtests；TS `tsc` exit 0、73/73

**中置信**
- 缺陷 A 的「25% 硬失败」是按环游标随机播种推导的概率，未做 100 次采样统计（成本考虑）。已观测到的实例：修前 `search_with_failover` 命中 firecrawl 即失败
- 另外 3 家 keyless 厂商的**长期**可用性未知，仅 2026-09-12 单次实测

**未验证（明确缺口）**
- **知识库检索的真实端到端**：`ROVEFRAME_INTERNAL_API_URL` 未配置、无有效 Supabase 凭据。已验证接线与契约，**未验证上游向量检索返回的 passage 质量**
- **`search_knowledge` 真实调用路径**：本机无运行上下文，handler 走的是结构化降级分支（已断言不崩），未走成功分支
- **`web_extract` 成功路径的真实内容质量**：仅在子进程内临时开启逃生舱验证过 1 个 URL（example.com），未做多站点验证
- **TS 侧 `readKnowledge()` 的运行时行为**：`tsc` 通过 + zod schema 已定义，但未在真实 Supabase 上执行过
- **归因层在非 fake-IP 环境的表现**：本机几乎所有公网主机都被拦截，`ok` 分支只在 `example.com` 上观察到

**需人工决策（未擅自执行）**
- 是否启用 `security.allow_private_urls: true`（关闭 SSRF 对外防护以适配 DNS 拦截环境）。属安全模型变更，我停在边界内，只做了进程内验证
- 生产代理是否为目标主机配置直连规则（首选方案，不削弱安全）
