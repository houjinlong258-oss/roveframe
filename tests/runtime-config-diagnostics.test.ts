import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { roveAgentConfigDetail, roveAgentConfigGaps } from '../src/lib/roveagent/client';

/**
 * 「未配置」的报错必须**点名缺哪个变量**。
 *
 * ## 为什么这是一条正经守卫，而不是文案洁癖
 *
 * 实测（2026-09-25）：老板的实例只缺 `ROVEAGENT_API_URL` 一个变量，界面上却只说
 * "roveagent runtime not configured"。后果不是"看不清"，而是**被误判成产品缺陷**：
 * 对方的 AI 据此输出了一份"系统处于只读不写状态"的自检报告，建议新建
 * `backend/services/model_provider.py`、安装 moviepy 等 —— 而这些要么在这套代码里
 * 不存在，要么早已实现并实测通过（PDF/DOCX/XLSX/PPTX/HTML/ZIP/图片/视频）。
 *
 * 一句话含糊的报错，换来一份错误的工单。所以：缺哪个变量就要写出来。
 */

function withEnv(
  patch: Partial<Record<'ROVEAGENT_API_URL' | 'ROVEAGENT_API_KEY', string | undefined>>,
  run: () => void,
): void {
  const keys = ['ROVEAGENT_API_URL', 'ROVEAGENT_API_KEY'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]])) as Record<string, string | undefined>;
  try {
    for (const key of keys) {
      const value = patch[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('配置缺口的诊断信息', () => {
  test('两者齐备时没有缺口，详情为空串', () => {
    withEnv({ ROVEAGENT_API_URL: 'http://127.0.0.1:8788', ROVEAGENT_API_KEY: 'k' }, () => {
      assert.deepEqual(roveAgentConfigGaps(), []);
      assert.equal(roveAgentConfigDetail(), '', '齐备时不该报缺口');
    });
  });

  test('缺 URL 时点名 ROVEAGENT_API_URL', () => {
    withEnv({ ROVEAGENT_API_URL: undefined, ROVEAGENT_API_KEY: 'k' }, () => {
      assert.equal(roveAgentConfigDetail(), 'missing ROVEAGENT_API_URL');
    });
  });

  test('缺 KEY 时点名 ROVEAGENT_API_KEY', () => {
    withEnv({ ROVEAGENT_API_URL: 'http://127.0.0.1:8788', ROVEAGENT_API_KEY: undefined }, () => {
      assert.equal(roveAgentConfigDetail(), 'missing ROVEAGENT_API_KEY');
    });
  });

  test('两个都缺时都点名', () => {
    withEnv({ ROVEAGENT_API_URL: undefined, ROVEAGENT_API_KEY: undefined }, () => {
      assert.equal(roveAgentConfigDetail(), 'missing ROVEAGENT_API_URL, ROVEAGENT_API_KEY');
    });
  });

  test('信息里不得包含密钥值（只报变量名）', () => {
    withEnv({ ROVEAGENT_API_URL: undefined, ROVEAGENT_API_KEY: 'super-secret-value' }, () => {
      const detail = roveAgentConfigDetail();
      assert.equal(detail.includes('super-secret-value'), false, '诊断信息绝不能带出密钥值');
      // 此时缺的是 URL，所以点名的应当是 URL；KEY 存在就不该出现在缺口里
      assert.match(detail, /ROVEAGENT_API_URL/, '必须点名真正缺的那个变量');
      assert.equal(detail.includes('ROVEAGENT_API_KEY'), false, '已配置的变量不该被报成缺口');
    });
  });
});

describe('聊天路由必须用带变量的版本（静态守卫）', () => {
  const route = readFileSync(join(process.cwd(), 'src/app/api/agent/chat/route.ts'), 'utf8');

  /**
   * 是否还残留"只说未配置、不点名变量"的硬编码写法。
   *
   * 只匹配**旧的两种用法形状**（直接当 detail 值用），不匹配 helper 内部的兜底分支
   * —— 那是变量齐备时的防御性返回，不是本条守卫要拦的东西。
   * 由下面的自证用例证明它能返回 true，否则是空断言。
   */
  function hasVagueHardcode(src: string): boolean {
    return /detail: 'roveagent runtime not configured'/.test(src)
      || /runtimeFailureMessage = 'roveagent runtime not configured'/.test(src);
  }

  test('不再出现硬编码的含糊版本', () => {
    assert.equal(
      hasVagueHardcode(route),
      false,
      "聊天路由不得再硬编码 'roveagent runtime not configured' 当作 detail —— " +
        '必须走 helper 把缺的变量名带出来',
    );
  });

  test('三处都改用了带细节的 helper', () => {
    const uses = (route.match(/runtimeNotConfiguredDetail\(\)/g) ?? []).length;
    assert.ok(uses >= 3, `应有 3 处使用（默认 fallback + 分类为工具类请求的两处），实际 ${uses} 处`);
  });

  test('helper 本身拼接了 roveAgentConfigDetail', () => {
    assert.match(
      route,
      /runtimeNotConfiguredDetail[\s\S]{0,200}roveAgentConfigDetail\(\)/,
      'helper 必须真的去取缺口信息，而不是自己再编一句',
    );
  });

  test('负向对照：检测器能把硬编码的含糊写法判出来', () => {
    const vague = "runtimeStatus = { mode: 'unavailable', detail: 'roveagent runtime not configured' };";
    assert.equal(hasVagueHardcode(vague), true, '检测器必须能识别残留的硬编码写法');
    const detailed = 'detail: runtimeNotConfiguredDetail()';
    assert.equal(hasVagueHardcode(detailed), false, '检测器不得把正确写法误判为违规');
  });
});
