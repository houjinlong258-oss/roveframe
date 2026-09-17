/**
 * Phase 15 — DDL 连通性探测（只读，不打印任何凭据）。
 *
 * 目的：确认本机能否连到 Supabase Postgres，以便应用
 * `scripts/migrate-runtime-metadata.sql`（Phase 15 §5 的 UNVERIFIED 项）。
 *
 * 凭据来源：环境变量 DATABASE_URL（由调用方从临时文件注入，不落仓库）。
 * 本脚本只报告连通性与服务端信息，**不回显连接串**。
 */
import { Client } from 'pg';

function safeHost(raw: string | undefined): string {
  if (!raw) return '(DATABASE_URL 未设置)';
  try {
    const u = new URL(raw);
    return `${u.hostname}:${u.port || '(default)'} db=${u.pathname.replace(/^\//, '')}`;
  } catch {
    return '(无法解析的连接串)';
  }
}

async function tryConnect(label: string, connectionString: string): Promise<boolean> {
  const client = new Client({
    connectionString,
    // 直连是 IPv6-only，池化器是 IPv4；给一个短超时以便快速判断
    connectionTimeoutMillis: 12_000,
    ssl: { rejectUnauthorized: false },
  });
  const t0 = Date.now();
  try {
    await client.connect();
    const info = await client.query<{ version: string; current_user: string; inet_server_addr: string | null }>(
      'select version(), current_user, inet_server_addr()::text',
    );
    const row = info.rows[0];
    console.log(`  [${label}] 连接成功（${Date.now() - t0} ms）`);
    console.log(`      version: ${String(row.version).slice(0, 60)}…`);
    console.log(`      user: ${row.current_user}`);
    console.log(`      server_addr: ${row.inet_server_addr ?? '(null)'}`);
    await client.end();
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [${label}] 连接失败（${Date.now() - t0} ms）: ${msg.slice(0, 160)}`);
    try { await client.end(); } catch { /* ignore */ }
    return false;
  }
}

async function main(): Promise<number> {
  console.log('='.repeat(78));
  console.log('Phase 15 — DDL 连通性探测');
  console.log('='.repeat(78));

  const dsn = process.env.DATABASE_URL;
  console.log(`DATABASE_URL 已设置: ${Boolean(dsn)}`);
  console.log(`目标: ${safeHost(dsn)}`);
  console.log('');

  if (!dsn) {
    console.log('未提供 DATABASE_URL，无法探测。');
    return 2;
  }

  // 1) 直接使用给定连接串
  const ok = await tryConnect('as-given', dsn);
  if (ok) {
    console.log('');
    console.log('结论: 给定连接串可用。');
    return 0;
  }

  // 2) 回退：把 db.<ref>.supabase.co 换成 Session pooler 主机
  try {
    const u = new URL(dsn);
    const ref = u.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1];
    if (ref) {
      for (const host of [
        'aws-0-us-east-1.pooler.supabase.com',
        'aws-1-us-east-1.pooler.supabase.com',
        'aws-0-us-west-1.pooler.supabase.com',
      ]) {
        const pooled = `${u.protocol}//postgres.${ref}:${encodeURIComponent(decodeURIComponent(u.password))}@${host}:5432/postgres`;
        const good = await tryConnect(`pooler ${host}`, pooled);
        if (good) {
          console.log('');
          console.log(`结论: 直连不可达，但 Session pooler 可用 -> ${host}`);
          console.log('（Phase 14/AGENTS.md 记录：db.<ref>.supabase.co 是 IPv6-only，本机不可达）');
          return 0;
        }
      }
    }
  } catch {
    // 解析失败则不回退
  }

  console.log('');
  console.log('结论: 直连与常见 pooler 主机均不可达。');
  return 1;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 500).unref(); })
  .catch((e: unknown) => { console.error('探测崩溃:', e); process.exitCode = 2; });
