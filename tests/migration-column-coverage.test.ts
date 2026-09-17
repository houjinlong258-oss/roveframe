import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
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
});
