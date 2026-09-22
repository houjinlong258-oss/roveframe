import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 18 审计 —— 演示数据必须在**界面上**看得出来。
 *
 * ## 被修的是什么
 *
 * `/api/dashboard` 在演示模式（`RF_E2E_DEMO=1` 且非生产）下返回的整套数字是
 * **编造的**（`Math.round((18 + i * 0.6) * ...)`），并带 `demo: true`。
 *
 * 实测：那个字段在页面类型里声明了、接口也一直在返回，但**页面从来没有读过它**。
 * 也就是说演示数据与真实经营数据在界面上完全一样 —— 一张截图被当成经营事实
 * 传出去，正好是 Phase 16 任务 1 修掉的那类问题（"仪表盘在零数据账户上编造
 * 增长数字"）的另一副面孔。
 *
 * 修法不是在接口层删演示模式（它是刻意的 E2E / 截图能力，且有双重门控），
 * 而是让**看到它的人知道自己在看什么**。
 *
 * ## 三条不变量
 *
 *   1. 接口在演示分支返回 `demo: true`（否则界面无从判断）；
 *   2. 页面读这个标记，并渲染一条**显式**的横幅；
 *   3. 横幅文案三语齐备（缺一个语言的键 = 那个语言的商家看到 MISSING_MESSAGE）。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const messages = (locale: string) =>
  JSON.parse(read(`messages/${locale}.json`)) as { dashboard: Record<string, string> };

describe('演示数据横幅', () => {
  test('接口的演示分支带回 demo: true', () => {
    const route = read('src/app/api/dashboard/route.ts');
    const demoFn = route.slice(route.indexOf('function buildDemoDashboard'));
    assert.match(demoFn, /demo: true/, '演示载荷必须自带标记，否则界面无从判断');
  });

  test('页面读这个标记（而不是声明了却不用）', () => {
    const page = read('src/app/[locale]/dashboard/page.tsx');
    assert.match(page, /const isDemoData = data\?\.demo === true;/);
    assert.match(page, /\{isDemoData && \(/, '读了标记却没有据此渲染任何东西');
  });

  test('负向对照：把横幅条件改成恒假，上面第二条必须失败', () => {
    const page = read('src/app/[locale]/dashboard/page.tsx');
    const mutated = page.replace('{isDemoData && (', '{false && (');
    assert.doesNotMatch(mutated, /\{isDemoData && \(/);
    assert.match(page, /\{isDemoData && \(/);
  });

  test('横幅是显式的（不是低调的灰字）：带 role=status 与警示样式', () => {
    const page = read('src/app/[locale]/dashboard/page.tsx');
    const banner = page.slice(page.indexOf('演示数据横幅'), page.indexOf('关键指标 InsightCards'));
    assert.match(banner, /role="status"/, '演示横幅必须能被辅助技术读到');
    assert.match(banner, /amber/, '应当是警示色 —— 演示数据不该看起来像正常内容');
    assert.match(banner, /t\('demoBadge'\)/);
    assert.match(banner, /t\('demoNotice'\)/);
  });

  test('三语文案齐备（缺一个语言的键 = 那个语言看到 MISSING_MESSAGE）', () => {
    for (const locale of ['en', 'zh', 'es']) {
      const dash = messages(locale).dashboard;
      assert.ok(dash.demoBadge, `${locale} 缺 dashboard.demoBadge`);
      assert.ok(dash.demoNotice, `${locale} 缺 dashboard.demoNotice`);
      assert.ok(dash.demoBadge.length > 5, `${locale} 的 demoBadge 太短`);
      assert.ok(dash.demoNotice.length > 20, `${locale} 的 demoNotice 太短`);
    }
    // 负向对照：键名写错时上面必须失败
    assert.equal(messages('en').dashboard.demoBadgeX, undefined);
  });

  test('三语的 demoBadge 互不相同（防止复制粘贴时忘了翻译）', () => {
    const badges = ['en', 'zh', 'es'].map((l) => messages(l).dashboard.demoBadge);
    assert.equal(new Set(badges).size, 3, `三个语言的 demoBadge 应各不相同，实际: ${JSON.stringify(badges)}`);
  });

  test('演示分支仍有双重门控（横幅不能替代门控）', () => {
    const route = read('src/app/api/dashboard/route.ts');
    assert.match(route, /RF_E2E_DEMO === '1' && process\.env\.COZE_PROJECT_ENV !== 'PROD'/);
  });
});
