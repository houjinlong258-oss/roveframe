/**
 * Production Security Hardening 第一轮 —— P0 安全边界测试
 * tests/security-boundaries.test.ts
 *
 * 对应 SECURITY_FIX_PLAN.md 五类边界（S1/S2/S4/S5 的 TS 侧；S3 Python 侧见
 * roveagent/enterprise/memory_isolation_test.py）。场景矩阵：
 *   - same tenant / different business
 *   - same user / different user
 *   - unauthorized tool call
 *   - credential access attempt
 *   - SSRF bypass attempt
 */
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  PLATFORM_AI_SCOPE,
  peekAIRoute,
  validateModelResolutionScope,
} from '../src/lib/ai/router';
import {
  assertSafeOutboundUrl,
  expandIpv6,
  fetchWithOutboundGuard,
  isBlockedAddressLiteral,
  isRebindingHostname,
} from '../src/lib/security/outbound-url';
import { checkBaseUrl, checkBaseUrlResolved } from '../src/lib/ai/url-utils';
import { signRoveAgentPayload, verifyRoveAgentPayload } from '../src/lib/roveagent/signature';
import { hashApprovalArguments } from '../src/lib/agent/approvals';
import {
  validateCampaignApprovalLinkage,
  type CampaignApprovalRow,
} from '../src/app/api/internal/agent/business-data/route';
import { agentToolRegistry } from '../src/lib/agent/registry';
import { registerDefaultReadTools } from '../src/lib/agent/tools';
import type { AgentToolContext } from '../src/lib/agent/types';
import { isPublicApiPath } from '../src/lib/auth-guard';

const read = (p: string): string => readFileSync(path.resolve(process.cwd(), p), 'utf8');

const originalApprovalSecret = process.env.ROVEAGENT_APPROVAL_SECRET;
const originalApiKey = process.env.ROVEAGENT_API_KEY;
afterEach(() => {
  if (originalApprovalSecret === undefined) delete process.env.ROVEAGENT_APPROVAL_SECRET;
  else process.env.ROVEAGENT_APPROVAL_SECRET = originalApprovalSecret;
  if (originalApiKey === undefined) delete process.env.ROVEAGENT_API_KEY;
  else process.env.ROVEAGENT_API_KEY = originalApiKey;
});

function makeToolContext(overrides: Partial<AgentToolContext> = {}): AgentToolContext {
  return {
    tenantId: 'tenant-a',
    businessId: 'business-a',
    userId: 'user-staff',
    role: 'staff',
    sessionId: 'session-1',
    turnId: 'turn-1',
    locale: 'en',
    timeZone: 'America/New_York',
    audit: async () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// S1 — AI Router Tenant/Business Scope Enforcement
// ---------------------------------------------------------------------------

describe('S1 AI Router scope enforcement', () => {
  test('平台级调用（无 scope）只允许平台内置模型，绝不读取租户配置', async () => {
    // PLATFORM_AI_SCOPE / null：不触碰 settings/model_configs，直接返回 platform 路由
    const route = await peekAIRoute('light', PLATFORM_AI_SCOPE);
    assert.equal(route.kind, 'platform');
    assert.equal(route.usedFallback, false);
  });

  test('scope 存在但 businessId 缺失时 fail-closed 抛错', async () => {
    await assert.rejects(
      () => peekAIRoute('light', { tenantId: 'tenant-a', businessId: null }),
      /business scope is required for model resolution/,
    );
  });

  test('scope 形状校验：同租户不同 business 都是合法且互异的 scope（same tenant / different business）', () => {
    const scopeA = validateModelResolutionScope({ tenantId: 'tenant-a', businessId: 'business-a' });
    const scopeB = validateModelResolutionScope({ tenantId: 'tenant-a', businessId: 'business-b' });
    assert.deepEqual(scopeA, { ok: true, tenantId: 'tenant-a', businessId: 'business-a' });
    assert.deepEqual(scopeB, { ok: true, tenantId: 'tenant-a', businessId: 'business-b' });
    assert.notEqual(scopeA.ok && scopeA.businessId, scopeB.ok && scopeB.businessId);
    assert.equal(validateModelResolutionScope({ tenantId: 'tenant-a' }).ok, false);
    assert.equal(validateModelResolutionScope({ tenantId: '', businessId: 'business-a' }).ok, false);
  });

  test('源码契约：settings/model_configs 查询必须同时携带 tenant_id + business_id 过滤，且不 select(\'*\')', () => {
    const source = read('src/lib/ai/router.ts');
    // settings 查询：tenant + business 双 eq 在同一语句窗口内
    assert.match(source, /\.from\("settings"\)[\s\S]{0,300}\.eq\("tenant_id", tenantId\)[\s\S]{0,200}\.eq\("business_id", businessId\)/);
    // model_configs 查询：双 eq + 列白名单（无 select('*')）
    assert.match(source, /\.from\("model_configs"\)[\s\S]{0,400}\.select\(MODEL_CONFIG_COLUMNS\)[\s\S]{0,400}\.eq\("tenant_id", tenantId\)[\s\S]{0,200}\.eq\("business_id", businessId\)/);
    assert.doesNotMatch(source, /\.from\("model_configs"\)[\s\S]{0,120}\.select\("\*"\)/);
    // 无 scope 的调用绝不进入配置查询（fail-closed 分支）
    assert.match(source, /scopeCheck\.reason === 'platform_scope'[\s\S]{0,200}return platformResolution/);
  });

  test('平台级调用方显式使用 PLATFORM_AI_SCOPE（nl-engine / code-generator）', () => {
    assert.match(read('src/lib/customization/nl-engine.ts'), /PLATFORM_AI_SCOPE/);
    assert.match(read('src/lib/coding-agent/code-generator.ts'), /PLATFORM_AI_SCOPE/);
  });
});

// ---------------------------------------------------------------------------
// S2 — Model Config / Credential Isolation
// ---------------------------------------------------------------------------

describe('S2 credential isolation', () => {
  test('credential access attempt：settings/models GET 只返回掩码，密钥永不回传', () => {
    const source = read('src/app/api/settings/models/route.ts');
    // 视图层只输出掩码与 hasKey 布尔
    assert.match(source, /function toConnectionView[\s\S]{0,600}maskedKey: mask\(plain\)/);
    assert.match(source, /hasKey: Boolean\(plain\)/);
    assert.doesNotMatch(source, /apiKey:\s*(plain|row\.api_key_encrypted)/);
    // 写路径同样按 tenant+business 收口
    assert.match(source, /record\.tenant_id = context\.tenantId/);
    assert.match(source, /record\.business_id = context\.businessId/);
  });

  test('credential access attempt：admin/providers 只暴露 keyConfigured 布尔，不泄露密文', () => {
    const source = read('src/app/api/admin/providers/route.ts');
    assert.match(source, /keyConfigured: Boolean\(row\.api_key_encrypted\)/);
    assert.doesNotMatch(source, /api_key_encrypted:[\s\S]*row/);
  });

  test('路由诊断（route-info / peekAIRoute）永不携带 apiKey', async () => {
    // peekAIRoute 只返回 diagnostics（provider/model/fallback/requestId），无凭据字段
    const route = await peekAIRoute('light', PLATFORM_AI_SCOPE);
    const payload = JSON.stringify(route);
    assert.ok(!payload.includes('apiKey'), 'diagnostics must not carry apiKey');
    assert.ok(!payload.includes('sk-'));
  });
});

// ---------------------------------------------------------------------------
// S4 — Internal Business Data Access Gate
// ---------------------------------------------------------------------------

describe('S4 internal business-data gate', () => {
  const baseParams = {
    campaign_title: 'Welcome back',
    subject: 'We miss you',
    body: 'Come back for a treat',
    customer_ids: ['customer-1'],
    language: 'en',
  };

  function approvalRow(overrides: Partial<CampaignApprovalRow> = {}): CampaignApprovalRow {
    return {
      id: 'approval-1',
      status: 'executing',
      execution_id: 'exec-1',
      agent: 'cmo',
      user_id: 'user-owner',
      tool_name: 'send_customer_recovery_campaign',
      action_type: 'roveagent.tool_call',
      arguments_hash: hashApprovalArguments(baseParams),
      ...overrides,
    };
  }

  test('审批绕过尝试 1：无 invocation_id 的群发请求被拒绝（403）', () => {
    const result = validateCampaignApprovalLinkage(approvalRow(), baseParams, '');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 403);
  });

  test('审批绕过尝试 2：invocation_id 无对应审批行的群发被拒绝（403）', () => {
    const result = validateCampaignApprovalLinkage(null, baseParams, 'inv-missing');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 403);
  });

  test('审批绕过尝试 3：审批行不是本工具（工具名/动作类型不符）被拒绝（409）', () => {
    const wrongTool = approvalRow({ tool_name: 'read_sales' });
    const result = validateCampaignApprovalLinkage(wrongTool, baseParams, 'inv-1');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 409);
  });

  test('审批绕过尝试 4：审批仍处 pending（尚未批准）被拒绝（409）', () => {
    const pending = approvalRow({ status: 'pending' });
    const result = validateCampaignApprovalLinkage(pending, baseParams, 'inv-1');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 409);
  });

  test('审批绕过尝试 5：批准后参数被篡改（hash 不一致）被拒绝（409）', () => {
    const tampered = { ...baseParams, customer_ids: ['customer-2'] };
    const result = validateCampaignApprovalLinkage(approvalRow(), tampered, 'inv-1');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 409);
  });

  test('合法链路：executing 状态 + 参数 hash 一致 → 放行并回填审批身份', () => {
    const result = validateCampaignApprovalLinkage(approvalRow(), baseParams, 'inv-1');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.approvalId, 'approval-1');
      assert.equal(result.executionId, 'exec-1');
      assert.equal(result.agentId, 'cmo');
      assert.equal(result.userId, 'user-owner');
    }
  });

  test('服务请求 HMAC：签名往返通过；篡改/过期/换密钥全部拒绝', () => {
    process.env.ROVEAGENT_APPROVAL_SECRET = 'gate-test-secret';
    const body = JSON.stringify({ tenant_id: 't', business_id: 'b', operation: 'read_sales', params: {} });
    const signed = signRoveAgentPayload(body);
    assert.equal(verifyRoveAgentPayload(body, signed.timestamp, signed.signature), true);
    // 篡改请求体
    assert.equal(verifyRoveAgentPayload(body + 'x', signed.timestamp, signed.signature), false);
    // 时钟超窗（±300s）
    const stale = signRoveAgentPayload(body, Math.floor(Date.now() / 1000) - 400);
    assert.equal(verifyRoveAgentPayload(body, stale.timestamp, stale.signature), false);
    // 换密钥后旧签名失效
    process.env.ROVEAGENT_APPROVAL_SECRET = 'other-secret';
    assert.equal(verifyRoveAgentPayload(body, signed.timestamp, signed.signature), false);
  });

  test('源码契约：internal business-data 强制 HMAC + 审批关联，且加入 proxy 公开白名单', () => {
    const source = read('src/app/api/internal/agent/business-data/route.ts');
    assert.match(source, /verifyRoveAgentPayload/);
    assert.match(source, /validateCampaignApprovalLinkage/);
    assert.match(source, /CampaignApprovalError/);
    assert.match(source, /timingSafeEqual/);
    assert.match(source, /assertBusinessScope\(tenantId, businessId\)/);
    assert.equal(isPublicApiPath('/api/internal/agent/business-data'), true);
  });
});

// ---------------------------------------------------------------------------
// S5 — SSRF Protection
// ---------------------------------------------------------------------------

describe('S5 SSRF protection', () => {
  test('SSRF bypass 尝试：metadata/loopback/私网/保留地址字面量全部拒绝', async () => {
    const blocked = [
      'http://169.254.169.254/latest/meta-data',
      'https://169.254.169.254/',
      'https://100.100.100.200/',
      'https://127.0.0.1:5432/',
      'https://10.1.2.3/',
      'https://172.16.0.1/',
      'https://192.168.0.1/',
      'https://100.64.0.1/',
      'https://[::1]/',
      'https://[::ffff:169.254.169.254]/',
      'https://[::ffff:127.0.0.1]/',
      'https://[fd00::1]/',
      'https://[fe80::1]/',
      'https://2130706433/', // 十进制 127.0.0.1
      'https://0177.0.0.1/', // 八进制 127.0.0.1
      'https://metadata.google.internal/',
    ];
    for (const url of blocked) {
      await assert.rejects(() => assertSafeOutboundUrl(url), /outbound_url_rejected/, url);
    }
  });

  test('SSRF bypass 尝试：DNS 重绑定域名静态拒绝（nip.io/sslip.io/xip.io）', async () => {
    for (const url of [
      'https://127.0.0.1.nip.io/',
      'https://169.254.169.254.nip.io/',
      'https://foo.sslip.io/',
      'https://foo.xip.io/',
      'https://foo.lvh.me/',
      'https://foo.internal/',
    ]) {
      await assert.rejects(() => assertSafeOutboundUrl(url), /outbound_url_rejected/, url);
    }
    assert.equal(isRebindingHostname('127.0.0.1.nip.io'), true);
    assert.equal(isRebindingHostname('api.openai.com'), false);
  });

  test('SSRF bypass 尝试：DNS 解析到 loopback 的域名被拒绝（localhost）', async () => {
    await assert.rejects(() => assertSafeOutboundUrl('https://localhost/'), /outbound_url_rejected/);
    const resolved = await checkBaseUrlResolved('https://localhost/v1', { production: true });
    assert.equal(resolved.ok, false);
  });

  test('checkBaseUrl 同步校验覆盖重绑定域名与 IP 变体（现有策略全保留）', () => {
    assert.equal(checkBaseUrl('https://127.0.0.1.nip.io/v1', { production: true }).ok, false);
    assert.equal(checkBaseUrl('https://2130706433/v1', { production: true }).ok, false);
    assert.equal(checkBaseUrl('https://[::1]/v1', { production: true }).ok, false);
    assert.equal(checkBaseUrl('https://[fd00::5]/v1', { production: true }).ok, false);
    assert.equal(checkBaseUrl('https://api.openai.com/v1', { production: true }).ok, true);
    assert.equal(checkBaseUrl('http://localhost:11434/v1', { production: false, allowLocal: true }).ok, true);
    assert.equal(checkBaseUrl('http://203.0.113.9/v1', { production: false, allowLocal: true }).ok, false);
  });

  test('公网 IP 字面量通过（无 DNS 依赖，离线确定性）', async () => {
    const okUrl = await assertSafeOutboundUrl('https://8.8.8.8/x');
    assert.equal(okUrl, 'https://8.8.8.8/x');
    assert.equal(isBlockedAddressLiteral('8.8.8.8'), false);
  });

  test('SSRF bypass 尝试：重定向到云 metadata 被逐跳复检拒绝', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: unknown) => {
        const url = String(input);
        if (url === 'https://8.8.8.8/start') {
          return new Response(null, {
            status: 302,
            headers: { location: 'http://169.254.169.254/latest/meta-data' },
          });
        }
        return new Response('should never be reached', { status: 200 });
      }) as typeof fetch;
      await assert.rejects(
        () => fetchWithOutboundGuard('https://8.8.8.8/start', {}),
        /outbound_url_rejected/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('GET 重定向到安全地址时正常跟随', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: unknown) => {
        const url = String(input);
        if (url === 'https://8.8.8.8/a') {
          return new Response(null, { status: 302, headers: { location: 'https://8.8.8.8/b' } });
        }
        return new Response('landed', { status: 200 });
      }) as typeof fetch;
      const resp = await fetchWithOutboundGuard('https://8.8.8.8/a', {});
      assert.equal(resp.status, 200);
      assert.equal(await resp.text(), 'landed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('POST 请求不跟随重定向（防凭据/正文被重放到任意目标）', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(null, { status: 302, headers: { location: 'https://8.8.8.8/x' } })) as typeof fetch;
      await assert.rejects(
        () => fetchWithOutboundGuard('https://8.8.8.8/api', { method: 'POST', body: '{"secret":1}' }),
        /redirect_after_mutation_blocked/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('源码契约：渠道 webhook 与集成测试全部接入出站守卫且错误不回显响应体', () => {
    const channels = read('src/lib/channels.ts');
    assert.match(channels, /fetchWithOutboundGuard/);
    assert.doesNotMatch(channels, /Webhook \$\{resp\.status\}: \$\{await resp\.text\(\)\}/);
    const integrations = read('src/app/api/integrations/test/route.ts');
    assert.match(integrations, /fetchWithOutboundGuard/);
    // AI 路由图片抓取接入守卫
    const routerSource = read('src/lib/ai/router.ts');
    assert.match(routerSource, /assertSafeOutboundUrl\(url/);
    assert.match(routerSource, /MAX_IMAGE_BYTES/);
  });

  test('IPv6 展开与映射地址判定', () => {
    assert.deepEqual(expandIpv6('::1'), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    const mapped = expandIpv6('::ffff:169.254.169.254');
    assert.ok(mapped);
    assert.equal(isBlockedAddressLiteral('[::ffff:169.254.169.254]'), true);
    assert.equal(isBlockedAddressLiteral('fd00::1'), true);
    assert.equal(isBlockedAddressLiteral('fe80::1'), true);
  });
});

// ---------------------------------------------------------------------------
// Unauthorized tool call（TS Agent Tool Registry）
// ---------------------------------------------------------------------------

describe('unauthorized tool call (Agent Tool Registry)', () => {
  test('staff 用户调用需要 reviews:read 的工具被拒绝（same business / different user 权限边界）', async () => {
    registerDefaultReadTools();
    const staffContext = makeToolContext({ userId: 'user-staff', role: 'staff' });
    const result = await agentToolRegistry.execute('reviews.get_negative_trend', {}, staffContext);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'forbidden');

    // 同 business 下不同用户：staff 与 manager 可见工具集不同（模型工具面收敛）
    const staffTools = agentToolRegistry.modelTools('staff').map((tool) => tool.name);
    const managerTools = agentToolRegistry.modelTools('manager').map((tool) => tool.name);
    assert.ok(!staffTools.includes('reviews.get_negative_trend'));
    assert.ok(managerTools.includes('reviews.get_negative_trend'));
  });

  test('缺少可信上下文（business 缺失）时 fail-closed 阻断', async () => {
    registerDefaultReadTools();
    const brokenContext = makeToolContext({ businessId: '' });
    const result = await agentToolRegistry.execute('analytics.get_sales_summary', { period: 'today' }, brokenContext);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'missing_context');
  });

  test('未知工具被拒绝（不落入任何执行路径）', async () => {
    registerDefaultReadTools();
    const result = await agentToolRegistry.execute('tools.terminal', {}, makeToolContext());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'tool_not_found');
  });
});
