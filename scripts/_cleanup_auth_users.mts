/**
 * Phase 15 — 清理测试残留的 **auth 用户**（Supabase Auth schema）。
 *
 * ## 为什么单独一个脚本
 *
 * `_cleanup_test_residue.mts` 只处理 `public` schema；测试账号在 Supabase Auth 里
 * （`auth.users`）仍然存在。此前报告里把这条列为"残留、未处理"。
 *
 * ## 安全性
 *
 * - **默认零写入**：不带 `--apply` 只列出将要删除的账号。
 * - 只匹配测试账号的命名特征（`e2e-*@example.com` 等），
 *   绝不触碰真实用户；锚点账号（`houjinlong258@gmail.com`）显式排除。
 * - 删除经由 Supabase **Admin API**（service_role），不是直接改 auth 表 ——
 *   直接删表会留下孤立的 identities/sessions。
 *
 * ## 与 public 侧的关系
 *
 * 两边都要清：先删 public 侧（tenant/business 等），再删 auth 用户。
 * 反过来删 auth 用户，public.users 行会变成孤儿。
 */
import * as supabaseModule from '../src/storage/database/supabase-client';

const APPLY = process.argv.includes('--apply');

/** 测试账号的命名特征 —— 与各验收脚本注册时使用的邮箱前缀一致。
 *
 *  `boundary8-` 来自 tests/high-risk-routes.test.ts 早期版本，
 *  那一版会用 8 位密码真的走完注册（已修正为只测拒绝侧，不再产生副作用）。 */
const TEST_EMAIL = /^(e2e-|e2e_newtenant|e2e-approval|phase1[0-9]-|test-|rls-|boundary8-)/i;

/** 显式排除：初始管理员（真实账号，绝不可删） */
const PROTECTED = new Set(['houjinlong258@gmail.com']);

interface AuthUser {
  id: string;
  email?: string | null;
  created_at?: string | null;
}

function resolveExport<T>(mod: unknown, name: string): T {
  const m = mod as Record<string, unknown>;
  const direct = m?.[name];
  if (direct !== undefined) return direct as T;
  for (const carrier of ['default', 'module.exports']) {
    const bag = m?.[carrier] as Record<string, unknown> | undefined;
    const value = bag?.[name];
    if (value !== undefined) return value as T;
  }
  throw new Error(`cannot resolve export '${name}'`);
}

async function main(): Promise<number> {
  console.log('='.repeat(78));
  console.log(`Phase 15 — auth 测试账号清理${APPLY ? '【APPLY：会真的删除】' : '【仅计划，零写入】'}`);
  console.log('='.repeat(78));

  const getFreshServiceClient = resolveExport<() => {
    auth: {
      admin: {
        listUsers(opts: { page: number; perPage: number }): Promise<{
          data?: { users?: AuthUser[] }; error?: { message: string } | null;
        }>;
        deleteUser(id: string): Promise<{ error?: { message: string } | null }>;
      };
    };
  }>(supabaseModule, 'getFreshServiceClient');

  const client = getFreshServiceClient();

  // 分页拉取全部用户（管理员 API 单页上限 1000）
  const all: AuthUser[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) { console.log(`listUsers 失败: ${error.message}`); return 2; }
    const users = data?.users ?? [];
    all.push(...users);
    if (users.length < 1000) break;
  }

  console.log(`auth 用户总数: ${all.length}`);
  console.log('');

  const targets = all.filter((u) => {
    const email = String(u.email ?? '');
    if (!email) return false;
    if (PROTECTED.has(email.toLowerCase())) return false;
    return TEST_EMAIL.test(email);
  });

  console.log(`匹配测试特征且非受保护账号: ${targets.length}`);
  for (const u of targets) {
    console.log(`  - ${String(u.created_at ?? '').slice(0, 19)}  ${u.email}`);
  }
  const kept = all.filter((u) => !targets.includes(u));
  console.log('');
  console.log(`保留 ${kept.length} 个账号:`);
  for (const u of kept.slice(0, 10)) console.log(`  · ${u.email}`);
  if (kept.length > 10) console.log(`  … 其余 ${kept.length - 10} 个`);

  if (!APPLY) {
    console.log('');
    console.log('='.repeat(78));
    console.log('这是计划。要真的删除，加 --apply 重跑。');
    console.log('建议顺序：先跑 _cleanup_test_residue.mts（public 侧），再跑本脚本。');
    console.log('='.repeat(78));
    return 0;
  }

  console.log('');
  console.log('执行删除…');
  let ok = 0;
  let failed = 0;
  for (const u of targets) {
    const { error } = await client.auth.admin.deleteUser(String(u.id));
    if (error) { failed += 1; console.log(`  ! ${u.email}: ${error.message.slice(0, 90)}`); }
    else { ok += 1; console.log(`  已删 ${u.email}`); }
  }
  console.log('');
  console.log(`完成：成功 ${ok}，失败 ${failed}。`);
  console.log('='.repeat(78));
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 800).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
