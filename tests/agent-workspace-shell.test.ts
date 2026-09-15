import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 工作台外壳的契约测试。
 *
 * 这两条都来自 **真实浏览器验证（Playwright）** 抓到的缺陷，
 * 静态类型检查完全看不出来 —— 所以必须固化成测试。
 */

const read = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf8');

test('workspace panels use unit-suffixed sizes, never bare numbers', () => {
  const page = read('src/app/[locale]/agent/page.tsx');
  // 回归：react-resizable-panels v4 把裸数字当 px，
  // defaultSize={20} 得到的是 20 像素宽的面板（实测 20px），必须写 "20%"。
  const bareNumbers = [...page.matchAll(/(?:default|min|max)Size=\{(\d+)\}/g)];
  assert.equal(
    bareNumbers.length,
    0,
    `panel sizes must be unit strings like "20%", found bare numbers: ${bareNumbers.map((m) => m[0]).join(', ')}`,
  );
  assert.match(page, /defaultSize="\d+%"/);
  assert.match(page, /minSize="\d+%"/);
});

test('workspace panel component only accepts unit strings', () => {
  const panels = read('src/components/workspace/panels.tsx');
  assert.match(panels, /defaultSize\?: string;/);
  assert.match(panels, /minSize\?: string;/);
  assert.match(panels, /maxSize\?: string;/);
  // 类型注释里必须留痕，避免以后有人「顺手」改回 number
  assert.match(panels, /v4 把裸数字当作 `px`/);
});

test('layout storage is never undefined (SSR crash regression)', () => {
  const panels = read('src/components/workspace/panels.tsx');
  // 回归：把 undefined 传给 useDefaultLayout 会在 SSR 抛
  // 「Cannot read properties of undefined (reading 'getItem')」，
  // Next 退化成纯客户端渲染并打 page error。
  assert.doesNotMatch(panels, /storage:\s*undefined/);
  assert.match(panels, /storage: LAYOUT_STORAGE/);
  assert.match(panels, /function createLayoutStorage\(\)/);
  // 存储实现必须自己兜住 SSR 与隐私模式，不能把异常抛给渲染层
  assert.match(panels, /typeof window === 'undefined'/);
});

test('layout storage key is versioned so bad saved layouts are discarded', () => {
  const panels = read('src/components/workspace/panels.tsx');
  assert.match(panels, /roveframe\.workspace\.layout\.v\d+/);
});

test('the workspace exposes the four modes and keeps them persisted', () => {
  const types = read('src/components/workspace/types.ts');
  for (const mode of ['chat', 'tasks', 'files', 'insights']) {
    assert.ok(types.includes(`'${mode}'`), `missing mode ${mode}`);
  }
  assert.match(types, /isWorkspaceMode/);

  const page = read('src/app/[locale]/agent/page.tsx');
  assert.match(page, /MODE_STORAGE_KEY/);
  assert.match(page, /VISIBILITY_STORAGE_KEY/);
  assert.match(page, /PINNED_STORAGE_KEY/);
  // 面板可见性要能独立开关，并在隐藏后让主区占满
  assert.match(page, /togglePanel\('conversations'\)/);
  assert.match(page, /togglePanel\('command'\)/);
});

test('the app shell wires the sidebar collapse shortcut', () => {
  const shell = read('src/components/layout/app-shell.tsx');
  assert.match(shell, /event\.key\.toLowerCase\(\) !== 'b'/);
  assert.match(shell, /event\.ctrlKey \|\| event\.metaKey/);
  // 在输入框里按快捷键不能抢走打字
  assert.match(shell, /tag === 'textarea'/);
  assert.match(shell, /roveframe\.sidebar\.collapsed/);

  const sidebar = read('src/components/layout/sidebar.tsx');
  assert.match(sidebar, /collapsed \? 'w-14' : 'w-60'/);
  // 折叠态必须有可发现的提示（原生 title 即可，不引额外浮层依赖）
  assert.match(sidebar, /title=\{collapsed \? t\(key\) : undefined\}/);
});

test('mobile keeps a full-screen workspace with bottom navigation', () => {
  const page = read('src/app/[locale]/agent/page.tsx');
  assert.match(page, /<MobileNav/);
  assert.match(page, /useIsMobile\(\)/);
  // 手机上不做三栏挤压：走抽屉
  assert.match(page, /mobileSidebar/);
  assert.match(page, /mobileCommand/);

  const nav = read('src/components/workspace/mobile-nav.tsx');
  assert.match(nav, /safe-area-inset-bottom/);
});
