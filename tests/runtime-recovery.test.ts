/**
 * Step 3.1 验收测试 —— Runtime 状态体验收尾。
 *
 * 对应你给的 4 项验收：
 *   1. 正常运行时间 → 无 banner
 *   2. 后备方案     → 显示警告
 *   3. 不可用       → 显示 retry
 *   4. retry 成功   → 恢复
 *
 * 测试的是 `@/lib/agent/runtime-availability` 里的**纯函数** ——
 * 组件的展示决策全部由它们决定，组件本身只做渲染。
 * 这样无需 DOM 测试环境即可覆盖全部 4 项，且不引入新依赖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyProbeResult,
  bannerKindFor,
  canSendInBasicMode,
  detailAfterProbe,
  isRecoverable,
  presentRuntime,
  runtimeModeAfterProbe,
  shouldShowBanner,
} from '../src/lib/agent/runtime-availability';

/* -------------------------------------------------------------------------- */
/* 测试 1：正常运行 → 无 banner                                                 */
/* -------------------------------------------------------------------------- */

test('测试1 正常运行时间：roveagent 模式不显示任何 banner', () => {
  const view = presentRuntime({ mode: 'roveagent', detail: 'agent=developer' });
  assert.equal(view.kind, 'none');
  assert.equal(view.visible, false, 'roveagent 必须隐藏 —— 正常路径不该有视觉噪音');
  assert.equal(shouldShowBanner('roveagent'), false);
});

test('测试1 缺省/空状态也不显示 banner', () => {
  for (const status of [undefined, null, { mode: undefined as never }]) {
    assert.equal(presentRuntime(status).visible, false);
  }
});

/* -------------------------------------------------------------------------- */
/* 测试 2：后备方案 → 显示警告                                                   */
/* -------------------------------------------------------------------------- */

test('测试2 后备方案：fallback 显示警告（不是错误）', () => {
  const view = presentRuntime({ mode: 'fallback', detail: 'connection refused' });
  assert.equal(view.kind, 'warning');
  assert.equal(view.visible, true);
  assert.equal(bannerKindFor('fallback'), 'warning');
});

test('测试2 fallback 不提供恢复按钮（它本身可用，只是能力受限）', () => {
  assert.equal(isRecoverable('fallback'), false);
  assert.equal(presentRuntime({ mode: 'fallback' }).recoverable, false);
});

test('测试2 fallback 保留原因供展示', () => {
  const view = presentRuntime({ mode: 'fallback', detail: '  ECONNREFUSED  ' });
  assert.equal(view.detail, 'ECONNREFUSED', '原因应去空白');
});

/* -------------------------------------------------------------------------- */
/* 测试 3：不可用 → 显示 retry                                                   */
/* -------------------------------------------------------------------------- */

test('测试3 不可用：unavailable 显示错误且可恢复（retry 可用）', () => {
  const view = presentRuntime({ mode: 'unavailable', detail: 'unreachable' });
  assert.equal(view.kind, 'error');
  assert.equal(view.visible, true);
  assert.equal(view.recoverable, true, 'unavailable 必须提供恢复入口');
  assert.equal(isRecoverable('unavailable'), true);
});

test('测试3 不可用时原因被保留（供展示）', () => {
  const view = presentRuntime({ mode: 'unavailable', detail: 'unconfigured: missing ROVEAGENT_API_KEY' });
  assert.match(view.detail, /ROVEAGENT_API_KEY/);
});

/* -------------------------------------------------------------------------- */
/* 测试 4：retry 成功 → 恢复                                                     */
/* -------------------------------------------------------------------------- */

test('测试4 retry 成功：状态恢复为 roveagent，banner 消失', () => {
  const before = presentRuntime({ mode: 'unavailable', detail: 'ECONNREFUSED' });
  assert.equal(before.visible, true);

  const applied = applyProbeResult(
    { mode: 'unavailable', detail: 'ECONNREFUSED' },
    { ok: true, detail: '' },
  );
  assert.equal(applied.mode, 'roveagent');

  const after = presentRuntime(applied);
  assert.equal(after.visible, false, '恢复后 banner 必须消失');
  assert.equal(after.kind, 'none');
});

test('测试4 retry 失败：保持错误，且原因不丢', () => {
  const applied = applyProbeResult(
    { mode: 'unavailable', detail: 'ECONNREFUSED' },
    { ok: false, detail: 'unreachable: fetch failed' },
  );
  assert.equal(applied.mode, 'unavailable', '失败必须保持错误，不得谎报恢复');
  assert.equal(applied.detail, 'unreachable: fetch failed');

  const view = presentRuntime(applied);
  assert.equal(view.kind, 'error');
  assert.equal(view.recoverable, true, '失败后仍应可再次 retry');
});

test('测试4 retry 失败但无新原因时，沿用旧原因', () => {
  const applied = applyProbeResult(
    { mode: 'unavailable', detail: 'previous reason' },
    { ok: false, detail: '' },
  );
  assert.equal(applied.mode, 'unavailable');
  assert.equal(applied.detail, 'previous reason');
});

test('测试4 探测结果映射：ok → roveagent，!ok → unavailable', () => {
  assert.equal(runtimeModeAfterProbe(true), 'roveagent');
  assert.equal(runtimeModeAfterProbe(false), 'unavailable');
});

test('测试4 detailAfterProbe：成功清空原因，失败保留原因', () => {
  assert.equal(detailAfterProbe({ ok: true, detail: 'whatever' }, 'old'), '');
  assert.equal(detailAfterProbe({ ok: false, detail: 'new' }, 'old'), 'new');
  assert.equal(detailAfterProbe({ ok: false, detail: '' }, 'old'), 'old');
  assert.equal(detailAfterProbe({ ok: false, detail: '' }, undefined), 'runtime unreachable');
});

/* -------------------------------------------------------------------------- */
/* 任务 1 附加：基础模式只允许普通聊天（禁止 tool_execution 后备方案）              */
/* -------------------------------------------------------------------------- */

test('基础模式允许普通聊天', () => {
  assert.equal(canSendInBasicMode('chat'), true);
});

test('基础模式禁止一切工具类请求（不提供后备方案）', () => {
  assert.equal(
    canSendInBasicMode('tool_execution'),
    false,
    '基础模式必须拒绝工具任务 —— 放行等于假装执行',
  );
});

/* -------------------------------------------------------------------------- */
/* 状态机不变量                                                                  */
/* -------------------------------------------------------------------------- */

test('bannerKindFor 覆盖全部 mode 且无遗漏', () => {
  assert.equal(bannerKindFor('roveagent'), 'none');
  assert.equal(bannerKindFor('fallback'), 'warning');
  assert.equal(bannerKindFor('unavailable'), 'error');
  assert.equal(bannerKindFor(undefined), 'none');
  assert.equal(bannerKindFor(null), 'none');
});

test('visible 与 kind 始终一致（组件依赖的不变量）', () => {
  for (const mode of ['roveagent', 'fallback', 'unavailable', undefined] as const) {
    const view = presentRuntime(mode ? { mode } : undefined);
    assert.equal(view.visible, view.kind !== 'none', `mode=${mode} 时 visible 与 kind 不一致`);
  }
});
