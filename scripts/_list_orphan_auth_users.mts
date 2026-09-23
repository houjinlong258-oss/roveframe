/**
 * 孤儿 `auth.users` 的**判定 + 备份 + 可选清理**（Phase 19 非阻塞项 8）。
 *
 * ## 判定条件（什么算孤儿）
 *
 *   auth.users 里存在一个账号 U，而 `public.users` 里**不存在** `id = U.id` 的行。
 *
 * 为什么这个条件是有意义的（而不是随便定的）：
 *   · 应用的角色与租户归属只来自 `public.users`（`role` / `tenant_id` /
 *     `business_id`）。没有那一行，`resolveUserByToken` 拿不到 role，
 *     RBAC 会 fail-closed 拒绝 —— 也就是说这些账号**登录后什么也做不了**；
 *   · 逐条实测过：16 条孤儿全部由测试脚本创建（`rollback-*` / `verify-*` /
 *     `probe-*` / `e2e-phase15-*` / `phase16-*` / `e2e-newtenant-*`），
 *     不是真实用户。
 *
 * ## 不可逆风险（为什么默认不动手）
 *
 *   1. 删除 `auth.users` 行是**不可逆**的：本仓库没有 auth schema 的备份通道
 *      （`scripts/backup.mjs` 备份的是 RoveAgent 数据根，不含 Supabase 的 auth 表）。
 *   2. 删除可能牵连会话/身份类记录，且无法从本仓库恢复。
 *   3. 这 16 条的存在**不构成功能缺陷**（它们登录不了），因此"留下来"的代价
 *      远小于"删错"的代价。
 *
 * 所以本脚本的行为是：
 *   · **默认只列出**（dry-run，零写入）；
 *   · `--export <file>`：把将受影响的账号写到 JSON（这就是"没有备份不要删"里的备份）；
 *   · `--delete --export <file>`：只有同时给了备份路径才允许删，且逐条报结果。
 *
 * 凭据只从 docker/deploy.env（或进程环境）读，不落盘、不打印。
 *
 * 用法：
 *   npx tsx scripts/_list_orphan_auth_users.mts
 *   npx tsx scripts/_list_orphan_auth_users.mts --export orphans.json
 *   npx tsx scripts/_list_orphan_auth_users.mts --delete --export orphans.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const valueOf = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

/** 受保护的账号：绝不参与清理（演示 owner、演示员工、另一位代理的账号）。 */
const PROTECTED_EMAILS = new Set([
  'houjinlong258@gmail.com',
  'staff.demo@roveframe.local',
  '3440869867@qq.com',
]);

function loadEnv(): void {
  for (const rel of ['docker/deploy.env', 'scripts/deploy.env']) {
    let text: string;
    try { text = readFileSync(rel, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      if (process.env[m[1]] !== undefined && process.env[m[1]] !== '') continue;
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

interface AuthUser { id: string; email?: string | null; created_at?: string; email_confirmed_at?: string | null }
interface PublicUser { id: string; email?: string | null }

async function main(): Promise<number> {
  loadEnv();
  const url = process.env.COZE_SUPABASE_URL;
  const key = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('缺少 COZE_SUPABASE_URL / COZE_SUPABASE_SERVICE_ROLE_KEY');
    return 2;
  }
  const base = url.replace(/\/$/, '');
  const headers = { apikey: key, authorization: `Bearer ${key}` };

  const authRes = await fetch(`${base}/auth/v1/admin/users?per_page=200`, { headers });
  if (!authRes.ok) { console.error(`auth admin API 返回 ${authRes.status}`); return 2; }
  const authUsers: AuthUser[] = (await authRes.json()).users ?? [];

  const pubRes = await fetch(`${base}/rest/v1/users?select=id,email`, { headers });
  if (!pubRes.ok) { console.error(`public.users 查询返回 ${pubRes.status}`); return 2; }
  const publicUsers: PublicUser[] = await pubRes.json();

  const known = new Set(publicUsers.map((u) => u.id));
  const orphans = authUsers.filter((u) => !known.has(u.id));
  const protectedOnes = orphans.filter((u) => PROTECTED_EMAILS.has(String(u.email ?? '')));
  const deletable = orphans.filter((u) => !PROTECTED_EMAILS.has(String(u.email ?? '')));

  console.log('判定条件：auth.users 有行 且 public.users 无 id 相同的行');
  console.log(`auth.users=${authUsers.length} public.users=${publicUsers.length}`);
  console.log(`孤儿=${orphans.length}（其中受保护 ${protectedOnes.length}，可清理 ${deletable.length}）`);
  for (const u of orphans) {
    const flag = PROTECTED_EMAILS.has(String(u.email ?? '')) ? ' [受保护，不动]' : '';
    console.log(`  ${u.id}  ${u.email ?? '(无邮箱)'}  created=${u.created_at ?? '?'} confirmed=${Boolean(u.email_confirmed_at)}${flag}`);
  }

  const exportPath = valueOf('--export');
  if (exportPath) {
    writeFileSync(exportPath, JSON.stringify({
      exportedAt: new Date().toISOString(),
      criteria: 'auth.users row with no public.users row of the same id',
      protectedEmails: [...PROTECTED_EMAILS],
      orphans,
    }, null, 2));
    console.log(`\n已导出备份（这就是"没有备份不要删"里的备份）：${exportPath}`);
  }

  if (!has('--delete')) {
    console.log('\nDRY RUN：未删除任何账号。要删除必须同时给 --delete 与 --export。');
    return 0;
  }
  if (!exportPath) {
    console.error('\n拒绝执行：--delete 必须与 --export <file> 一起使用（先备份再删）。');
    return 2;
  }

  console.log(`\n开始删除 ${deletable.length} 个孤儿账号…`);
  let ok = 0;
  let failed = 0;
  for (const u of deletable) {
    const res = await fetch(`${base}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers });
    if (res.ok) { ok++; console.log(`  deleted ${u.email ?? u.id}`); }
    else { failed++; console.error(`  FAILED ${u.email ?? u.id} -> HTTP ${res.status}`); }
  }
  console.log(`\n完成：deleted=${ok} failed=${failed} protected_skipped=${protectedOnes.length}`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
