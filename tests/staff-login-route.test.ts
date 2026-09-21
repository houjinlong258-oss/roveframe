import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 18 §4.3（用户决策）—— `/{locale}/staff/login` 是独立路由。
 *
 * ## 规格与实现的偏离
 *
 * 规格里员工登录是独立路由，实现只有 `/{locale}/auth/login` 一个页面。
 * 现在按规格补上，但**不复制页面**：两条路复用同一个 `StaffLoginForm`，
 * 差别只有默认入口与是否显示注册链接。
 *
 * 复制一份登录页面来改是最省事的做法，代价是"登录逻辑"从此有两份，
 * 之后每次改动都要改两处 —— 这个仓库已经因为"同一件事两条路径"
 * （UI 判定 vs worker 判定）修过两次。
 *
 * ## 守住的失败模式
 *
 *   1. 员工登录页又出现"注册"链接 —— 注册会建**新租户 + 新商家**，
 *      员工点进去只会开出一家空店，而他要做的是加入现有门店；
 *   2. 两条路各自实现登录逻辑（复制粘贴）—— 用 import 关系断言，而不是靠自觉；
 *   3. 登出后回到老板侧登录页 —— 员工会以为自己走错了入口。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const exists = (rel: string) => existsSync(join(ROOT, rel));

describe('员工登录独立路由', () => {
  test('路由文件存在', () => {
    assert.ok(
      exists('src/app/[locale]/staff/login/page.tsx'),
      '规格要求的 /{locale}/staff/login 不存在',
    );
  });

  test('它复用同一个表单组件（不是复制一份登录逻辑）', () => {
    const page = read('src/app/[locale]/staff/login/page.tsx');
    assert.match(page, /from '@\/components\/auth\/staff-login-form'/);
    assert.match(page, /<StaffLoginForm/);
    assert.match(page, /defaultEntry="staff"/);
    assert.match(page, /showSignupLink=\{false\}/);
  });

  test('老板端登录页也复用同一组件（否则就是两份实现）', () => {
    const ownerPage = read('src/app/[locale]/auth/login/page.tsx');
    assert.match(ownerPage, /from '@\/components\/auth\/staff-login-form'/);
    // 负向对照：老板端登录页不该自己再写一遍密码输入与 login 调用
    assert.doesNotMatch(ownerPage, /useSession\(\)/);
    assert.doesNotMatch(ownerPage, /type="password"/);
  });

  test('表单组件里注册链接由参数控制，且员工端关掉它', () => {
    const form = read('src/components/auth/staff-login-form.tsx');
    assert.match(form, /showSignupLink\?: boolean/);
    assert.match(form, /\{showSignupLink && \(/);
  });

  test('locale 段在服务端校验（非法 locale 404，与 /staff 同一形态）', () => {
    const page = read('src/app/[locale]/staff/login/page.tsx');
    assert.match(page, /hasLocale\(routing\.locales, locale\)/);
    assert.match(page, /notFound\(\)/);
  });

  test('员工登出回落到员工登录页，而不是老板登录页', () => {
    const pwa = read('src/components/staff/StaffPwa.tsx');
    assert.match(pwa, /window\.location\.assign\(`\/\$\{locale\}\/staff\/login`\)/);
    // 负向对照：这正是修之前的写法
    assert.doesNotMatch(pwa, /window\.location\.assign\(`\/\$\{locale\}\/auth\/login`\)/);
  });

  test('深链 ?entry= 可覆盖默认入口（员工存书签时用得上）', () => {
    const form = read('src/components/auth/staff-login-form.tsx');
    assert.match(form, /function getEntryParam/);
    assert.match(form, /value === 'staff' \|\| value === 'owner'/);
  });
});

describe('负向对照：这些断言能失败', () => {
  test('把 showSignupLink 反过来写会被上面第 4 条拒绝', () => {
    const synthetic = '<StaffLoginForm defaultEntry="staff" showSignupLink={true} />';
    assert.doesNotMatch(synthetic, /showSignupLink=\{false\}/);
  });

  test('复制一份页面而不是 import 组件会被上面第 2 条拒绝', () => {
    const synthetic = "'use client';\nimport { useSession } from '@/hooks/use-session';\nexport default function P(){ return null }";
    assert.doesNotMatch(synthetic, /from '@\/components\/auth\/staff-login-form'/);
  });
});
