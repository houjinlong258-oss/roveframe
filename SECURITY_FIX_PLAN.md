# SECURITY_FIX_PLAN — RoveFrame Production Security Hardening 第一轮（P0 Security Boundary Issues）

> 基线：Production Gate / Pilot Ready 已通过。本轮**只处理 P0 安全边界**，不重构架构、不新增功能。
> 保留项：Agent Runtime、EnterpriseToolGate、Approval Bus、全部现有测试（TS 278 + Python 21）。
> 证据口径：以仓库内 `docs/current/CODE_QUALITY_IMPROVEMENT_PROMPT_20260908.md`（P0-5/P0-9/P0-18/P0-19/P1-1）与逐文件核实为准。

---

## S1 — AI Router Tenant/Business Scope Enforcement

- **问题**：`resolveModelDetailed` 在 scope 缺省时对 `settings`/`model_configs` 做**无租户过滤**查询并取第一行（`if (scope) { …eq } ` 守卫），随后 `decrypt(cfg.api_key_encrypted)` 用该行 Key 出站 → 平台级调用（NL 定制、编码提案）随机命中任意租户的付费 Key（跨租户凭据滥用 + 用量记 null + 行为非确定）。
- **文件**：`src/lib/ai/router.ts`（resolveModelDetailed :176-246）、`src/lib/customization/nl-engine.ts:522`、`src/lib/coding-agent/code-generator.ts:129`。
- **根因**：「无 scope = 平台级调用」与「无 scope 时不加租户过滤」两个约定叠加，缺少 fail-closed 分支。
- **修改方案**：
  1. scope 缺省 → 直接平台内置路由（AUTO_ROUTE），**绝不读取 settings/model_configs**；scope 存在但 businessId 缺失 → 保持抛错（fail-closed）。
  2. model_configs 查询从 `select('*')` 收窄为列白名单（provider/api_key_encrypted/base_url/default_model/is_enabled/timeout_ms/max_retries）。
  3. model_configs 查询按 PROVIDER_ALIAS 归一后的 catalog id 过滤（旧 id 配置可见性正确）。
  4. 平台级调用方显式使用导出的 `PLATFORM_AI_SCOPE`（null 语义），防止回归。
- **风险**：平台级任务从「随机租户 Key」变为确定性的平台内置模型（AUTO_ROUTE）；若未来需要平台级外部模型，需显式平台配置（本轮不做）。单文件可回滚。

## S2 — Model Config / Credential Isolation

- **问题**：S1 即本项主修复。已合格路径：`settings/models` GET 只返回掩码、写/删按 tenant+business、连接测试密钥不出服务端、route-info 传 verified scope。平台控制面例外（`admin/providers` 仅 `keyConfigured: boolean`、`admin/tenants/[id]` 仅密文）保持不变。
- **文件**：`src/lib/ai/router.ts`、`src/app/api/settings/models/route.ts`（仅测试锁定）。
- **根因**：路由层读配置时列范围与租户范围都由调用方自觉保证，无强制。
- **修改方案**：随 S1 的列白名单 + scope 强制落地；新增测试锁定「同租户不同 business 配置不可互读」「凭据访问只返回掩码」「route-info/peekAIRoute 不暴露密钥」。
- **风险**：无行为变化（已合规路径不变）。

## S3 — Python RoveAgent Memory Isolation

- **问题 A（L4 会话记忆跨会话/跨用户泄漏）**：`EnterpriseMemory.search` 对 L2+ 只按 `tenant_id+business_id` 过滤，`session_id` 形参不参与查询；chat 端点每轮写入 L4 但检索不传 session_id → 同 business 其他用户/会话的私密对话被注入当前 Agent 上下文。
- **问题 B（built-in 记忆工具跨租户）**：`tools/memory_tool.py get_memory_dir()` 固定 `<home>/memories` 全局目录；企业 chat 的 `toolset("memory")` 读写该全局 MEMORY.md/USER.md → 跨租户/跨业务记忆泄漏。
- **文件**：`roveagent/state/enterprise_memory.py`（search :146-199）、`roveagent/api/app.py`（chat :263-269）、`roveagent/tools/memory_tool.py`（get_memory_dir :64、_path_for :340）。
- **根因**：L4 层缺少 session 维度过滤；built-in 记忆工具未感知企业 ToolContext。
- **修改方案**：
  A. `search()`：请求层含 L4 时强制 `m.session_id = ?` 精确匹配；未提供 session_id 时 L4 静默排除（L0–L3 语义不变）；chat 端点检索传 `session_id`；memory 端点与 goal refine 无会话语义 → 不含 L4。
  B. `get_memory_dir()`：绑定 ToolContext 且 tenant/business 齐全时返回 `<home>/memories/enterprise/<tenant>/<business>/`（id 白名单净化 `[A-Za-z0-9._-]`，防路径穿越），未绑定回落原路径（CLI/网关行为不变）。
- **风险**：企业 chat 的 built-in 记忆从「全局共享」变为「按业务隔离」（修复目标）；无绑定上下文的调用不受影响。Python 全量测试回归。

## S4 — Internal Business Data Access Gate

- **问题 A（审批绕过）**：`send_recovery_campaign` 的 `invocation_id` 可选；无关联审批行时 `approvalId=''` 仍向 email_send_tasks 插入真实群发任务 → 持有服务密钥即可绕过 OWNER 审批外发。
- **问题 B（弱认证 + 路由死锁）**：静态 `x-roveagent-key` 无请求体 HMAC/时间戳（对照 approvals/events 已有 HMAC+300s 窗口）；且 `/api/internal/agent/business-data` 不在 PUBLIC_API_PREFIXES → 生产 proxy 先要商户 JWT，服务间调用 401 死锁（P1-1）。
- **文件**：`src/app/api/internal/agent/business-data/route.ts`（:339-401）、`src/lib/auth-guard.ts`（PUBLIC_API_PREFIXES）、`src/lib/roveagent/signature.ts`（复用）、`roveagent/business/data_layer.py`（_call 补签名）。
- **根因**：门禁只验「服务身份」，不验「审批链路」，且认证强度低于同族服务端点。
- **修改方案**：
  1. 写操作（当前仅群发）强制：invocation_id 必填 → 查 `agent_approvals`（tenant+business+invocation_id，action_type='roveagent.tool_call'，tool_name='send_customer_recovery_campaign'）→ 状态 ∈ {executing, executed} 且参数 canonical hash 与 `arguments_hash` 一致 → 否则 403/409；approvalId/executionId 以审批行回填。
  2. 请求体 HMAC + 时间戳（复用 `verifyRoveAgentPayload`；Python 侧 `data_layer._call` 同构签名），失败 401。
  3. 将该内部路径加入 PUBLIC_API_PREFIXES（handler 内密钥+签名 fail-closed，与 approvals/events 同模式）。
- **风险**：合法链路（审批 UI 批准 → executing → Python 回放 → internal 调用）状态序不变；无审批关联的直连调用现在 403（修复目标）。TS/Python 两侧同仓库同步上线。

## S5 — SSRF Protection

- **问题**：(a) channels 测试/发送对客户端 webhookUrl 任意 POST 且失败分支回显上游响应体；(b) integrations/test 的 erpnext url / shopify shopDomain 任意 fetch 且携带凭据头；(c) `checkBaseUrl` 仅字面 hostname 校验 → nip.io/sslip.io/xip.io 重绑定域名、十进制/八进制 IP、IPv6 ULA/loopback/映射地址、DNS 解析到私网的域名均可绕过；(d) `router.ts imageToBase64` 任意抓取 `image_url`；`fetchWithResilience`/`connection-test` 自动跟随重定向且不重新校验（重定向 SSRF）。
- **文件**：`src/lib/ai/url-utils.ts`、`src/lib/ai/router.ts`（:98-108、fetchWithResilience）、`src/lib/ai/connection-test.ts`、`src/lib/channels.ts`（:109-125）、`src/app/api/integrations/test/route.ts`。
- **根因**：出站 URL 校验散落各处、只查字面量不查解析结果、不覆盖重定向跳转。
- **修改方案**：
  1. 新增 `src/lib/security/outbound-url.ts`：`assertSafeOutboundUrl(url, {allowPrivate, allowHttp})` —— 协议白名单、静态 hostname 黑名单（localhost/*.internal/nip.io 族）、DNS 全量解析后逐 IP 拦截（loopback 127/8 & ::1、link-local 169.254/16 & fe80::/10、RFC1918、ULA fc00::/7、CGNAT 100.64/10、0/8、192.0.0/24、TEST-NET、multicast/reserved、::ffff:x.x.x.x 映射、metadata 169.254.169.254/100.100.100.200）；`fetchWithOutboundGuard(url, init, policy)`（redirect:'manual'，逐跳复检 ≤5 跳）。
  2. `checkBaseUrl` 保持同步签名（现有测试兼容）并增强字面检测（十进制/八进制 IP 归一、IPv6 loopback/ULA/映射、重绑定域名黑名单）；新增异步 `checkBaseUrlResolved`（字面 + DNS 双重校验）。
  3. 接入点：`fetchWithResilience`（外部模型调用）、`connection-test`、`imageToBase64`（+ 大小/内容类型限制）、channels 全部 URL 类出站（webhook/matrix）且错误不回显上游 body、integrations/test 的 erpnext/shopify 先断言安全再 fetch。
- **风险**：生产环境指向私网地址的自建 ERPNext/Matrix homeserver/内网 Ollama 将按策略拒绝（本地模型保留非生产 allowLocal opt-in）；渠道错误信息变脱敏（不回显上游响应体）。行为变化点均在「越权/泄露面」上，属修复目标。

---

## 测试矩阵（每项必含用户要求的场景）

| 场景 | 覆盖位置 |
|---|---|
| same tenant / different business | TS security-boundaries（router scope、模型配置隔离）+ Python memory_isolation |
| same user / different user | TS 凭据访问尝试（masked GET 契约 + router 列白名单）+ Python L4 会话隔离（同 business 不同 session/user） |
| unauthorized tool call | TS agent registry（无权限工具 forbidden）+ Python gate（缺权限拒绝 / 缺上下文 fail-closed / refund_* 需审批） |
| credential access attempt | router 无 scope 不触碰配置、列白名单、settings models 掩码契约 |
| SSRF bypass attempt | nip.io/sslip.io/十进制 IP/IPv6 ULA/mapped/重定向到 metadata/image_url 私网 全部拒绝 |

- TS：新增 `tests/security-boundaries.test.ts`；更新 `tests/ai-router-contract.test.ts`（保留全部现有断言）。
- Python：新增 `roveagent/enterprise/memory_isolation_test.py`（L4 隔离 + 记忆目录租户隔离 + 门控越权/审批）。

## 验证顺序

1. `pnpm ts-check` → 2. `pnpm lint:build && pnpm lint:style` → 3. `pnpm test` → 4. `python -m unittest discover -s roveagent -t . -p '*_test.py'` → 5. `pnpm scan:production` → 6. Security tests（新增测试文件单独跑通）→ 7. 汇总报告（每漏洞 Before/After/Test Evidence）。
