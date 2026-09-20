import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 15 —— 迁移的**列级**覆盖守卫。
 *
 * ## 被守住的东西
 *
 * `src/app/api/agent/chat/route.ts` 每轮对话都往 `chat_sessions` 写 5 个
 * `runtime_*` 列，用于回答「这条回答是 RoveAgent Runtime 出的，还是 TS 降级出的」。
 *
 * 这 5 列的 DDL 只存在于 `scripts/migrate-runtime-metadata.sql`，而该文件
 * **不在** `src/lib/migration.ts` 的 `MIGRATION_FILES` 清单里 —— 于是任何自动
 * 迁移路径都不会创建它们。实测后果（Phase 15 真实容器日志，重复出现）：
 *
 *     [agent/chat] runtime metadata columns unavailable;
 *       run scripts/migrate-runtime-metadata.sql:
 *       Could not find the 'runtime_agent' column of 'chat_sessions'
 *
 * 即：审计元数据**从未**写入过，而该迁移存在的全部目的就是让这件事可查证。
 *
 * ## 为什么 CI 没拦住
 *
 * `scripts/verify-migrations.mjs` 只断言「schema.ts 的**表名**出现在某个
 * migrate*.sql 里」与索引口径，**从不比对列**。表在、列不在，它一路绿灯。
 * 本文件补上列级断言。
 *
 * ## 这些断言为什么必须来自源码而不是硬编码清单
 *
 * 硬编码一份"期望的列名"只是把同一份信息抄一遍，代码改了它不会跟着改。
 * 因此这里从**生产代码原文**抽取它真正会写的列名，再回到迁移 SQL 里找定义。
 */

const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** 生产代码里真正会写入 chat_sessions 的 runtime_* 列 */
function runtimeColumnsUsedByChatRoute(): string[] {
  const src = read('src/app/api/agent/chat/route.ts');
  const block = src.match(/const runtimeMetadata = \{([\s\S]*?)\};/);
  assert.ok(block, '未能在 chat/route.ts 中找到 runtimeMetadata 定义 —— 代码结构已变，请更新本测试');
  const cols = [...block[1].matchAll(/^\s*(runtime_\w+)\s*:/gm)].map((m) => m[1]);
  assert.ok(cols.length > 0, 'runtimeMetadata 里没有解析到 runtime_* 列');
  return cols;
}

describe('migration column coverage (Phase 15)', () => {
  test('自动迁移清单包含 runtime metadata 迁移', async () => {
    const mod = await import('../src/lib/migration');
    const files = mod.MIGRATION_FILE_LIST;
    assert.ok(
      files.includes('scripts/migrate-runtime-metadata.sql'),
      'MIGRATION_FILES 又漏掉了 scripts/migrate-runtime-metadata.sql —— '
      + 'chat_sessions 的 runtime_* 列将不会被任何自动迁移创建，'
      + '审计元数据会重新变成"永远写不进去"。',
    );
  });

  test('MIGRATION_FILES 引用的 SQL 文件都真实存在', async () => {
    const mod = await import('../src/lib/migration');
    for (const rel of mod.MIGRATION_FILE_LIST) {
      assert.ok(existsSync(join(ROOT, rel)), `迁移清单引用了不存在的文件：${rel}`);
    }
  });

  test('chat/route.ts 写的每个 runtime_* 列都在自动迁移的 SQL 里有定义', async () => {
    const mod = await import('../src/lib/migration');
    const sql = mod.MIGRATION_FILE_LIST
      .map((rel) => read(rel))
      .join('\n');

    const used = runtimeColumnsUsedByChatRoute();
    assert.ok(used.length > 0);

    const missing = used.filter((col) => {
      // 只认 "ADD COLUMN ... <col>" 或建表时直接列出该列名的形态
      const addColumn = new RegExp(`add column if not exists\\s+${col}\\b`, 'i').test(sql);
      const inCreate = new RegExp(`\\b${col}\\b\\s+(varchar|text|timestamptz|timestamp|jsonb|boolean|integer|numeric)`, 'i').test(sql);
      return !addColumn && !inCreate;
    });

    assert.deepEqual(
      missing, [],
      `这些列由生产代码写入，但不在任何自动迁移 SQL 中，部署后必然报缺失：${missing.join(', ')}。`
      + `（自动迁移执行的是：${mod.MIGRATION_FILE_LIST.join(', ')}）`,
    );
  });

  test('迁移文件确实定义了 runtime_agent（防止断言写虚）', () => {
    const sql = read('scripts/migrate-runtime-metadata.sql');
    for (const col of ['runtime_mode', 'runtime_agent', 'runtime_request_class', 'runtime_tool_intent', 'runtime_at']) {
      assert.match(
        sql, new RegExp(`add column if not exists\\s+${col}\\b`, 'i'),
        `migrate-runtime-metadata.sql 未定义 ${col}`,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Phase 15：把守卫从"某一个迁移"扩展到"这一类缺陷"。
  //
  // runtime-metadata 只是被发现的**一个实例**。同类缺陷是：
  // 仓库里存在一个迁移，它创建的对象被代码使用，但它不在自动迁移清单里。
  //
  // ## 第一版守卫是错的（记录在此，避免重犯）
  //
  // 第一版写的是"每个 migrate*.sql 创建的表都必须被自动清单覆盖"。
  // **它无法失败**：把 migrate-platform-admin.sql 从清单里删掉，它照样通过。
  // 原因实测如下 —— 所有非自动迁移创建的表，`migrate.sql` 本来就都创建了：
  //
  //   migrate.sql 创建 31 张，其中已包含
  //     platform-admin 的 9 张全部、production-hardening 的 audit_logs、
  //     feature_entitlements / invoices / subscription_* / support_access_grants 等
  //     customer-favorites 的 customer_favorites
  //
  // 也就是说那 4 个迁移在**建表**这件事上是冗余的，真正的缺口在**列**上
  // （这正是 runtime-metadata 的情况，也是这类缺陷的真实形态）。
  //
  // ## 现在断言的是真实且可失败的不变量
  //
  // 由一个**不在**自动清单里的迁移创建的表，必须也能在自动清单的 SQL 中找到。
  // 一旦某个非自动迁移出现**独有**的表，本测试立刻变红 —— 那正是缺口。
  // 负向对照已验证：从清单移除 migrate-platform-admin.sql 会使其变红。
  // ---------------------------------------------------------------------------

  /** 取某个 SQL 里 `create table if not exists public.<name>` 的表名 */
  function tablesCreatedBy(sql: string): string[] {
    return [...sql.matchAll(/create table if not exists\s+public\.(\w+)/gi)].map((m) => m[1]);
  }

  test('非自动迁移不得创建"只有它才有"的表', async () => {
    const mod = await import('../src/lib/migration');
    const covered = new Set(mod.MIGRATION_FILE_LIST);
    const autoSql = mod.MIGRATION_FILE_LIST.map((rel) => read(rel)).join('\n');
    const autoTables = new Set(tablesCreatedBy(autoSql));

    const allMigrations = readdirSync(join(ROOT, 'scripts'))
      .filter((f) => f.startsWith('migrate') && f.endsWith('.sql'));

    const orphans: string[] = [];
    for (const file of allMigrations) {
      if (covered.has(`scripts/${file}`)) continue;
      for (const t of tablesCreatedBy(read(`scripts/${file}`))) {
        if (!autoTables.has(t)) orphans.push(`${file} → public.${t}`);
      }
    }

    assert.deepEqual(
      orphans, [],
      '这些表**只**由不在自动迁移清单里的迁移创建 —— 全新部署不会创建它们，'
      + '相关功能直接不可用。要么把该迁移纳入 MIGRATION_FILES，'
      + '要么把该表的 DDL 并入基础迁移：\n  ' + orphans.join('\n  '),
    );
  });

  /**
   * 允许的删除：**以"父行不存在"为唯一条件的有界过期行 GC**。
   *
   * 为什么需要这一条：`migrate-subscriptions-seed.sql` 第一次执行时给当时存在的
   * 租户都回填了订阅（实测 11 行），随后测试残留清理删掉了 10 个 tenant，
   * **订阅行留了下来**。那是真的垃圾（指向不存在的租户，且对账脚本会读到）。
   *
   * 但"允许删除"必须是有界的，因此这里**逐条显式登记**，并同时要求：
   *   1. 删除条件必须是 `not exists (select 1 from <父表> ...)` 形式 ——
   *      即"父行不存在"，不可能删到在营对象的行；
   *   2. 在下面的白名单里。
   * 任何"无条件 delete"或"按业务条件 delete"仍然会被拦。
   */
  const ALLOWED_ORPHAN_GC: ReadonlyArray<{ file: string; predicate: RegExp; why: string }> = [
    {
      file: 'scripts/migrate-subscriptions-seed.sql',
      predicate: /delete\s+from\s+public\.tenant_subscriptions[\s\S]*?not\s+exists\s*\(\s*select\s+1\s+from\s+public\.tenants/i,
      why: '删除指向已不存在租户的订阅行（测试残留清理留下的孤儿）',
    },
  ];

  /** 把已登记的孤儿 GC 语句从文本里摘掉，剩下的删除才是"没登记的删除" */
  function unregisteredDeletes(rel: string, sql: string): boolean {
    let remainder = sql;
    for (const allowed of ALLOWED_ORPHAN_GC) {
      if (allowed.file !== rel) continue;
      if (!allowed.predicate.test(remainder)) continue;
      remainder = remainder.replace(allowed.predicate, '');
    }
    return /\b(delete\s+from|truncate\s+table)\b/i.test(remainder);
  }

  test('自动清单内的每个文件都真的创建/修改了对象，或是**幂等的**数据种子', async () => {
    const mod = await import('../src/lib/migration');
    const empty: string[] = [];
    /**
     * Phase 16：多了一类合法的自动迁移 —— **幂等数据种子**。
     *
     * `migrate-subscriptions-seed.sql` 只做 `insert`（+ 一条已登记的有界孤儿 GC）：
     * 它不建表、不改列，但 `subscription_plans` 没有数据时，权益门禁（fail-closed）
     * 会把**所有**租户降为只读。数据种子因此是迁移，不是"记得跑一次的脚本"。
     */
    const isIdempotentSeed = (rel: string, sql: string): boolean => {
      if (!/insert\s+into/i.test(sql)) return false;
      if (!/on\s+conflict[\s\S]*?do\s+nothing/i.test(sql)) return false;
      if (unregisteredDeletes(rel, sql)) return false;
      return true;
    };

    for (const rel of mod.MIGRATION_FILE_LIST) {
      const sql = read(rel);
      const creates = /create table if not exists/i.test(sql);
      const columns = /add column if not exists/i.test(sql);
      const views = /create or replace view/i.test(sql);
      const indexes = /create (unique )?index if not exists/i.test(sql);
      if (!creates && !columns && !views && !indexes && !isIdempotentSeed(rel, sql)) {
        empty.push(rel);
      }
    }
    assert.deepEqual(
      empty, [],
      '这些文件在自动迁移清单里却什么都没做（既没有幂等 DDL，也不是幂等数据种子）：'
      + empty.join(', '),
    );
  });

  test('清单里的删除语句只能是已登记的有界孤儿 GC', async () => {
    const mod = await import('../src/lib/migration');
    const offenders: string[] = [];
    for (const rel of mod.MIGRATION_FILE_LIST) {
      const sql = read(rel);
      if (!/\b(delete\s+from|truncate\s+table)\b/i.test(sql)) continue;
      if (unregisteredDeletes(rel, sql)) offenders.push(rel);
    }
    assert.deepEqual(
      offenders, [],
      '这些迁移含**未登记**的删除语句。自动迁移不得做无界删除；'
      + '如果确实需要清理过期行，必须是以"父行不存在"为条件的有界 GC，'
      + `并在 ALLOWED_ORPHAN_GC 里显式登记：${offenders.join(', ')}`,
    );
  });

  test('孤儿 GC 的登记条目确实被用上（防止白名单腐烂成免死金牌）', () => {
    const stale = ALLOWED_ORPHAN_GC.filter((allowed) => {
      let found = false;
      try {
        found = allowed.predicate.test(read(allowed.file));
      } catch {
        found = false;
      }
      return !found;
    });
    assert.deepEqual(
      stale.map((s) => `${s.file} (${s.why})`), [],
      'ALLOWED_ORPHAN_GC 里有条目已不匹配任何文件内容 —— 白名单必须随代码一起清理',
    );
  });

  test('CI 的 verify-migrations.mjs 不再维护第二份手写清单', () => {
    const src = read('scripts/verify-migrations.mjs');
    assert.match(
      src, /MIGRATION_FILES/,
      'verify-migrations.mjs 没有从 src/lib/migration.ts 读取事实源 —— '
      + '两份手写清单必然漂移（此前它包含从不执行的 migrate-rls.sql，'
      + '又漏掉真正要执行的几个），断言会在一份并非实际执行的清单上通过',
    );
    assert.doesNotMatch(
      src, /const sqlFiles = \[\s*'scripts\//,
      'verify-migrations.mjs 又写回了一份硬编码的迁移清单',
    );
  });
});
