import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import proxy from '../src/proxy';

/**
 * Phase 12 / P0-4 —— request id 贯通。
 *
 * 目标：一次请求能跨「中间件 → handler → 日志」被串起来，且**不信任**客户端
 * 传入的值 —— 该 id 会进日志，未校验的客户端输入是日志注入面（换行可伪造
 * 日志行、超长可撑爆日志）。
 */

function makeRequest(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL(`http://localhost${path}`), { headers });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('request id propagation (P0-4)', () => {
  test('a public API response carries an x-request-id', async () => {
    const response = await proxy(makeRequest('/api/health'));
    const id = response.headers.get('x-request-id');
    assert.ok(id, '响应必须带 x-request-id');
    assert.match(id ?? '', UUID_RE, '未提供时必须是新生成的 UUID');
  });

  test('a well-formed caller-supplied id is reused', async () => {
    const supplied = 'abc12345-deadbeef-0001';
    const response = await proxy(makeRequest('/api/health', { 'x-request-id': supplied }));
    assert.equal(
      response.headers.get('x-request-id'),
      supplied,
      '形态合法的上游 id 必须复用，否则跨服务追踪会断成两段',
    );
  });

  test('a malformed id is replaced, not trusted', async () => {
    const hostile = 'short';
    const response = await proxy(makeRequest('/api/health', { 'x-request-id': hostile }));
    const id = response.headers.get('x-request-id');
    assert.notEqual(id, hostile);
    assert.match(id ?? '', UUID_RE);
  });

  test('malformed-but-legal header values are replaced', async () => {
    // 必须区分两类防护，否则会误以为全靠自己：
    //
    //   平台层（NextRequest/undici，按 HTTP 规范强制）已挡掉的输入，
    //   根本到不了本模块：
    //     · 含换行       -> TypeError: invalid header value
    //     · 非 ASCII     -> TypeError: cannot convert to ByteString (>255)
    //
    //   残余风险是**语义为合法 ByteString、形态却不受控**的值。
    //   这些能通过 HTTP 校验，因此必须由 REQUEST_ID_PATTERN 挡住。
    for (const hostile of [
      'has spaces in it',
      '../../etc/passwd',
      'id;rm -rf /',
      'quote"injection',
      'tab\tinside',
      'id=with=equals',
    ]) {
      const response = await proxy(makeRequest('/api/health', { 'x-request-id': hostile }));
      const id = response.headers.get('x-request-id');
      assert.notEqual(id, hostile, `不受控的值必须被替换: ${JSON.stringify(hostile)}`);
      assert.match(id ?? '', UUID_RE);
    }
  });

  test('documented: the platform already rejects newline and non-ASCII ids', () => {
    // 把上面注释里的两条断言钉住。若某个 Next.js/undici 升级放宽了校验，
    // 这里会失败，而 REQUEST_ID_PATTERN 仍需独立成立（上面的用例覆盖它）。
    assert.throws(() => makeRequest('/api/health', { 'x-request-id': 'a\nforged' }));
    assert.throws(() => makeRequest('/api/health', { 'x-request-id': '日本語-id-12345' }));
  });

  test('an over-long id is replaced', async () => {
    const huge = 'a'.repeat(500);
    const response = await proxy(makeRequest('/api/health', { 'x-request-id': huge }));
    const id = response.headers.get('x-request-id');
    assert.notEqual(id, huge);
    assert.ok((id ?? '').length <= 128);
  });

  test('401 responses still carry the id', async () => {
    // 鉴权失败恰恰是最需要追踪的一类请求 —— 不能只在成功路径上加。
    const response = await proxy(makeRequest('/api/settings/overview'));
    assert.equal(response.status, 401, '未携带凭据应 401');
    assert.ok(response.headers.get('x-request-id'), '401 响应同样必须带 x-request-id');
  });

  test('non-API (page) routes also carry the id', async () => {
    const response = await proxy(makeRequest('/en'));
    assert.ok(response.headers.get('x-request-id'));
  });
});
