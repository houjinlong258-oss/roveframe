import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 保存模型配置时必须顺带拉取该供应商的模型列表 —— 且拉取失败不能拖垮保存。
 *
 * ## 为什么
 *
 * 用户报告：「输入配置完模型 key，怎么不扫描和识别模型列表？不是输入完供应商后
 * 就该生成所有模型列表、再按功能自己配置吗？」
 *
 * 事实：拉取模型列表的能力早就存在（`testProviderConnection` 会打 `/models`，
 * 并且会落 `models_cache` / `models_updated_at`），但**只有手动点「测试连接」
 * 才会触发**。保存后打开弹窗，「默认模型」下拉仍是空的 —— 看起来像"没识别到模型"。
 *
 * ## 契约（两条，都必须守住）
 *
 * 1. 保存成功后要自动拉一次并落库（否则回到"不点测试就看不到模型"）。
 * 2. 拉取是 **best-effort**：必须包在 try/catch 里，失败只让 `models` 返回 null。
 *    把两者绑死会让网络抖动变成"配置存不进去" —— 一个增强功能不该有这种权力。
 *
 * 实测（本地真实服务端）：
 *   · 保存 deepseek（不带 key，用已存密钥探测）→ 200，带回
 *     `models: ["deepseek-flash","deepseek-v4-pro"]`，models_updated_at 刷新，
 *     baseUrl/defaultModel/displayName/密钥掩码全部未被破坏。
 *   · 负向对照：端点不可达 → 200 且 `{ok:true, models:null}`（保存成功、不伪造空列表）。
 */

const ROOT = process.cwd();
const ROUTE = join('src', 'app', 'api', 'settings', 'models', 'route.ts');
const source = readFileSync(join(ROOT, ROUTE), 'utf8');

/** 取出 `saveModel` 函数体（从声明到 `export const POST`）。 */
function saveModelBody(src: string): string {
  const start = src.indexOf('async function saveModel');
  const end = src.indexOf('export const POST');
  assert.ok(start !== -1 && end > start, '找不到 saveModel 函数体，守卫需要同步更新');
  return src.slice(start, end);
}

const body = saveModelBody(source);

/**
 * 探测调用是否被 try/catch 保护。
 * 由下面的自测用例证明它**能返回 true**，否则它是一条永远为真的空断言。
 */
function probeIsGuarded(src: string): boolean {
  const callAt = src.indexOf('await testProviderConnection(');
  if (callAt === -1) return false;
  const before = src.slice(Math.max(0, callAt - 900), callAt);
  const tryAt = before.lastIndexOf('try {');
  if (tryAt === -1) return false;
  // try 与调用点之间不能已经闭合过 catch —— 只看最近一个 try 是否仍在作用域内
  const afterTry = before.slice(tryAt);
  return !afterTry.includes('} catch');
}

describe('保存模型配置时的模型列表自动拉取', () => {
  test('saveModel 会调用连接探测以拉取模型列表', () => {
    assert.match(
      body,
      /await testProviderConnection\(/,
      '保存后必须自动探测一次以拉取模型列表，否则用户要点「测试连接」才看得到模型',
    );
  });

  test('拉取结果落库到 models_cache 与 models_updated_at', () => {
    assert.match(body, /models_cache:/, '必须把拉到的列表写进 models_cache');
    assert.match(body, /models_updated_at:/, '必须同时刷新 models_updated_at');
  });

  test('保存响应带回本次拉到的模型列表，供前端立即展示', () => {
    assert.match(
      body,
      /models: discovered/,
      '响应体要带回 models，前端保存后即可用，不必等下一次 GET',
    );
  });

  test('拉取是 best-effort：探测调用被 try/catch 包住，失败不影响保存', () => {
    assert.equal(
      probeIsGuarded(body),
      true,
      'testProviderConnection 必须包在 try/catch 内。写配置与拉列表是两件事，' +
        '把拉取失败冒泡出去会让"网络抖动"变成"配置存不进去"。',
    );
  });

  test('负向对照：检测器能把「没被 try/catch 包住」的写法判为 false', () => {
    const unguarded = 'const probe = await testProviderConnection({ provider }); await save();';
    assert.equal(probeIsGuarded(unguarded), false, '检测器必须能识别未受保护的探测调用');

    const guarded = 'try {\n  const probe = await testProviderConnection({ provider });\n} catch { }';
    assert.equal(probeIsGuarded(guarded), true, '检测器不得把受保护的调用误判为未保护');

    const closed = 'try {\n  x();\n} catch { }\nconst probe = await testProviderConnection({ provider });';
    assert.equal(probeIsGuarded(closed), false, 'try 已闭合后再调用，不算受保护');
  });
});
