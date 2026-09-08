# SECURITY HARDENING REPORT — Round 1（P0 Security Boundary Issues）

> 计划文档：`SECURITY_FIX_PLAN.md`。验证结果：`pnpm validate` 全绿（ts-check / lint:build / lint:style / 309 tests / scan:production 2016 文件），
> Python `unittest discover -s roveagent -p '*_test.py'` 33 tests 全绿。基线 TS 278 → 现 309；Python 21 → 33。
> 保留项确认：Agent Runtime、EnterpriseToolGate、Approval Bus 本体未改动（仅锁定其判定并补审批关联强制）；全部既有测试保留且通过。

---

## 1. AI Router Tenant/Business Scope Enforcement（P0-18）

- **Before**：`resolveModelDetailed` 在 scope 缺省时对 `settings`/`model_configs` 执行无租户过滤查询（`if (scope) { …eq } ` 守卫）并取第一行，随后 `decrypt(cfg.api_key_encrypted)` 用该行 Key 出站 → 平台级调用（NL 定制、编码提案）随机命中**任意租户**的付费 Key（跨租户凭据滥用 + 被借租户付费 + 用量记 null）。
- **After**：
  - scope 缺省 → 直接平台内置路由（AUTO_ROUTE），**绝不读取任何租户 settings/model_configs**（fail-closed 分支）；
  - scope 存在但 tenant/business 缺失 → 抛错（business scope is required for model resolution）；
  - `settings`/`model_configs` 查询无条件双 `eq('tenant_id')+eq('business_id')`；
  - `model_configs` 从 `select('*')` 收窄为列白名单（MODEL_CONFIG_COLUMNS），provider 按 PROVIDER_ALIAS 归一后过滤；
  - 平台级调用方（nl-engine / code-generator）显式使用导出的 `PLATFORM_AI_SCOPE`。
- **文件**：`src/lib/ai/router.ts`、`src/lib/customization/nl-engine.ts`、`src/lib/coding-agent/code-generator.ts`
- **Test Evidence**：
  - `tests/security-boundaries.test.ts` S1：peekAIRoute(PLATFORM_AI_SCOPE) → platform 且不触库；无 businessId → 抛错；same tenant / different business scope 互异；源码契约（双 eq 过滤、无 `select('*')`、fail-closed 分支、平台调用方显式 PLATFORM_AI_SCOPE）。5/5 pass。

## 2. Model Config / Credential Isolation

- **Before**：路由层可无 scope 读取并解密任意租户 `api_key_encrypted`（随 S1 修复）；`model_configs` 全列 `select('*')` 进入内存对象。
- **After**：仅白名单列可读，凭据列只在路由层解密使用；settings/models GET 维持仅掩码返回、admin/providers 维持仅 `keyConfigured` 布尔；route-info 诊断永不携带 apiKey。
- **文件**：`src/lib/ai/router.ts`、`src/app/api/settings/models/route.ts`（测试锁定）、`src/app/api/admin/providers/route.ts`（测试锁定）
- **Test Evidence**：
  - `tests/security-boundaries.test.ts` S2：credential access attempt——GET 只出掩码（`maskedKey: mask(plain)` + `hasKey`，无 `apiKey: plain`）、admin/providers 不泄露密文、peekAIRoute 载荷不含 apiKey/sk-。3/3 pass。

## 3. Python RoveAgent Memory Isolation（P0-9 + 全局记忆目录）

- **Before**：
  a) `EnterpriseMemory.search` 对 L2+ 只按 tenant+business 过滤，`session_id` 不参与查询 → 同 business 其它会话/用户的 L4 私密对话被注入当前 Agent 上下文；
  b) built-in 记忆工具 `get_memory_dir()` 固定全局 `<home>/memories`，企业 chat 的 `toolset("memory")` 跨租户/跨业务读写同一 MEMORY.md/USER.md。
- **After**：
  a) L4 检索强制 `m.session_id = ?` 精确匹配；未传 session_id 时 L4 静默排除（L0–L3 语义不变）；chat 端点检索传 `session_id=req.session_id`；memory 端点与 goal refine 无会话语义不含 L4；
  b) `get_memory_dir()` 在绑定 ToolContext（tenant+business 齐全）时返回 `<home>/memories/enterprise/<tenant>/<business>/`（id 白名单净化 `[A-Za-z0-9._-]`，防路径穿越），未绑定回落原目录（CLI/网关行为不变）。
- **文件**：`roveagent/state/enterprise_memory.py`、`roveagent/api/app.py`、`roveagent/tools/memory_tool.py`
- **Test Evidence**：
  - `roveagent/enterprise/memory_isolation_test.py`（12 tests）：同业务不同会话 L4 互不可见（same user / different user）；无 session 调用不含 L4；同租户不同业务 L2/L4 隔离；搜索强制 tenant+business；绑定上下文目录按租户×业务隔离；路径穿越字符净化；MemoryStore 跨业务写入隔离且全局目录不被污染；门控：缺权限拒绝 / refund_* 需 owner 审批不直执 / 缺上下文 fail-closed / 审计事件携带租户业务 scope。12/12 pass。
  - 既有 `context_isolation_test.py`、`business_isolation_test.py` 等全套 33 tests 保持全绿。

## 4. Internal Business Data Access Gate（P0-19 + P1-1）

- **Before**：静态 `x-roveagent-key` 无请求体签名/时间戳；`send_recovery_campaign` 的 `invocation_id` 可选，无审批关联时 `approvalId=''` 仍向 email_send_tasks 插入真实群发任务（持服务密钥即可绕过 OWNER 审批外发）；路径不在 PUBLIC_API_PREFIXES（生产 proxy 先要商户 JWT，服务调用死锁）。
- **After**：
  - 群发强制审批关联：invocation_id 必填 → 审批行必须 `action_type='roveagent.tool_call'` + `tool_name='send_customer_recovery_campaign'` + 状态 ∈ {executing, executed} + 请求参数 canonical hash 与冻结 `arguments_hash` 一致，否则 403/409；approvalId/executionId/agentId/userId 以审批行回填；
  - 全部请求体 HMAC + 时间戳（复用 `verifyRoveAgentPayload`，±300s 时钟窗；Python 侧 `data_layer._call` 同构签名）；
  - `/api/internal/agent/business-data` 加入 PUBLIC_API_PREFIXES（handler 内密钥+签名 fail-closed，与 approvals/events 同模式）。
- **文件**：`src/app/api/internal/agent/business-data/route.ts`、`src/lib/auth-guard.ts`、`roveagent/business/data_layer.py`
- **Test Evidence**：
  - `tests/security-boundaries.test.ts` S4：5 种审批绕过尝试（无 invocation / 无审批行 / 工具不符 / pending / 参数篡改）全部拒绝；合法 executing+hash 一致放行并回填审批身份；HMAC 往返 + 篡改/过期/换密钥拒绝；源码契约 + `isPublicApiPath` 白名单。8/8 pass。

## 5. SSRF Protection（P0-5 全族）

- **Before**：channels 测试/发送对客户端 webhookUrl 任意 POST 且失败回显上游响应体；integrations/test erpnext/shopify 任意 fetch 携带凭据；`checkBaseUrl` 仅字面 hostname 校验（nip.io 族、十进制/八进制 IP、IPv6 ULA/映射、DNS 重绑定均可绕过）；`imageToBase64` 任意抓取 `image_url`；`fetchWithResilience`/connection-test 自动跟随重定向不复检。
- **After**：
  - 新增 `src/lib/security/outbound-url.ts`：`assertSafeOutboundUrl`（协议白名单 → 静态 hostname 拒绝 → IP 字面量逐段检查 → DNS 全量解析逐地址拦截 → 重定向逐跳复检 ≤5 跳；非 GET 不跟随重定向）+ `fetchWithOutboundGuard`；
  - `checkBaseUrl` 增强字面检测（重绑定域名、十进制/八进制 IP、IPv6 loopback/ULA/mapped、CGNAT），新增 `checkBaseUrlResolved`（DNS 层）；
  - 接入点：fetchWithResilience（外部模型）、connection-test、imageToBase64（+10MB/内容类型限制）、channels webhook/matrix（错误不回显响应体）、integrations/test erpnext/shopify。
- **文件**：`src/lib/security/outbound-url.ts`（新增）、`src/lib/ai/url-utils.ts`、`src/lib/ai/router.ts`、`src/lib/ai/connection-test.ts`、`src/lib/channels.ts`、`src/app/api/integrations/test/route.ts`
- **Test Evidence**：
  - `tests/security-boundaries.test.ts` S5（10 tests）：16 个 metadata/loopback/私网/保留地址字面量（含十进制/八进制/IPv6 ULA/mapped）全拒；nip.io 族静态拒绝；localhost 解析层拒绝；checkBaseUrl 同步覆盖 IP 变体且保留既有策略；公网 IP 通过；重定向到 metadata 拒绝；GET 安全重定向跟随；POST 重定向拒绝；源码契约（channels/integrations/image_url 全接入、错误不回显）。10/10 pass。
  - `tests/ai-router-contract.test.ts`：既有 SSRF 用例全保留 + 新增 2 用例（IP 变体/DNS 层）全绿。

---

## 验证矩阵（全部通过）

| 步骤 | 结果 |
|---|---|
| `pnpm validate`（ts-check + lint:build + lint:style + test + scan:production） | ✅ 309/309 tests，scan 2016 文件通过 |
| Python `unittest discover -s roveagent -t . -p '*_test.py'` | ✅ 33/33 |
| Security tests（`tests/security-boundaries.test.ts` + `roveagent/enterprise/memory_isolation_test.py`） | ✅ 29 + 12 |
| 既有测试保留 | ✅ 全部保留并通过（含 api-rbac-contract / business-isolation / production-hardening / recovery-campaign 源码契约） |

## 风险与行为变化点

1. 平台级 LLM 任务（NL 定制/编码提案）从「随机租户 Key」变为确定性的平台内置模型（AUTO_ROUTE）；如需平台级外部模型需后续显式平台配置（不在本轮）。
2. 生产环境指向私网地址的自建 ERPNext / Matrix homeserver / webhook 目标将被出站守卫拒绝（本地模型保留非生产 allowLocal opt-in；metadata 地址任何环境拒绝）。
3. 群发召回邮件现在必须先走审批（executing/executed 状态 + 冻结参数 hash 一致），直连调用返回 403/409 —— 即本轮的审批绕过修复目标。
4. 渠道/集成错误信息不再回显上游响应体。
5. Python 侧 `ROVEAGENT_APPROVAL_SECRET` 未配置时回落到 ROVEAGENT_API_KEY（与既有 approval_bridge 行为一致；密钥分离属后续 P1-18）。
