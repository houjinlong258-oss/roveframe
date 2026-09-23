import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 浏览器探针的**清理契约** —— Phase 18 审计中发现并修掉的自身缺陷。
 *
 * ## 缺陷是什么（两次尝试都失败，都实测过）
 *
 * 1. `chrome.kill()`：Windows 上只结束直接子进程。headless Chrome 会派出
 *    渲染 / GPU / 网络 / crashpad 等子进程，它们继续持有 `--remote-debugging-port`。
 *    实测一次会话后残留 **261 个无窗口 chrome 进程、占着 21 个调试端口**。
 * 2. 改成 `taskkill /PID <pid> /T /F`（同步 spawn、不等）：Node 紧接着
 *    `process.exit()` ⇒ kill 尚未执行完就退出。改成 await 之后**仍然残留 11 个**
 *    —— `/T` 依赖父子关系，而 Chrome 的子进程会重新挂到别处。
 *
 * **后果不是"环境脏"，是探针开始说假话**：随机端口撞上旧 Chrome ⇒ 新探针连上
 * **别人的**浏览器，表现是"判定行都没有"或结论与页面无关。
 * 这正是本仓库那条纪律的又一副面孔：**会撒谎的探针比没有探针更糟。**
 *
 * ## 现在的不变量
 *
 *   · 按 `--user-data-dir`（本次运行唯一）枚举并杀，**不依赖进程树**；
 *   · 清理是 **async 且被 await** 的（`cleanupAndWait`），退出前一定做完；
 *   · 端口先做 bind 探测再选，不靠随机撞；
 *   · 清理结果**打印出来**（`killed N chrome process(es)`），可观测。
 *
 * 实测：修复前单次运行残留 +12；修复后 `killed 12` 且残留 **0**，
 * 连跑 14 次仍为 0。
 */

const ROOT = process.cwd();
const src = readFileSync(join(ROOT, 'scripts', '_browser_check.mjs'), 'utf8');

describe('浏览器探针：清理必须真的杀掉整棵进程树', () => {
  test('按唯一标记枚举进程（不依赖 taskkill /T 的父子关系）', () => {
    assert.match(src, /userDataDir/, '必须用本次运行唯一的 user-data-dir 作为标记');
    assert.match(src, /Get-CimInstance Win32_Process/, '必须枚举进程而不是只杀直接子进程');
    assert.match(src, /CommandLine -like/, '必须按命令行过滤，否则会误杀用户自己的 Chrome');
  });

  test('绝不用 chrome.kill() 作为 Windows 上的唯一手段', () => {
    // 负向对照：这正是第一版（实测残留 261 个进程）
    assert.doesNotMatch(
      src,
      /function cleanup\(\) \{\s*try \{ chrome\.kill\(\); \}/,
      '回到"只 kill 直接子进程"会让探针连上残留浏览器',
    );
    // POSIX 分支允许 kill('SIGKILL')，但 Windows 分支必须是枚举式
    assert.match(src, /if \(process\.platform !== 'win32'\)[\s\S]{0,200}?chrome\.kill\('SIGKILL'\)/);
  });

  test('清理是 async 且被 await（否则 process.exit 会抢在前面）', () => {
    assert.match(src, /async function killChromeTree\(\)/);
    assert.match(src, /async function cleanupAndWait\(\)/);
    assert.match(src, /await killChromeTree\(\)/);
    // finish 必须等清理完成再 resolve
    assert.match(src, /cleanupAndWait\(\)\.then\(\(\) => resolve\(code\)/);
  });

  test('负向对照：把 cleanupAndWait 换回同步 cleanup，上面的断言必须失败', () => {
    const legacy = src
      .replace(/cleanupAndWait\(\)\.then\(\(\) => resolve\(code\), \(\) => resolve\(code\)\);/, 'cleanup(); resolve(code);');
    assert.doesNotMatch(legacy, /cleanupAndWait\(\)\.then/);
    assert.match(src, /cleanupAndWait\(\)\.then/);
  });

  test('端口先做 bind 探测，不靠随机撞（撞上旧 Chrome 会连错浏览器）', () => {
    assert.match(src, /async function pickFreePort/);
    assert.match(src, /createServer\(\)/);
    assert.match(src, /server\.listen\(port, '127\.0\.0\.1'\)/);
    // 负向对照：第一版是 `9000 + Math.floor(Math.random() * 900)`
    assert.doesNotMatch(src, /const port = 9000 \+ Math\.floor\(Math\.random\(\) \* 900\);/);
  });

  test('清理结果可观测（失败过两次都是因为没人验证杀掉了几个）', () => {
    assert.match(src, /killed \$\{killed\} chrome process/);
    assert.match(src, /RF_BROWSER_CHECK_VERBOSE/);
  });

  test('user-data-dir 每次运行唯一（标记的前提）', () => {
    assert.match(src, /mkdtempSync\(join\(tmpdir\(\), 'rf-cdp-'\)\)/);
  });
});
