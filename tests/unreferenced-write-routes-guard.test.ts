import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 从未被任何测试引用过的**写路由**：中央守卫必须在业务逻辑之前拦住无凭据请求。
 *
 * ## 为什么是这一组
 *
 * 独立审查（Phase 18/19）实测：132 条 API 路由里有 33~34 条的路径**从未出现在任何
 * 测试或验证脚本中**。任务书对这类的要求是"不是每个都补测试 —— 先分类：哪些有真实
 * 副作用（写库/外发/扣款），优先补这些"。
 *
 * 按副作用分类（读源码逐个判定）：
 *
 *   A. **有外发副作用**（出网/IMAP/SMTP/LLM）：`channels/test`、`emails/sync`、
 *      `emails/classify`、`marketing/generate`、`business/products/generate`、
 *      `website/generate`、`settings/models/test`、`customers/score`
 *   B. **只写库**：`business/staff`、`business/orders`、`knowledge/docs`、
 *      `marketing/contents`、`auth/invite`、`admin/subscriptions`
 *   C. **只读**：`admin/usage`、`business/tip-insight`、`settings/models/route-info`
 *      （另有三条写方法恒返回 405 的 `admin/audit-logs`）
 *
 * 本文件覆盖 A + B 共 14 条。断言的是**每一条都在中央守卫之后**：无凭据 ⇒ 401/403。
 * 这是这一组路由此前完全没有的性质 —— 一个"忘了加守卫"的写路由在这里会立刻变红。
 *
 * ## 刻意不做的（如实说明）
 *
 * 没有为这些路由补"业务行为"测试：A 组的外发需要 mock 出网（本仓库零新增依赖，
 * 没有现成的注入缝），B 组的成功路径需要真实租户数据与订阅状态。**在没做之前
 * 不声称做了** —— 这里只把"从未被任何测试碰过"变成"守卫形态被真实调用验证过"。
 *
 * 名单来源：`node scripts/_audit_test_effectiveness.mjs`（本提交时的输出）。
 * 它不是永久不变的：若将来有人给这些路由补了真正的测试，本文件的名单应当同步收缩，
 * 但**不需要**它来维持有效性 —— 守卫断言对任何一条都成立。
 */

type Handler = (r: Request) => Promise<Response>;

async function load(modulePath: string, exportName: string): Promise<Handler> {
  const mod = (await import(modulePath)) as Record<string, unknown>;
  const fn = mod[exportName];
  assert.equal(typeof fn, 'function', `${modulePath} 未导出 ${exportName}`);
  return fn as Handler;
}

/** A 组：有外发副作用 */
const OUTBOUND_WRITE_ROUTES: [string, string, string][] = [
  ['/api/channels/test', '../src/app/api/channels/test/route', 'POST'],
  ['/api/emails/sync', '../src/app/api/emails/sync/route', 'POST'],
  ['/api/emails/classify', '../src/app/api/emails/classify/route', 'POST'],
  ['/api/marketing/generate', '../src/app/api/marketing/generate/route', 'POST'],
  ['/api/business/products/generate', '../src/app/api/business/products/generate/route', 'POST'],
  ['/api/website/generate', '../src/app/api/website/generate/route', 'POST'],
  ['/api/settings/models/test', '../src/app/api/settings/models/test/route', 'POST'],
  ['/api/customers/score', '../src/app/api/customers/score/route', 'POST'],
];

/** B 组：只写库 */
const DB_WRITE_ROUTES: [string, string, string][] = [
  ['/api/business/staff', '../src/app/api/business/staff/route', 'POST'],
  ['/api/business/orders', '../src/app/api/business/orders/route', 'PATCH'],
  ['/api/knowledge/docs', '../src/app/api/knowledge/docs/route', 'POST'],
  ['/api/marketing/contents', '../src/app/api/marketing/contents/route', 'POST'],
  ['/api/auth/invite', '../src/app/api/auth/invite/route', 'POST'],
  ['/api/admin/subscriptions', '../src/app/api/admin/subscriptions/route', 'POST'],
];

const ALL = [...OUTBOUND_WRITE_ROUTES.map((r) => ['A', ...r] as const),
  ...DB_WRITE_ROUTES.map((r) => ['B', ...r] as const)];

/** 无凭据的写请求；body 用不完整但合法的 JSON，避免"解析失败"掩盖鉴权结论。 */
function unauthenticatedRequest(method: string): Request {
  return new Request('http://localhost/under-test', {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify({}),
  });
}

describe('未被任何测试引用过的写路由：中央守卫先于业务逻辑', () => {
  test('名单非空（否则这一节什么都没测）', () => {
    assert.ok(ALL.length >= 14, `只有 ${ALL.length} 条，名单可能被误删`);
  });

  for (const [group, path, modulePath, method] of ALL) {
    test(`[${group}] ${method} ${path}：无凭据必须 401/403`, async () => {
      const handler = await load(modulePath, method);
      const res = await handler(unauthenticatedRequest(method));
      assert.ok(
        res.status === 401 || res.status === 403,
        `${method} ${path} 无凭据时返回 ${res.status} —— 期望 401/403。`
        + '若它返回 400/500，说明业务逻辑在鉴权之前执行了；若返回 2xx，那是未授权可达的写入口。',
      );
    });
  }

  test('负向对照：本节的判定能区分"被拦住"与"没被拦住"', () => {
    // 纯逻辑对照：300 必须判红，401/403 判绿
    const ok = (status: number) => status === 401 || status === 403;
    assert.equal(ok(200), false, '200 必须判红');
    assert.equal(ok(400), false, '400 必须判红 —— 它意味着业务逻辑已经跑了');
    assert.equal(ok(500), false, '500 必须判红');
    assert.equal(ok(401), true);
    assert.equal(ok(403), true);
  });
});
