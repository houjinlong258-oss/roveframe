import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 账号接线守卫（Phase 18：老板反馈的四个"功能存在但够不着"缺口）。
 *
 * ## 为什么需要这个测试
 *
 * 这四个缺口全部是**纯接线遗漏**，不是逻辑错误 —— 也就是说类型检查、
 * lint、既有的 90 个测试套件没有一个是红的：
 *
 *   1. `POST /api/auth/logout` 在**任何 `.tsx`** 里都没有调用方
 *      （只有 `src/hooks/use-session.ts` 里一个从未被调用的 `logout()`），
 *      于是界面上根本没有"退出/切换账号"这个动作；
 *   2. 侧边栏没有 `/team` 入口 —— 老板端团队/考勤/关怀页只能靠手输 URL 打开；
 *   3. 设置页的分组列表里没有账号分组 —— 改密码、看自己是谁都没有落点；
 *   4. 登录页只有一个表单，没有老板 / 员工两个入口。
 *
 * 这类"删掉一个链接就能复发"的回归，只有**源码级**断言能钉住。
 *
 * ## 负向对照是硬要求
 *
 * 每个匹配器都必须能对"缺少该特性"的合成源码给出**否**的答案
 * （见每个 test 里的负向对照断言）。否则断言可能因为正则永远为真、
 * 或扫描了 0 个文件而**假通过** —— 那种测试比没有更糟。
 */

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

type SourceFile = { path: string; source: string };

/** 递归收集 `src/` 下的源码文件；`.tsx` 与 `.ts` 都收，筛选交给各个匹配器。 */
function collectSources(root: string, extension: string): SourceFile[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) return collectSources(absolute, extension);
    if (!entry.name.endsWith(extension)) return [];
    return [{ path: absolute, source: readFileSync(absolute, 'utf8') }];
  });
}

function read(...segments: string[]): string {
  return readFileSync(join(ROOT, ...segments), 'utf8');
}

/**
 * 去掉注释再匹配。
 *
 * 必要性有实测证据：改密码路由的注释里写了「不要换成 `getSupabaseClient()` 共享单例」，
 * 于是"是否用了共享单例"这条断言对着**注释**报了阳性（第一版测试就是这么红的）。
 * 契约说的是代码，不是散文。实现是朴素的（不解析字符串字面量），对本文件足够：
 * 断言涉及的标识符都不含 `//` 或 `/*`。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 同时接受单引号与双引号写法，避免断言被"引号风格"这种无关差异左右。 */
function includesKey(source: string, key: string): boolean {
  return source.includes(`'${key}'`) || source.includes(`"${key}"`);
}

// ---------------------------------------------------------------------------
// 匹配器（纯函数：真实源码与合成源码走**同一段**代码）
// ---------------------------------------------------------------------------

/** 调用了登出接口的 `.tsx`。空数组 = 退出登录在界面上不可达。 */
function tsxCallingLogout(files: SourceFile[]): string[] {
  return files
    .filter((file) => file.source.includes("'/api/auth/logout'") || file.source.includes('"/api/auth/logout"'))
    .map((file) => file.path);
}

/** 调用方是否检查了响应（`res.ok` / `response.ok`）。不检查 = 失败被静默吞掉。 */
function checksResponse(source: string): boolean {
  return /res(?:ponse)?\.ok/.test(source);
}

/**
 * 老板后台（顶栏 + 设置页）自己的登出入口。
 *
 * 注意为什么不能只断言"某个 .tsx 里存在调用"：实测（本次扫描）
 * **员工端 PWA 早就在调用这个接口了** —— `src/components/staff/StaffPwa.tsx:487`
 * 有自己的登出按钮，而且它检查了 `response.ok`。所以"全局至少一处调用"
 * 这个断言在修复前**也是绿的**，它钉不住老板后台的缺口。
 * 真正会复发的回归是"老板后台又没有退出入口了"，因此这里按文件点名。
 */
const OWNER_CONSOLE_CALLERS = [
  ['src', 'components', 'layout', 'topbar.tsx'],
  ['src', 'app', '[locale]', 'settings', 'page.tsx'],
] as const;

function logoutCallersAmong(entries: SourceFile[]): string[] {
  return entries
    .filter((entry) => entry.source.includes("'/api/auth/logout'"))
    .map((entry) => entry.path);
}

function ownerConsoleLogoutCallers(): string[] {
  return logoutCallersAmong(
    OWNER_CONSOLE_CALLERS.map((segments) => ({
      path: segments.join('/'),
      source: read(...segments),
    })),
  );
}

/** 侧边栏是否有指向 `/team` 的导航项。 */
function sidebarHasTeamEntry(source: string): boolean {
  return /href:\s*'\/team'/.test(source) && /key:\s*'team'/.test(source);
}

/** 设置页分组列表里的 key（只截取 `const groups` 那个数组字面量，避免匹配到别处的同名字符串）。 */
function settingsGroupKeys(source: string): string[] {
  const start = source.indexOf('const groups:');
  if (start < 0) return [];
  const end = source.indexOf('];', start);
  if (end < 0) return [];
  const block = source.slice(start, end);
  return Array.from(block.matchAll(/key:\s*'([a-zA-Z]+)'/g), (match) => match[1]).sort();
}

/** 登录页是否同时给出"老板"与"员工"两个入口。 */
function loginEntries(source: string): { owner: boolean; staff: boolean } {
  return {
    owner: includesKey(source, 'entryOwner'),
    staff: includesKey(source, 'entryStaff'),
  };
}

/** 登录后是否按**服务端返回的 role**分流，而不是按点过的标签。 */
function loginRedirectsByRole(source: string): boolean {
  return source.includes("role === 'staff'")
    && source.includes("return '/staff'")
    && source.includes("return '/dashboard'")
    // 分流用的必须是登录接口的返回值（res.role），不是入口标签
    && /login\(email, password\)/.test(source)
    && /postLoginTarget\(res\.role/.test(source);
}

/** 顶栏账号菜单：身份（邮箱 / 角色）+ 退出 + 失败可见。 */
function topbarAccountMenu(source: string): {
  identity: boolean;
  role: boolean;
  signsOut: boolean;
  failureVisible: boolean;
} {
  return {
    identity: source.includes('useSession') && source.includes('session?.email'),
    role: source.includes('roles.'),
    signsOut: source.includes("'/api/auth/logout'"),
    // 失败可见 = 有失败文案状态，并且只在响应 ok 时才跳转
    failureVisible: source.includes("ta('signOutFailed')") && source.includes('if (!res.ok)'),
  };
}

/** 设置页的改密码控件必须真的接到接口上（禁止死按钮）。 */
function changePasswordFormWired(source: string): boolean {
  const hasUi = source.includes("ta('updatePassword')");
  const posts = source.includes("'/api/auth/change-password'");
  return hasUi && posts;
}

/** 改密码路由的契约：验旧密码 / 全新 client / 目标是会话本人 / 走中心化守卫。 */
function changePasswordRoute(source: string): {
  verifiesCurrentPassword: boolean;
  freshClientOnly: boolean;
  sessionScopedTarget: boolean;
  centrallyGuarded: boolean;
} {
  const code = stripComments(source);
  return {
    verifiesCurrentPassword: code.includes('signInAndGetToken') && code.includes('current_password'),
    // 陷阱 8：碰 auth 会话的代码不得用共享单例 getSupabaseClient()
    freshClientOnly: code.includes('getFreshServiceClient') && !/\bgetSupabaseClient\(\)/.test(code),
    // 目标用户必须来自会话；从请求体取 user_id/email 等于给任意账号改密
    sessionScopedTarget: code.includes('updateUserById(user.userId')
      && !/body\.(user_id|user_email|email)/.test(code),
    centrallyGuarded: /export const POST = protect(?:Business|Tenant)Mutation\(\s*\{\s*permission:/.test(code),
  };
}

/** 三语文案里缺失的键（空串也算缺失：渲染出来是空白，看起来像翻译过了）。 */
function missingKeys(bundle: unknown, keys: string[]): string[] {
  return keys.filter((key) => {
    let current: unknown = bundle;
    for (const part of key.split('.')) {
      if (current === null || typeof current !== 'object') return true;
      current = (current as Record<string, unknown>)[part];
    }
    return typeof current !== 'string' || current.length === 0;
  });
}

const LOCALES = ['en', 'zh', 'es'] as const;

function loadBundle(locale: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, 'messages', `${locale}.json`), 'utf8')) as unknown;
}

// ---------------------------------------------------------------------------
// 1. 退出登录：必须有 `.tsx` 调用方
// ---------------------------------------------------------------------------

describe('账号接线：退出登录', () => {
  test('至少一个 .tsx 调用了 /api/auth/logout（且检查响应、失败可见）', () => {
    const tsxFiles = collectSources(SRC, '.tsx');
    // 扫描器自检：扫到的文件数太少说明遍历失效，那种情况下"0 命中"没有意义
    assert.ok(
      tsxFiles.length > 100,
      `只扫到 ${tsxFiles.length} 个 .tsx，扫描器可能失效（阳性对照不成立）`,
    );

    const callers = tsxCallingLogout(tsxFiles);
    assert.ok(
      callers.length > 0,
      '没有任何 .tsx 调用 /api/auth/logout —— 界面上又没有退出/切换账号的入口了',
    );

    // 调用方必须处理失败：静默 fetch 会让"清 cookie 失败"伪装成"已退出"
    const silent = callers.filter((path) => !checksResponse(readFileSync(path, 'utf8')));
    assert.deepEqual(silent, [], `这些调用方没有检查响应，失败会被静默吞掉：\n  ${silent.join('\n  ')}`);

    // 负向对照：同一匹配器对"不含该调用"的合成源码必须报缺失
    assert.deepEqual(
      tsxCallingLogout([{ path: 'synthetic.tsx', source: 'export function X() { return null }' }]),
      [],
      '匹配器对不含登出调用的源码也报"有"，负向对照失败',
    );
    assert.equal(checksResponse('await fetch(url, { method: "POST" })'), false);
    assert.equal(checksResponse('if (!response.ok) throw new Error("x")'), true);
  });

  test('老板后台（顶栏 / 设置页）自己有登出入口 —— 这才是会复发的那一条', () => {
    const callers = ownerConsoleLogoutCallers();
    assert.ok(
      callers.length > 0,
      '顶栏与设置页都没有登出入口 —— 老板后台又只能靠员工端 PWA 或清 cookie 才能换账号',
    );

    // 负向对照：同一段判定套在"只有语言切换"的后台组件上必须为空
    assert.deepEqual(
      logoutCallersAmong([
        { path: 'synthetic-topbar.tsx', source: 'const x = <DropdownMenu>{locales.map((l) => <Item />)}</DropdownMenu>' },
        { path: 'synthetic-settings.tsx', source: 'const groups = [{ key: "business" }]' },
      ]),
      [],
      '匹配器对没有登出调用的后台组件也报"有"，负向对照失败',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. 侧边栏 `/team` 入口
// ---------------------------------------------------------------------------

describe('账号接线：侧边栏 /team 入口', () => {
  test('sidebar.tsx 的导航项里有 /team', () => {
    const sidebar = read('src', 'components', 'layout', 'sidebar.tsx');
    assert.ok(sidebarHasTeamEntry(sidebar), 'sidebar.tsx 没有 /team 导航项，老板端团队页又只能手输 URL');

    // 负向对照
    assert.equal(
      sidebarHasTeamEntry("const NAV_GROUPS = [{ key: 'operations', items: [{ href: '/business', key: 'business' }] }];"),
      false,
      '匹配器对不含 /team 的导航定义也报"有"，负向对照失败',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. 设置页账号分组
// ---------------------------------------------------------------------------

describe('账号接线：设置页 account 分组', () => {
  test("设置页的分组列表包含 'account'", () => {
    const settings = read('src', 'app', '[locale]', 'settings', 'page.tsx');
    const keys = settingsGroupKeys(settings);
    assert.ok(keys.includes('account'), `设置页分组列表缺少 'account'，实际为：${keys.join(', ')}`);

    // 负向对照：同一个提取器对缺少 account 的分组列表必须给出不含 account 的结果
    const synthetic = `const groups: { key: Group; icon: typeof Store; label: string }[] = [
      { key: 'business', icon: Store, label: 'Business' },
    ];`;
    assert.deepEqual(settingsGroupKeys(synthetic), ['business']);
    assert.equal(settingsGroupKeys(synthetic).includes('account'), false);
  });

  test('account 面板不只是空壳：改密码控件接在真实接口上，且有退出按钮', () => {
    const settings = read('src', 'app', '[locale]', 'settings', 'page.tsx');
    assert.ok(
      changePasswordFormWired(settings),
      "设置页有改密码 UI 但没有 POST /api/auth/change-password —— 又是一个死按钮",
    );
    assert.ok(settings.includes("'/api/auth/logout'"), '设置页的退出按钮没有调用登出接口');
    assert.ok(settings.includes("ta('signOutFailed')"), '设置页退出失败没有可见提示');

    // 负向对照
    assert.equal(
      changePasswordFormWired("ta('updatePassword') // 只有按钮，没有接口"),
      false,
      '匹配器对"有按钮无接口"也报"已接线"，负向对照失败',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. 登录页双入口 + 按角色分流
// ---------------------------------------------------------------------------

describe('账号接线：登录页双入口', () => {
  test('登录页同时有老板入口与员工入口，且按服务端返回的 role 分流', () => {
    const login = read('src', 'app', '[locale]', 'auth', 'login', 'page.tsx');
    const entries = loginEntries(login);
    assert.ok(entries.owner, '登录页缺少老板入口');
    assert.ok(entries.staff, '登录页缺少员工入口');
    assert.ok(
      loginRedirectsByRole(login),
      "登录页没有按接口返回的 role 分流（标签只是提示，角色才是事实）",
    );
    // 一套认证：两个入口必须打同一个登录接口
    assert.ok(login.includes("login(email, password)"), '登录页没有复用同一个登录调用');

    // 负向对照
    assert.deepEqual(
      loginEntries('const ENTRIES = [{ key: "owner", labelKey: "entryOwner" }];'),
      { owner: true, staff: false },
      '负向对照失败：匹配器应能分辨"只有老板入口"',
    );
    assert.equal(
      loginRedirectsByRole("router.replace('/dashboard')"),
      false,
      '匹配器对"写死跳仪表盘"也报"按角色分流"，负向对照失败',
    );
  });
});

// ---------------------------------------------------------------------------
// 5. 顶栏账号菜单
// ---------------------------------------------------------------------------

describe('账号接线：顶栏账号菜单', () => {
  test('顶栏显示身份与角色，能退出，且失败可见', () => {
    const topbar = read('src', 'components', 'layout', 'topbar.tsx');
    const menu = topbarAccountMenu(topbar);
    assert.ok(menu.identity, '顶栏账号菜单没有显示登录身份（useSession / 邮箱）');
    assert.ok(menu.role, '顶栏账号菜单没有显示角色（owner / manager / staff）');
    assert.ok(menu.signsOut, '顶栏账号菜单没有调用登出接口');
    assert.ok(menu.failureVisible, '顶栏登出失败没有可见提示（静默失败）');

    // 负向对照：一个"只有语言切换"的顶栏必须四项全否
    const synthetic = 'const x = <DropdownMenu>{locales.map((l) => <DropdownMenuItem />)}</DropdownMenu>';
    assert.deepEqual(topbarAccountMenu(synthetic), {
      identity: false,
      role: false,
      signsOut: false,
      failureVisible: false,
    });
  });
});

// ---------------------------------------------------------------------------
// 6. 改密码路由契约 + 三语文案齐全
// ---------------------------------------------------------------------------

describe('账号接线：改密码路由与文案', () => {
  test('change-password 路由验证旧密码、只改会话本人、不用共享单例、走中心化守卫', () => {
    const route = read('src', 'app', 'api', 'auth', 'change-password', 'route.ts');
    const contract = changePasswordRoute(route);
    assert.deepEqual(contract, {
      verifiesCurrentPassword: true,
      freshClientOnly: true,
      sessionScopedTarget: true,
      centrallyGuarded: true,
    });

    // 负向对照 1：不校验旧密码、且用共享单例的实现必须被同一段逻辑拒绝
    const bad = `import { getSupabaseClient } from '@/storage/database/supabase-client';
export const POST = protectTenantMutation({ permission: 'workforce:self' }, async (request) => {
  const body = await request.json();
  return getSupabaseClient().auth.admin.updateUserById(body.user_id, { password: body.new_password });
});`;
    const badContract = changePasswordRoute(bad);
    assert.equal(badContract.verifiesCurrentPassword, false, '负向对照失败：无旧密码校验却判为通过');
    assert.equal(badContract.freshClientOnly, false, '负向对照失败：共享单例却判为通过');
    assert.equal(badContract.sessionScopedTarget, false, '负向对照失败：目标取自请求体却判为通过');

    // 负向对照 2：没有中心化守卫的路由必须被识别出来
    assert.equal(
      changePasswordRoute('export async function POST(request: Request) { return new Response() }').centrallyGuarded,
      false,
    );
  });

  test('三语文案都补齐了新增的键（缺一个语言就是运行时 MISSING_MESSAGE）', () => {
    const requiredKeys = [
      'nav.team',
      'settings.groupAccount',
      'account.roles.owner',
      'account.roles.manager',
      'account.roles.staff',
      'account.signOut',
      'account.switchAccount',
      'account.signOutFailed',
      'account.changePassword',
      'auth.entryOwner',
      'auth.entryStaff',
    ];
    for (const locale of LOCALES) {
      assert.deepEqual(
        missingKeys(loadBundle(locale), requiredKeys),
        [],
        `${locale}.json 缺少这些键`,
      );
    }

    // 负向对照：匹配器必须能报出缺失，而不是永远返回空数组
    assert.deepEqual(missingKeys({}, requiredKeys), requiredKeys);
    const en = loadBundle('en') as { nav: Record<string, unknown> };
    delete en.nav.team;
    assert.deepEqual(missingKeys(en, ['nav.team']), ['nav.team']);
  });
});
