import { test } from 'node:test';
import assert from 'node:assert/strict';

// P0-2：service_role→anon 静默回落治理 + 模块级客户端缓存。
// 注意：supabase-client 的 loadEnv 在 COZE_SUPABASE_URL + COZE_SUPABASE_ANON_KEY
// 均已设置时直接返回（不触发 execSync 探测），且 getSupabaseCredentials 每次
// 实时读取 process.env —— 因此本测试可在同一进程中切换环境变量断言。
import { getSupabaseClient } from '../src/storage/database/supabase-client';

const ORIGINAL = {
  url: process.env.COZE_SUPABASE_URL,
  anonKey: process.env.COZE_SUPABASE_ANON_KEY,
  serviceRoleKey: process.env.COZE_SUPABASE_SERVICE_ROLE_KEY,
  projectEnv: process.env.COZE_PROJECT_ENV,
};

function setEnv(url: string, anonKey: string, serviceRoleKey?: string, projectEnv?: string): void {
  process.env.COZE_SUPABASE_URL = url;
  process.env.COZE_SUPABASE_ANON_KEY = anonKey;
  if (serviceRoleKey === undefined) delete process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
  else process.env.COZE_SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey;
  if (projectEnv === undefined) delete process.env.COZE_PROJECT_ENV;
  else process.env.COZE_PROJECT_ENV = projectEnv;
}

function restoreEnv(): void {
  if (ORIGINAL.url === undefined) delete process.env.COZE_SUPABASE_URL;
  else process.env.COZE_SUPABASE_URL = ORIGINAL.url;
  if (ORIGINAL.anonKey === undefined) delete process.env.COZE_SUPABASE_ANON_KEY;
  else process.env.COZE_SUPABASE_ANON_KEY = ORIGINAL.anonKey;
  if (ORIGINAL.serviceRoleKey === undefined) delete process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
  else process.env.COZE_SUPABASE_SERVICE_ROLE_KEY = ORIGINAL.serviceRoleKey;
  if (ORIGINAL.projectEnv === undefined) delete process.env.COZE_PROJECT_ENV;
  else process.env.COZE_PROJECT_ENV = ORIGINAL.projectEnv;
}

test('P0-2 生产缺失 service role key 时 fail-closed 抛错，绝不回落 anon', () => {
  setEnv('https://prod.example.supabase.co', 'anon-prod', undefined, 'PROD');
  try {
    assert.throws(
      () => getSupabaseClient(),
      /COZE_SUPABASE_SERVICE_ROLE_KEY is not set/,
    );
  } finally {
    restoreEnv();
  }
});

test('P0-2 非生产缺失 service role key 时保留 anon 回落（演示环境）', () => {
  setEnv('https://dev.example.supabase.co', 'anon-dev', undefined, 'DEV');
  try {
    const client = getSupabaseClient();
    assert.ok(client, 'anon 回落应返回可用客户端');
  } finally {
    restoreEnv();
  }
});

test('P0-2 生产配置齐备时正常返回客户端', () => {
  setEnv('https://prod.example.supabase.co', 'anon-prod', 'service-prod', 'PROD');
  try {
    assert.ok(getSupabaseClient());
  } finally {
    restoreEnv();
  }
});

test('P0-2 无 token 客户端按 url+key 复用同一实例（避免每请求重建）', () => {
  setEnv('https://cache.example.supabase.co', 'anon-cache', 'service-cache', 'PROD');
  try {
    const first = getSupabaseClient();
    const second = getSupabaseClient();
    assert.equal(first, second, '相同 url+service key 必须复用同一客户端实例');
  } finally {
    restoreEnv();
  }
});

test('P0-2 不同 service key 生成不同实例', () => {
  setEnv('https://cache.example.supabase.co', 'anon-cache', 'service-cache', 'PROD');
  const first = getSupabaseClient();
  setEnv('https://cache.example.supabase.co', 'anon-cache', 'service-rotated', 'PROD');
  try {
    const rotated = getSupabaseClient();
    assert.notEqual(first, rotated, 'key 轮换后必须重建客户端实例');
  } finally {
    restoreEnv();
  }
});

test('P0-2 带 token 的客户端不缓存（按用户会话变化）', () => {
  setEnv('https://token.example.supabase.co', 'anon-token', 'service-token', 'PROD');
  try {
    const a = getSupabaseClient('user-token-a');
    const b = getSupabaseClient('user-token-a');
    assert.notEqual(a, b, '带 token 的客户端每次新建，避免跨用户串会话');
  } finally {
    restoreEnv();
  }
});
