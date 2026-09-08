import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SaveError, saveJson } from '../src/lib/fetch-utils';

const read = (path: string): string => readFileSync(path, 'utf8');

const originalFetch = globalThis.fetch;

function mockFetchOnce(response: Response | (() => Response)): void {
  globalThis.fetch = (async () => {
    return typeof response === 'function' ? response() : response;
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('P0-7 saveJson 错误传播', () => {
  test('2xx 返回解析后的 JSON', async () => {
    mockFetchOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const data = await saveJson('/api/x', { method: 'POST', body: { a: 1 } });
    assert.deepEqual(data, { ok: true });
  });

  test('500 抛 SaveError 并携带服务端错误文案（不得继续误报已保存）', async () => {
    mockFetchOnce(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
    await assert.rejects(
      () => saveJson('/api/x', { method: 'PUT', body: { a: 1 } }),
      (error: unknown) => {
        assert.ok(error instanceof SaveError);
        assert.equal((error as SaveError).status, 500);
        assert.equal((error as SaveError).message, 'boom');
        return true;
      },
    );
  });

  test('网络失败抛 SaveError（status 0）', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('network down'))) as typeof fetch;
    await assert.rejects(
      () => saveJson('/api/x'),
      (error: unknown) => {
        assert.ok(error instanceof SaveError);
        assert.equal((error as SaveError).status, 0);
        return true;
      },
    );
  });

  test('空响应体成功返回 null', async () => {
    mockFetchOnce(new Response(null, { status: 204 }));
    assert.equal(await saveJson('/api/x', { method: 'DELETE' }), null);
  });
});

describe('P0-7 保存误报源码契约', () => {
  test('settings 保存系列全部走 saveJson（res.ok 校验 + 失败提示）', () => {
    const src = read('src/app/[locale]/settings/page.tsx');
    for (const [name, url] of [
      ['saveSection', '/api/settings'],
      ['saveModel', '/api/settings/models'],
      ['saveMailbox', '/api/settings/email-accounts'],
      ['saveIntegration', '/api/integrations'],
      ['saveChannel', '/api/channels'],
    ] as const) {
      const fnIndex = src.indexOf(`const ${name} =`);
      assert.ok(fnIndex >= 0, `${name} 缺失`);
      const nextFn = src.indexOf('const ', fnIndex + 10);
      const slice = src.slice(fnIndex, nextFn < 0 ? fnIndex + 1200 : nextFn);
      assert.ok(slice.includes('saveJson'), `${name} 必须使用 saveJson`);
      assert.ok(slice.includes(url), `${name} 应指向 ${url}`);
      assert.ok(slice.includes('catch') && slice.includes('flashSaveError'), `${name} 失败必须提示`);
    }
  });

  test('emails 草稿保存：失败不再误报 draftSaved', () => {
    const src = read('src/app/[locale]/emails/page.tsx');
    const fnIndex = src.indexOf('const saveDraft =');
    const slice = src.slice(fnIndex, fnIndex + 900);
    assert.ok(slice.includes('saveJson'));
    assert.ok(slice.indexOf('saveJson') < slice.indexOf("t('draftSaved')"), '成功提示必须位于 saveJson 之后');
    assert.ok(slice.includes('catch'));
  });

  test('knowledge 保存/删除：finally 复位 + 失败不关弹窗', () => {
    const src = read('src/app/[locale]/knowledge/page.tsx');
    const saveIndex = src.indexOf('const save =');
    const removeIndex = src.indexOf('const remove =');
    const saveSlice = src.slice(saveIndex, removeIndex);
    assert.ok(saveSlice.includes('saveJson'));
    assert.ok(saveSlice.includes('finally'));
    const removeSlice = src.slice(removeIndex, removeIndex + 700);
    assert.ok(removeSlice.includes('saveJson'));
    assert.ok(removeSlice.includes('finally'));
  });

  test('safeFetchJson 失败至少 console.error 留痕', () => {
    const src = read('src/lib/utils.ts');
    assert.match(src, /console\.error\(`\[safeFetchJson\]/);
  });
});
