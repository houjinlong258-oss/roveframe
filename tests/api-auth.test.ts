/**
 * 改进 4 — API 层鉴权测试
 *
 * 直接调用路由 handler（不经 HTTP 服务器），验证未携带凭据时
 * 所有受保护管理 API 一律 401，且错误语义为 unauthorized。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';

import { GET as codingGet, POST as codingPost, PATCH as codingPatch } from '../src/app/api/coding-agent/route';
import { GET as healingGet, POST as healingPost } from '../src/app/api/healing/route';
import { POST as customizationPost } from '../src/app/api/customization/route';
import { POST as deploymentPost } from '../src/app/api/deployment/route';
import { GET as enterpriseGet, POST as enterprisePost } from '../src/app/api/enterprise/route';
import { POST as applyPost } from '../src/app/api/coding-agent/apply/route';
import { POST as rollbackPost } from '../src/app/api/coding-agent/rollback/route';

// withAuth 泛型从 handler 推断出 NextRequest；测试里构造的裸 Request
// 在运行时完全够用（只读 headers/url/body），此处仅做类型层适配
function req(url: string, method = 'GET', body?: unknown): NextRequest {
  return new Request(`http://localhost${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

async function expect401(res: Response, label: string): Promise<void> {
  assert.equal(res.status, 401, `${label} should be 401, got ${res.status}`);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? '', /unauthorized/, label);
}

describe('API auth layer: unauthenticated requests are rejected', () => {
  const cases: Array<[string, () => Promise<Response>]> = [
    ['GET /api/coding-agent', () => codingGet(req('/api/coding-agent'))],
    ['POST /api/coding-agent', () => codingPost(req('/api/coding-agent', 'POST', { description: 'x' }))],
    ['PATCH /api/coding-agent', () => codingPatch(req('/api/coding-agent', 'PATCH', { id: 'a', status: 'approved' }))],
    ['GET /api/healing', () => healingGet(req('/api/healing'))],
    ['POST /api/healing', () => healingPost(req('/api/healing', 'POST', { message: 'boom' }))],
    ['POST /api/customization', () => customizationPost(req('/api/customization', 'POST', { prompt: '会员日' }))],
    ['POST /api/deployment', () => deploymentPost(req('/api/deployment', 'POST', {}))],
    ['GET /api/enterprise', () => enterpriseGet(req('/api/enterprise'))],
    ['POST /api/enterprise', () => enterprisePost(req('/api/enterprise', 'POST', { toolId: 'system.health_check' }))],
    ['POST /api/coding-agent/apply', () => applyPost(req('/api/coding-agent/apply', 'POST', { id: 'x' }))],
    ['POST /api/coding-agent/rollback', () => rollbackPost(req('/api/coding-agent/rollback', 'POST', { id: 'x' }))],
  ];

  for (const [label, fn] of cases) {
    test(`${label} → 401 without credentials`, async () => {
      await expect401(await fn(), label);
    });
  }

  test('forged Bearer token also rejected (no session, no crash)', async () => {
    const res = await codingGet(
      new Request('http://localhost/api/coding-agent', {
        headers: { Authorization: 'Bearer forged.token.here' },
      }) as unknown as NextRequest
    );
    // 无 DB 环境下解析失败 → 必须 fail closed 成 401；绝不能是 200 或 500 崩溃
    assert.equal(res.status, 401);
  });
});
