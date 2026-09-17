import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Phase 15 —— 平台内置模型回落的行为契约。
 *
 * ## 被守住的行为
 *
 * 在自部署 compose 下，`COZE_API_TOKEN` 从不注入，而 `platformResolution()`
 * 原本无条件返回 `kind:"platform"`，实际执行走 `coze-coding-dev-sdk` 的
 * `LLMClient(new Config())` —— 于是抛 SDK 的原始报错
 * `API key is required. Set COZE_API_TOKEN or provide apiKey in config`。
 *
 * 触发它的路径是**常态**而非边缘情况：`/api/auth/signup` 不建 `settings` 行，
 * 新商家的 `model_assign` 视为 `auto`，必然落到这条分支。
 *
 * 现在有三条明确分支，本文件逐条断言：
 *   1. 配置了 ROVEFRAME_PLATFORM_LLM_* → 走 external（OpenAI 兼容）通路；
 *   2. 未配置且无 COZE_API_TOKEN → 抛 AIError(no_provider)，**message 可操作**；
 *   3. 有 COZE_API_TOKEN → 保持原有 kind:"platform" 行为。
 *
 * ## 为什么不做网络调用
 *
 * 两条分支的判定都发生在解析阶段，不需要真的连 provider。这里断言的是
 * **解析结果**（kind / provider / baseUrl / protocol）与**错误语义**，
 * 那是代码负责的部分；能不能连上 DeepSeek 是账户问题，不是这里的事。
 */

const ENV_KEYS = [
  'ROVEFRAME_PLATFORM_LLM_API_KEY',
  'ROVEFRAME_PLATFORM_LLM_BASE_URL',
  'ROVEFRAME_PLATFORM_LLM_MODEL',
  'COZE_API_TOKEN',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function loadRouter() {
  // 路由模块在导入期读环境变量不敏感，这里每次重新取导出即可。
  return import('../src/lib/ai/router');
}

describe('platform fallback credential wiring (Phase 15)', () => {
  test('未配置任何平台凭据 → resolvePlatformModel 返回 null（候选不可用）', async () => {
    const { resolvePlatformModel } = await loadRouter();
    assert.equal(
      resolvePlatformModel('light', 'test-req-1'), null,
      '不可用时必须返回 null，让故障切换链跳过并记录；抛错会打断整条链',
    );
  });

  test('直连路径不可用时抛 no_provider，且 message 可操作、不含 SDK 文案', async () => {
    // 直连路径没有别的候选：必须 fail-closed，并给出能照着修的说明。
    const { invokeChat } = await loadRouter();
    let caught: unknown = null;
    try {
      // 无 scope → 平台级；平台凭据缺失 → 应当在解析阶段就抛
      await invokeChat('light', [{ role: 'user', content: 'ping' }], {});
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, '直连路径必须在解析阶段抛错，而不是留给 SDK');
    const e = caught as { code?: string; message?: string };
    assert.equal(e.code, 'no_provider', `期望 code=no_provider，实际 ${String(e.code)}`);
    assert.match(String(e.message), /尚未配置 AI 服务商/);
    assert.doesNotMatch(
      String(e.message), /COZE_API_TOKEN or provide apiKey in config/,
      '又透出了 SDK 原始报错 —— 面向老板的提示必须说明该怎么修',
    );
  });

  test('配置了 ROVEFRAME_PLATFORM_LLM_* → 走 external OpenAI 兼容通路', async () => {
    process.env.ROVEFRAME_PLATFORM_LLM_API_KEY = 'test-key-not-real';
    process.env.ROVEFRAME_PLATFORM_LLM_BASE_URL = 'https://api.example.com/v1';
    const { resolvePlatformModel } = await loadRouter();

    const res = resolvePlatformModel('light', 'test-req-2');
    assert.ok(res, '配置齐备时必须可用');
    assert.equal(res.resolved.kind, 'external');
    assert.equal(res.resolved.provider, 'platform');
    assert.equal(res.resolved.protocol, 'openai');
    assert.equal(res.resolved.baseUrl, 'https://api.example.com/v1');
    assert.equal(res.resolved.apiKey, 'test-key-not-real');
    assert.equal(res.diagnostics.provider, 'platform');
  });

  test('ROVEFRAME_PLATFORM_LLM_MODEL 可覆盖 auto 路由选择的模型', async () => {
    process.env.ROVEFRAME_PLATFORM_LLM_API_KEY = 'k';
    process.env.ROVEFRAME_PLATFORM_LLM_BASE_URL = 'https://api.example.com/v1';
    process.env.ROVEFRAME_PLATFORM_LLM_MODEL = 'my-self-hosted-model';
    const { resolvePlatformModel } = await loadRouter();

    const res = resolvePlatformModel('light', 'test-req-3');
    assert.ok(res);
    assert.equal(res.resolved.model, 'my-self-hosted-model');
  });

  test('只设了一半（缺 base URL）→ 视为未配置，返回 null', async () => {
    process.env.ROVEFRAME_PLATFORM_LLM_API_KEY = 'k';
    // 故意不设 BASE_URL
    const { resolvePlatformModel } = await loadRouter();
    assert.equal(
      resolvePlatformModel('light', 'test-req-4'), null,
      '半配置必须 fail-closed，不能拿着空 baseUrl 去发请求',
    );
  });

  test('有 COZE_API_TOKEN → 保持原有 kind:platform 行为', async () => {
    process.env.COZE_API_TOKEN = 'platform-token-not-real';
    const { resolvePlatformModel } = await loadRouter();
    const res = resolvePlatformModel('light', 'test-req-5');
    assert.ok(res, 'COZE_API_TOKEN 存在时应走 SDK 通路');
    assert.equal(res.resolved.kind, 'platform');
    assert.equal(res.diagnostics.kind, 'platform');
  });

  test('自部署 base URL 未通过安全校验 → ssrf_blocked（配置错误必须显式报错，不静默跳过）', async () => {
    process.env.ROVEFRAME_PLATFORM_LLM_API_KEY = 'k';
    // 私网地址：应当被 checkBaseUrl 拒绝
    process.env.ROVEFRAME_PLATFORM_LLM_BASE_URL = 'http://169.254.169.254/latest/meta-data';
    const { resolvePlatformModel } = await loadRouter();
    assert.throws(
      () => resolvePlatformModel('light', 'test-req-6'),
      (err: unknown) => (err as { code?: string }).code === 'ssrf_blocked',
      '自部署凭据不得绕过 base URL 安全校验',
    );
  });

  test('故障切换链：平台不可用时记进 skipped，而非抛错打断', async () => {
    const { resolveModelChain } = await import('../src/lib/ai/failover');
    const chain = await resolveModelChain('agent', null, null);
    assert.equal(
      chain.candidates.length, 0,
      '没有任何可用候选时，candidates 应为空 —— 由 AllProvidersFailedError 统一汇报',
    );
    assert.ok(
      chain.skipped.some((s) => s.provider === 'platform' && s.reason === 'not_configured'),
      `平台应被记为 skipped(not_configured)，实际: ${JSON.stringify(chain.skipped)}`,
    );
  });
});
