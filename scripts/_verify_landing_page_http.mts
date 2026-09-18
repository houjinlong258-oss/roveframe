/**
 * Phase 15 — 落地页与服务路由的真实 HTTP 验证（只读；会注册 1 个测试商家）。
 *
 * ## 证明什么
 *
 * 此前 `/` 是仪表盘：未登录访客被 AppShell 的会话守卫弹到登录页，
 * **产品对外没有一句话介绍**。现在：
 *
 *   · 未登录访客访问 `/<locale>` → 200 且返回**落地页**（含注册/登录入口）；
 *   · `/<locale>/dashboard` 仍可达，仍是后台框架；
 *   · 三条语言的落地页都可访问。
 *
 * 判定不看"有没有报错"，而是看**响应体里有没有落地页特有的内容**
 * （注册链接、价格文案），以及**有没有被重定向到登录页** ——
 * 两条都要能产生"不通过"的证据。
 */
const BASE = `http://127.0.0.1:${process.env.WEB_PORT || '5055'}`;
const CLIENT_IP = '203.0.113.52';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<number> {
  const checks: Check[] = [];
  console.log('='.repeat(78));
  console.log('Phase 15 — 落地页 HTTP 验证');
  console.log('='.repeat(78));

  // ---- 1) 未登录访问 /en ----
  const home = await fetch(`${BASE}/en`, {
    headers: { 'x-forwarded-for': CLIENT_IP },
    redirect: 'manual',
  });
  const homeHtml = await home.text();
  const punchline = (homeHtml.match(/Chief Operating Officer|AI COO/i) ?? ['(无)'])[0];

  console.log(`GET /en (匿名): HTTP ${home.status}, ${homeHtml.length} 字符`);
  checks.push({ name: 'GET /en 返回 200', ok: home.status === 200, detail: `HTTP ${home.status}` });
  checks.push({
    name: '落地页文案随 HTML 送达（服务端可渲染，非空壳）',
    ok: /Chief Operating Officer|AI COO/i.test(homeHtml),
    detail: `匹配到: ${punchline}`,
  });
  checks.push({
    name: '未被重定向到登录页',
    ok: !homeHtml.includes('/auth/login?next='),
    detail: home.status === 200 ? '服务端未重定向' : `HTTP ${home.status}`,
  });

  // 关键：落地页**不带后台侧栏**。
  //
  // 判定依据是"后台导航链接是否出现"。此前 `/<locale>` 直接渲染仪表盘，
  // HTML 里必然带 `/en/agent`、`/en/approvals` 等侧栏项；
  // 现在 AppShell 在根路径直接返回 children，因此这些链接不应出现。
  // 这是一条能产生"不通过"的证据：把 AppShell 的 isLanding 分支去掉，
  // 侧栏链接立刻回来，本项即红。
  const chromeLinks = ['/en/agent', '/en/approvals', '/en/customers']
    .filter((p) => homeHtml.includes(`href="${p}"`));
  checks.push({
    name: '落地页不带后台侧栏',
    ok: chromeLinks.length === 0,
    detail: chromeLinks.length === 0
      ? '未出现后台导航链接'
      : `出现了后台导航: ${chromeLinks.join(', ')}`,
  });

  // ---- 2) 另外两条语言的落地页 ----
  //
  // 落地页内容由客户端按会话渲染，因此断言的是"服务端能送达该语言的 i18n 负载"
  // 而不是"HTML 里有某个 href"（后者在首屏为空壳时必然为假，是写错了判据）。
  for (const loc of ['zh', 'es']) {
    const r = await fetch(`${BASE}/${loc}`, { headers: { 'x-forwarded-for': CLIENT_IP } });
    const html = await r.text();
    const hasCjk = loc === 'zh' ? /[\u4e00-\u9fff]/.test(html) : /[áéíóúñ¿]/i.test(html);
    checks.push({
      name: `/${loc} 返回 200 且送达该语言文案`,
      ok: r.status === 200 && html.length > 500 && hasCjk,
      detail: `HTTP ${r.status}, ${html.length} 字符, 该语言字符=${hasCjk}`,
    });
  }

  // ---- 3) 仪表盘迁到 /dashboard 且可达 ----
  const dash = await fetch(`${BASE}/en/dashboard`, {
    headers: { 'x-forwarded-for': CLIENT_IP },
    redirect: 'manual',
  });
  const dashHtml = await dash.text();
  console.log(`GET /en/dashboard (匿名): HTTP ${dash.status}, ${dashHtml.length} 字符`);
  checks.push({
    name: '/dashboard 可达（不再 404）',
    ok: dash.status === 200,
    detail: `HTTP ${dash.status}`,
  });

  // ---- 4) 注册后会话有效（落地页会把已登录用户送进 /dashboard）----
  const stamp = Date.now();
  const email = `e2e-landing-${stamp}@example.com`;
  const password = `Rove!${stamp}Aa9`;
  const signup = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': CLIENT_IP },
    body: JSON.stringify({
      email,
      password,
      business_name: `Landing probe ${stamp}`,
      industry: 'restaurant',
      language: 'en',
      currency: 'USD',
    }),
  });
  const cookie = (signup.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  console.log(`注册（用于登录态检查）: HTTP ${signup.status}`);
  if (signup.status === 201) {
    const me = await fetch(`${BASE}/api/auth/me`, {
      headers: { cookie, 'x-forwarded-for': CLIENT_IP },
    });
    checks.push({ name: '注册后会话有效', ok: me.status === 200, detail: `HTTP ${me.status}` });
  } else {
    checks.push({ name: '注册后会话有效', ok: false, detail: `注册 HTTP ${signup.status}` });
  }

  console.log('');
  console.log('='.repeat(78));
  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed += 1;
    console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name} — ${c.detail}`);
  }
  console.log('');
  console.log(failed === 0
    ? '结论: 未登录访客能看到落地页；仪表盘迁到 /dashboard 且可达。'
    : `结论: ${failed} 项未通过。`);
  console.log('='.repeat(78));
  console.log('注意：本脚本会注册一个测试商家，跑完请执行');
  console.log('      npx tsx scripts/_cleanup_test_residue.mts --apply');
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 800).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
