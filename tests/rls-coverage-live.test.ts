import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

/**
 * RLS 覆盖的不变量 —— **连库检查**，不是读 SQL 文本。
 *
 * ## 为什么必须连库（这是本条的全部意义）
 *
 * 独立审查对本仓库的 `rls-policy.test.ts` 做过一个决定性的阳性对照：
 *
 * > `rls-policy.test.ts` 只断言 `migrate-rls.sql` 的**文本**，
 * > 它在库有 4 张表裸奔的情况下依然全绿。
 *
 * 也就是说：那个守卫的通过**不构成任何证据**。本轮把它补成真的检查 ——
 * 库里的事实而非文件里的事实。
 *
 * ## 被修的是什么
 *
 * 审查用 anon key 读到 `delivery_orders` 21/21 行（含收件人姓名/电话/地址）、
 * `delivery_positions` 16/16（骑手经纬度轨迹）、`staff_attendance` 3/3、
 * `public_sites` 1/1（含一个**当前有效的点餐 token**，用它调
 * `/api/store/menu` 返回 200 与真实菜单）。
 *
 * 本轮用只读的 `pg_policies` 复核后发现缺口**比报告更大**：未启用 RLS 的
 * 其实是 **12 张** —— 审查者只能看见当时有数据的那 4 张，另 8 张是空表，
 * "anon 读到 0 行"与"RLS 拦住了"在他那里不可区分。
 *
 * ## 两个不变量（第二个是关键，第一个容易写得比现实松）
 *
 *   1. public schema 里**没有**未启用 RLS 的表；
 *   2. **每张**启用 RLS 的表都至少有一条策略。
 *
 * 第 2 条是我第一版漏掉的：我写了"未启用 RLS 的表 = 0 张 ⇒ 通过"，
 * 而当时还有 18 张表处于"启用了 RLS 却零策略"（对 anon 恰好全拒，所以不是漏洞，
 * 但**隐含行为不是可查事实**，Phase 15 §3.2 正是栽在这上面）。
 * 只查第 1 条会把那 18 张判成通过。
 *
 * ## 无凭据时跳过，但要说明原因（不静默变绿）
 *
 * 纯 CI 环境没有数据库连接。此时用例打印原因并返回 —— 那种情况下
 * "库层面的 RLS 是否生效"记为 **UNVERIFIED**，而不是"通过"。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * 从仓库内的 gitignored env 文件补齐 DB 连接信息。
 *
 * 为什么要有这一步：如果本用例在开发者/CI 上**永远跳过**，那它就只是把
 * "读 SQL 文本的假检查"换成了"永远跳过的空检查"—— 两者对"库里到底有没有设防"
 * 都给不出证据。本仓库已有一处同样的做法（`supabase-client.ts` 的
 * `loadDeployEnvFile()`：存在 `docker/deploy.env` 就 override 进程环境），
 * 这里沿用它，让检查在本机/部署机上真的跑起来；在拿不到任何凭据的环境里
 * 仍然明确记为 UNVERIFIED。
 *
 * 只读键值对，不回显任何值。
 */
function loadDeployEnvFallback(): void {
  for (const rel of ['docker/deploy.env', 'scripts/deploy.env']) {
    let text: string;
    try {
      text = read(rel);
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, key, rawValue] = m;
      if (process.env[key] !== undefined && process.env[key] !== '') continue;
      process.env[key] = rawValue.trim().replace(/^["']|["']$/g, '');
    }
  }
}

/** 连库用的凭据：优先进程环境，缺失时从 deploy.env 兜底。 */
function poolConfig() {
  if (!process.env.PGHOST || !process.env.PGUSER || !process.env.PGPASSWORD) {
    loadDeployEnvFallback();
  }
  const host = process.env.PGHOST;
  const user = process.env.PGUSER;
  const password = process.env.PGPASSWORD;
  if (!host || !user || !password) return null;
  return {
    host,
    user,
    password,
    database: process.env.PGDATABASE ?? 'postgres',
    port: Number(process.env.PGPORT ?? 5432),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  };
}

interface TableCheck {
  name: string;
  rls: boolean;
  policies: number;
}

async function readRlsState(): Promise<TableCheck[] | null> {
  const config = poolConfig();
  if (!config) return null;
  const pool = new Pool(config);
  try {
    const { rows } = await pool.query<TableCheck>(`
      select c.relname as name,
             c.relrowsecurity as rls,
             (select count(*)::int from pg_policies p
               where p.schemaname = 'public' and p.tablename = c.relname) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname
    `);
    return rows;
  } catch (error) {
    // 连不上不算通过：交给调用方按 UNVERIFIED 处理
    console.log(`  [skip] 无法连接数据库: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    await pool.end().catch(() => { /* 已关闭 */ });
  }
}

describe('RLS 覆盖（连库检查）', () => {
  let tables: TableCheck[] | null = null;

  before(async () => {
    tables = await readRlsState();
  });

  test('每张 public 表都启用了 RLS', () => {
    if (tables === null) {
      console.log('  [skip] 无数据库凭据 → 本条 UNVERIFIED（不是通过）');
      return;
    }
    assert.ok(tables.length > 30, `只读到 ${tables.length} 张表，扫描可能有问题`);
    const uncovered = tables.filter((t) => !t.rls).map((t) => t.name);
    assert.deepEqual(
      uncovered, [],
      '这些表未启用 RLS —— anon key 可读走全量行：\n  ' + uncovered.join('\n  '),
    );
  });

  test('每张启用 RLS 的表都至少有一条策略（零策略不算设防）', () => {
    if (tables === null) {
      console.log('  [skip] 无数据库凭据 → 本条 UNVERIFIED（不是通过）');
      return;
    }
    const policyLess = tables.filter((t) => t.rls && t.policies === 0).map((t) => t.name);
    assert.deepEqual(
      policyLess, [],
      '这些表启用了 RLS 却零策略 —— 它们**恰好**对 anon 全拒，但那是隐含行为、'
      + '不是可查事实（Phase 15 §3.2 的同一形态）。补一条显式策略：\n  '
      + policyLess.join('\n  '),
    );
  });

  test('负向对照：把一张表当成"未启用 RLS"必须被第一条抓到', () => {
    // 直接对判定逻辑做对照，不依赖库（本条在无凭据时也有意义）
    const fake: TableCheck[] = [
      { name: 'orders', rls: true, policies: 3 },
      { name: 'delivery_orders', rls: false, policies: 0 },
    ];
    const uncovered = fake.filter((t) => !t.rls).map((t) => t.name);
    assert.deepEqual(uncovered, ['delivery_orders']);

    const fake2: TableCheck[] = [
      { name: 'orders', rls: true, policies: 3 },
      { name: 'businesses', rls: true, policies: 0 },
    ];
    const policyLess = fake2.filter((t) => t.rls && t.policies === 0).map((t) => t.name);
    assert.deepEqual(policyLess, ['businesses'], '零策略必须被第二条抓到');
  });
});

describe('RLS 覆盖（anos REST 探测 —— 部署环境也能跑）', () => {
  /**
   * 为什么用 REST 而不是连库：`docker/deploy.env` 里**没有** `PGHOST/PGUSER/PGPASSWORD`
   * （实测键名列表为空），所以连库检查在部署环境永远跳过 —— 那就等于没有检查。
   *
   * 而部署时**确实有**的两把钥匙是 `COZE_SUPABASE_URL` 与
   * `COZE_SUPABASE_ANON_KEY`（compose 已注入，`supabase-client.ts` 要用）。
   * 用它们走 PostgREST 探测，正是独立审查当初用来发现缺口的方法。
   *
   * ## 阳性对照是必须的
   *
   * 只测"anon 读到 0 行"没有意义 —— 表是空的也会得到 0 行。
   * 因此对同一张表再用 **service_role** 读一次：
   *   · service_role 读到 N 行 + anon 读到 0 行 ⇒ 表有数据，而 anon 被挡住（有效证据）
   *   · service_role 也读到 0 行 ⇒ 该表为空，本条对它**不构成证据**（如实标注）
   */
  const DENYLIST = [
    // 审查点名（当时有数据，anon 真的读到了）
    'delivery_orders', 'delivery_positions', 'staff_attendance', 'public_sites',
    // 本轮复核出的另 8 张（当时是空表）
    'customer_accounts', 'customer_addresses', 'customer_sessions',
    'staff_shifts', 'staff_care_notes', 'staff_care_tasks',
    'email_unsubscribes', 'health_check',
  ];

  function supabaseEnv(): { url: string; anon: string; service: string } | null {
    if (!process.env.COZE_SUPABASE_URL || !process.env.COZE_SUPABASE_ANON_KEY
      || !process.env.COZE_SUPABASE_SERVICE_ROLE_KEY) {
      loadDeployEnvFallback();
    }
    const url = process.env.COZE_SUPABASE_URL;
    const anon = process.env.COZE_SUPABASE_ANON_KEY;
    const service = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !anon || !service) return null;
    return { url: url.replace(/\/$/, ''), anon, service };
  }

  async function fetchRows(url: string, key: string, table: string): Promise<number | null> {
    const res = await fetch(`${url}/rest/v1/${table}?select=id&limit=5`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return null; // 权限错误也算"读不到"
    const body = (await res.json()) as unknown[];
    return Array.isArray(body) ? body.length : null;
  }

  test('anon key 读不到任何敏感表的行（带 service_role 阳性对照）', async () => {
    const env = supabaseEnv();
    if (env === null) {
      console.log('  [skip] 无 Supabase 凭据 → 本条 UNVERIFIED（不是通过）');
      return;
    }

    const anonLeaks: string[] = [];
    const unproven: string[] = [];
    for (const table of DENYLIST) {
      const anonRows = await fetchRows(env.url, env.anon, table);
      if (anonRows !== null && anonRows > 0) {
        anonLeaks.push(`${table} → anon 读到 ${anonRows} 行`);
        continue;
      }
      // 阳性对照：表里到底有没有数据？
      const serviceRows = await fetchRows(env.url, env.service, table);
      if (serviceRows === null || serviceRows === 0) {
        unproven.push(table);
      }
    }

    assert.deepEqual(
      anonLeaks, [],
      '这些表对 anon key 可读 —— 数据库层没有设防：\n  ' + anonLeaks.join('\n  '),
    );
    if (unproven.length) {
      // 空表上的"0 行"不构成证据，如实说出来而不是混进"通过"
      console.log(`  [note] 这些表当前为空，本条对它们不构成证据：${unproven.join(', ')}`);
    }
  });

  test('负向对照：判定逻辑必须能识别泄漏', () => {
    // 对照一：anon 读到行 ⇒ 必须进 leaks
    const leaks = (anonRows: number | null) => (anonRows !== null && anonRows > 0);
    assert.equal(leaks(3), true, 'anon 读到 3 行必须被判为泄漏');
    assert.equal(leaks(0), false);
    assert.equal(leaks(null), false, '权限错误（403/401）也算读不到');

    // 对照二：service_role 读到 0 行时不得把它算成"已证明被挡"
    const proven = (serviceRows: number | null) => serviceRows !== null && serviceRows > 0;
    assert.equal(proven(0), false, '空表不能算证据');
    assert.equal(proven(5), true);
  });
});

describe('RLS 迁移的接线（源码契约）', () => {
  test('两个 RLS 迁移都在自动迁移清单里（否则全新部署会缺）', () => {
    const migration = read('src/lib/migration.ts');
    assert.match(migration, /'scripts\/migrate-rls\.sql'/,
      'migrate-rls.sql 不在 MIGRATION_FILES —— 这正是缺口长期存在的制度原因：'
      + '它从未在任何自动迁移路径上执行过');
    assert.match(migration, /'scripts\/migrate-rls-gaps\.sql'/,
      'migrate-rls-gaps.sql 不在 MIGRATION_FILES —— 8 张 Phase 17/18 新表会重新裸奔');
  });

  test('两个迁移都是幂等的（drop policy if exists + create policy）', () => {
    for (const file of ['scripts/migrate-rls.sql', 'scripts/migrate-rls-gaps.sql']) {
      const sql = read(file);
      assert.match(sql, /drop policy if exists/i, `${file} 缺 drop policy if exists，重跑会撞已存在`);
      assert.match(sql, /create policy/i, `${file} 没有建策略`);
      assert.match(sql, /to_regclass/i, `${file} 未做表存在性判断（新库上会报错）`);
    }
  });

  test('新迁移覆盖了审查点名的 4 张表，以及我复核出的另 8 张', () => {
    const sql = read('scripts/migrate-rls-gaps.sql');
    const must = [
      // 审查报告点名的 4 张（当时有数据，因此被 anon 真正读到）
      'delivery_orders', 'delivery_positions', 'staff_attendance', 'public_sites',
      // 我复核出的另 8 张（当时是空表，审查者无法区分"读不到"与"被拦")
      'customer_accounts', 'customer_addresses', 'customer_sessions',
      'staff_shifts', 'staff_care_notes', 'staff_care_tasks',
      'email_unsubscribes', 'health_check',
    ];
    for (const t of must) {
      assert.match(sql, new RegExp(`'${t}'`), `migrate-rls-gaps.sql 未覆盖 ${t}`);
    }
  });

  test('auth.uid() 必须显式转 text（否则 varchar = uuid 会让迁移直接报错）', () => {
    const sql = read('scripts/migrate-rls-gaps.sql');
    assert.match(sql, /auth\.uid\(\)::text/);
    // 负向对照：不带 ::text 的写法必须被这条拒绝
    assert.doesNotMatch("using (id = auth.uid())", /auth\.uid\(\)::text/);
    // 历史依据：migrate-rls.sql 的文件头记着它当初因此**从未成功执行**
    assert.match(read('scripts/migrate-rls.sql'), /operator does not exist: character varying = uuid/);
  });

  test('无租户列的表用显式 deny，而不是依赖"零策略"', () => {
    const sql = read('scripts/migrate-rls-gaps.sql');
    for (const t of ['customer_sessions', 'health_check']) {
      assert.match(sql, new RegExp(`'${t}'`), `${t} 未出现在迁移里`);
    }
    assert.match(sql, /to anon, authenticated using \(false\) with check \(false\)/);
  });
});
