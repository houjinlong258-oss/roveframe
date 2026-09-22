/**
 * 零依赖的真实浏览器验证（Chrome DevTools Protocol，Node 内置 WebSocket）。
 *
 * ## 为什么不用 Playwright / Puppeteer
 *
 * 本项目约束"零新增依赖，仅 pnpm 与 Node 内置"。而浏览器端运行时
 * （hydration、事件、定位授权、地图渲染）恰恰是**只有真浏览器才能验**的一层 ——
 * SSR 与源码级证据都不算数（Phase 18 交接文档把这一层明确标为"完全未验证"）。
 *
 * Node 22 内置 `WebSocket` 与 `fetch`，Chrome 又已装在机器上，因此可以直接说
 * CDP：启动 headless Chrome → 连它的调试端点 → 打开页面 → 收控制台/异常/网络
 * 事件 → 在页面里求值。不需要任何 npm 包。
 *
 * ## 它报告什么（都是"能不能用"的直接证据）
 *
 *   1. `console` 里的 **error** 与 **warning**（hydration mismatch 会在这里出现）；
 *   2. 未捕获异常（`Runtime.exceptionThrown`）；
 *   3. 失败的网络请求（4xx/5xx）—— 一个静默 404 的资源在页面上表现为"样式不对"，
 *      而只有网络事件能说清是哪个 URL；
 *   4. `document.readyState` 与 React 是否真的挂载（根容器有子节点）；
 *   5. 调用方给的 `--eval` 表达式的结果。
 *
 * ## 用法
 *
 *   node scripts/_browser_check.mjs <url> [--eval "<js表达式>"] [--wait <ms>]
 *                                     [--click "<selector>"] [--mobile]
 *
 * 退出码：有 console error / 未捕获异常 / 失败请求 / 未挂载 → 非 0。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const URL_TARGET = process.argv[2];
if (!URL_TARGET) {
  console.error('用法: node scripts/_browser_check.mjs <url> [--eval "<js>"] [--wait ms] [--click sel] [--mobile]');
  process.exit(2);
}
const WAIT_MS = Number(arg('wait', '2500'));
const EVAL_EXPR = arg('eval');
const CLICK_SEL = arg('click');
const MOBILE = process.argv.includes('--mobile');

const userDataDir = mkdtempSync(join(tmpdir(), 'rf-cdp-'));
const port = 9000 + Math.floor(Math.random() * 900);

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  'about:blank',
], { stdio: 'ignore' });

function cleanup() {
  try { chrome.kill(); } catch { /* 已退出 */ }
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* 占用中 */ }
}

/** 等调试端点就绪（headless 冷启动有几百毫秒）。 */
async function waitForTarget(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function main() {
  return new Promise((resolve) => {
    const consoleErrors = [];
    const consoleWarnings = [];
    const exceptions = [];
    const failedRequests = [];
    const responses = [];
    let pageLoaded = false;
    let done = false;

    const finish = (code) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(code);
    };

    (async () => {
      if (!(await waitForTarget())) {
        console.error(`Chrome 调试端点未就绪（port=${port}）`);
        finish(2);
        return;
      }

      // 新建一个标签页并连上它
      const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const target = created ?? (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()))[0];
      if (!target?.webSocketDebuggerUrl) {
        console.error('拿不到 webSocketDebuggerUrl');
        finish(2);
        return;
      }

      const ws = new WebSocket(target.webSocketDebuggerUrl);
      let nextId = 1;
      const pending = new Map();
      const send = (method, params = {}) => new Promise((res) => {
        const id = nextId++;
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
      });

      ws.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(String(event.data)); } catch { return; }
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg.result ?? {});
          pending.delete(msg.id);
          return;
        }
        switch (msg.method) {
          case 'Runtime.consoleAPICalled': {
            const type = msg.params?.type;
            const text = (msg.params?.args ?? [])
              .map((a) => a.value ?? a.description ?? a.type)
              .join(' ');
            if (type === 'error') consoleErrors.push(text);
            else if (type === 'warning') consoleWarnings.push(text);
            break;
          }
          case 'Runtime.exceptionThrown': {
            const d = msg.params?.exceptionDetails;
            exceptions.push(d?.exception?.description ?? d?.text ?? 'unknown exception');
            break;
          }
          case 'Network.responseReceived': {
            const r = msg.params?.response;
            responses.push(r?.status);
            // 未登录时受保护端点回 401 是**正确行为**（AppShell 的会话守卫与各页面
            // 自己的加载逻辑都会先探测会话）。把它们算成"失败请求"会让每个需要
            // 登录的页面都误报 —— 探针必须能分辨"预期内的拒绝"与"真的坏了"。
            //
            // 注意：这**不是**在放宽判定。真正要抓的是 4xx/5xx 里的异常项
            // （例如资源 404、接口 500）；"未登录所以 401"另有脚本带真会话去验
            // （_verify_staff_tier.mjs 15/15、_verify_delivery_chain.mjs 72/72）。
            const expectedUnauthorized = r?.status === 401;
            if (r?.status >= 400 && !expectedUnauthorized) {
              failedRequests.push(`${r.status} ${r.url}`);
            }
            break;
          }
          case 'Network.loadingFailed': {
            // 被取消的请求很常见（页面跳转），只在有 errorText 时记
            const t = msg.params?.errorText;
            if (t && t !== 'net::ERR_ABORTED') failedRequests.push(`FAILED ${msg.params?.requestId} ${t}`);
            break;
          }
          case 'Page.loadEventFired':
            pageLoaded = true;
            break;
          default:
            break;
        }
      });

      await new Promise((res, rej) => {
        ws.addEventListener('open', res);
        ws.addEventListener('error', rej);
      });

      await send('Runtime.enable');
      await send('Page.enable');
      await send('Network.enable');
      if (MOBILE) {
        await send('Emulation.setDeviceMetricsOverride', {
          width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
        });
        await send('Emulation.setUserAgentOverride', {
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
            + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        });
      }

      await send('Page.navigate', { url: URL_TARGET });

      // 等 load 事件（有上限），再额外等一会儿让 effect / 异步请求落地
      const loadDeadline = Date.now() + 25000;
      while (!pageLoaded && Date.now() < loadDeadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, WAIT_MS));

      const evaluate = async (expression) => {
        const result = await send('Runtime.evaluate', {
          expression, returnByValue: true, awaitPromise: true,
        });
        if (result?.exceptionDetails) {
          return { error: result.exceptionDetails.exception?.description ?? 'eval failed' };
        }
        return { value: result?.result?.value };
      };

      let clickResult = null;
      let clickEffect = null;
      if (CLICK_SEL) {
        // 点击**前后**各取一次可观测状态：状态真的变了才说明 React 接管了事件，
        // 否则"点了没反应"与"React 没挂载"在报告里长得一样。
        clickResult = await evaluate(`
          (() => {
            const el = document.querySelector(${JSON.stringify(CLICK_SEL)});
            if (!el) return { clicked: false, reason: 'selector not found' };
            const before = el.getAttribute('aria-pressed') ?? el.getAttribute('class') ?? '';
            el.click();
            return { clicked: true, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 60), before: before.slice(0, 200) };
          })()
        `);
        await new Promise((r) => setTimeout(r, 1200));
        clickEffect = await evaluate(`
          (() => {
            const el = document.querySelector(${JSON.stringify(CLICK_SEL)});
            if (!el) return null;
            const after = el.getAttribute('aria-pressed') ?? el.getAttribute('class') ?? '';
            return { after: after.slice(0, 200) };
          })()
        `);
      }

      const mountInfo = await evaluate(`
        (() => {
          // 挂载判定用**页面是否真的渲染出内容**，而不是某个固定容器选择器：
          // 本项目的页面结构不统一（有的走 AppShell、有的全屏 PWA、有的是
          // 服务端组件），按选择器判会得到假阴性 —— 第一版就是这样把
          // /en/staff/login（实际渲染正常）判成"未挂载"的。
          const bodyText = (document.body?.innerText ?? '').trim();
          const interactive = document.querySelectorAll('button, input, a, form').length;
          const appRoot = document.querySelector('#__next, [data-reactroot]');
          return {
            readyState: document.readyState,
            title: document.title,
            bodyTextLength: bodyText.length,
            interactiveElements: interactive,
            appRootChildren: appRoot ? appRoot.children.length : null,
            // React 的协调标记挂在**具体某个元素**上（通常是根的子节点而不是根本身），
            // 所以按元素全量扫一遍，而不是只看根节点 —— 第一版只看根，把已经接管
            // 页面的客户端组件判成了"未挂载"。
            reactMounted: (() => {
              const nodes = [document.documentElement, ...document.querySelectorAll('*')].slice(0, 400);
              return nodes.some((el) => Object.keys(el).some((k) => k.startsWith('__react')));
            })(),
            firstHeading: (document.querySelector('h1,h2')?.textContent ?? '').trim().slice(0, 80),
          };
        })()
      `);

      const evalResult = EVAL_EXPR ? await evaluate(EVAL_EXPR) : null;

      // ---------- 报告 ----------
      const info = mountInfo.value ?? {};
      // "渲染出内容"= 有可交互元素或可见文本。空白的 200 页面也算失败。
      const rendered = (info.interactiveElements ?? 0) > 0 || (info.bodyTextLength ?? 0) > 40;
      const ok = consoleErrors.length === 0
        && exceptions.length === 0
        && failedRequests.length === 0
        && rendered;

      console.log('='.repeat(78));
      console.log(`浏览器验证: ${URL_TARGET}${MOBILE ? '  (mobile 390x844)' : ''}`);
      console.log('='.repeat(78));
      console.log(`  load 事件:      ${pageLoaded ? '已触发' : '**未触发**'}`);
      console.log(`  readyState:     ${info.readyState ?? '?'}`);
      console.log(`  标题:           ${info.title ?? '?'}`);
      console.log(`  首个标题元素:   ${info.firstHeading || '(无)'}`);
      console.log(`  可交互元素:     ${info.interactiveElements ?? 0}`);
      console.log(`  可见文本长度:   ${info.bodyTextLength ?? 0}`);
      console.log(`  React 已挂载:   ${info.reactMounted ? '是' : '否（服务端渲染或客户端未接管）'}`);
      console.log(`  渲染判定:       ${rendered ? '有内容' : '**空白**'}`);
      console.log(`  响应状态分布:   ${JSON.stringify(responses.slice(0, 20))}`);
      console.log('');
      console.log(`  console error:  ${consoleErrors.length}`);
      for (const e of consoleErrors.slice(0, 10)) console.log(`      ! ${e.slice(0, 300)}`);
      console.log(`  未捕获异常:     ${exceptions.length}`);
      for (const e of exceptions.slice(0, 10)) console.log(`      ! ${String(e).slice(0, 300)}`);
      console.log(`  失败请求:       ${failedRequests.length}`);
      for (const f of failedRequests.slice(0, 10)) console.log(`      ! ${f.slice(0, 200)}`);
      if (consoleWarnings.length) {
        console.log(`  console warning: ${consoleWarnings.length}（不计入判定）`);
        for (const w of consoleWarnings.slice(0, 5)) console.log(`      ~ ${w.slice(0, 200)}`);
      }
      if (clickResult) {
        const before = clickResult.value?.before ?? '';
        const after = clickEffect?.value?.after ?? '';
        // class/aria 变了 = 事件真的被 React 处理了（"点了没反应"与"React 未接管"要能分开）
        const reacted = !!before && !!after && before !== after;
        console.log(`  点击 ${CLICK_SEL}: ${JSON.stringify(clickResult.value ?? clickResult.error)}`);
        console.log(`      状态变化:   ${reacted ? '有（React 已接管事件）' : '**无变化**'}`);
        if (reacted) console.log(`      before → after: ${before.slice(0, 90)} → ${after.slice(0, 90)}`);
      }
      if (evalResult) {
        console.log(`  --eval 结果:    ${JSON.stringify(evalResult.value ?? evalResult.error).slice(0, 800)}`);
      }
      console.log('');
      console.log(ok ? '判定: PASS（无 error / 无异常 / 无失败请求 / 已挂载）' : '判定: FAIL');
      console.log('='.repeat(78));
      finish(ok ? 0 : 1);
    })().catch((err) => {
      console.error('脚本异常:', err);
      finish(2);
    });
  });
}

const code = await main();
process.exit(code);
