import { getTableColumns, getTableName } from 'drizzle-orm';

/**
 * Schema 漂移检测 —— **纯逻辑**，不连库、不发网络请求。
 *
 * ## 为什么要有这个模块（Phase 19 上线阻断项 6）
 *
 * 修这一项之前，`src/lib/boot-check.ts` 的 `REQUIRED_TABLES` 是**手写的 11 张表**，
 * 而 `src/storage/database/shared/schema.ts` 里有 **52 张**。于是：
 *
 *   · `/api/health` 的 `missingCount: 0` 只证明那 11 张在 —— 却被读成
 *     "52/52 张表都在"（独立审查实测出这个差别）；
 *   · `scripts/verify-migrations.mjs` 是**文件级**检查（比对 SQL 文本），
 *     从不连接数据库，挡不住"库里真的缺列"；
 *   · 清单会腐烂，而腐烂是静默的 —— 这正是 `migrate-rls.sql` 漏掉 12 张表
 *     的同一个形态（Phase 19 已修）。
 *
 * 因此这里不再维护任何子集清单：期望值**从 schema.ts 派生**（drizzle 自己知道
 * 每张表有哪些列），实际值从**真实库**读取（PostgREST 的 OpenAPI 文档里
 * 含全部表与全部列）。两边一减，缺什么就是什么。
 *
 * ## 为什么拆成纯函数
 *
 * "门禁必须能失败"这件事要能被**确定性**地测到，而制造一次真实的缺列需要 DDL
 * （删列再恢复）。把 diff 做成对两个普通对象求差，就可以用**构造的假 schema**
 * 做阴性对照：喂一份缺列/缺表的输入，断言它报出来。真实库上的对照见
 * `tests/schema-drift-gate.test.ts`（把一份**多出一列**的期望喂给真实 live schema，
 * 必须报缺列 —— 零写入）。
 */

/** 表名 → 列名列表。 */
export type SchemaShape = Record<string, readonly string[]>;

export interface SchemaDrift {
  /** schema.ts 里有、真实库里没有的表。 */
  missingTables: string[];
  /** 表在，但缺了若干列。 */
  missingColumns: { table: string; columns: string[] }[];
  /** 真实库里多出来的表（不算漂移，只做信息；视图/临时表会落在这里）。 */
  extraTables: string[];
  checkedTables: number;
  checkedColumns: number;
}

/**
 * 从 drizzle 模块派生期望 schema。
 *
 * 传入整个模块（`import * as schema from '@/storage/database/shared/schema'`）：
 * 逐项尝试 `getTableName` / `getTableColumns`，不是表的导出（类型、函数、常量）
 * 会被 `getTableName` 抛错跳过 —— 那正是我们要的：**不需要维护名单**。
 */
export function expectedSchemaFromModule(mod: Record<string, unknown>): SchemaShape {
  const out: SchemaShape = {};
  for (const value of Object.values(mod)) {
    if (value === null || typeof value !== 'object') continue;
    let tableName: string;
    try {
      tableName = getTableName(value as Parameters<typeof getTableName>[0]);
    } catch {
      continue; // 不是 drizzle 表
    }
    if (!tableName) continue;
    let columns: Record<string, { name?: string }>;
    try {
      columns = getTableColumns(value as Parameters<typeof getTableColumns>[0]) as
        Record<string, { name?: string }>;
    } catch {
      continue;
    }
    const names = Object.values(columns)
      .map((c) => c?.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    if (names.length === 0) continue;
    out[tableName] = names;
  }
  return out;
}

/**
 * 从 PostgREST 的 OpenAPI 文档解析真实库 schema。
 *
 * 为什么用这个端点：它是**一次请求拿到全部表与全部列**的地方，而逐个
 * `select('col')` 探测是"每张表一次往返"（原实现 11 张表 ≈ 4 秒）。
 * 文档形如 `{ definitions: { <table>: { properties: { <col>: {...} } } } }`。
 */
export function liveSchemaFromOpenApi(doc: unknown): SchemaShape {
  const definitions = (doc as { definitions?: Record<string, unknown> } | null)?.definitions;
  if (!definitions || typeof definitions !== 'object') return {};
  const out: SchemaShape = {};
  for (const [table, def] of Object.entries(definitions)) {
    const properties = (def as { properties?: Record<string, unknown> } | null)?.properties;
    if (!properties || typeof properties !== 'object') continue;
    out[table] = Object.keys(properties);
  }
  return out;
}

/** 期望 - 实际。纯函数：同样的输入永远给同样的输出。 */
export function diffSchema(expected: SchemaShape, live: SchemaShape): SchemaDrift {
  const missingTables: string[] = [];
  const missingColumns: { table: string; columns: string[] }[] = [];
  let checkedColumns = 0;

  const expectedTables = Object.keys(expected).sort();
  for (const table of expectedTables) {
    const expectedColumns = expected[table] ?? [];
    const liveColumns = live[table];
    if (liveColumns === undefined) {
      missingTables.push(table);
      continue;
    }
    checkedColumns += expectedColumns.length;
    const liveSet = new Set(liveColumns);
    const absent = expectedColumns.filter((c) => !liveSet.has(c)).sort();
    if (absent.length > 0) missingColumns.push({ table, columns: absent });
  }

  const expectedSet = new Set(expectedTables);
  const extraTables = Object.keys(live).filter((t) => !expectedSet.has(t)).sort();

  return {
    missingTables,
    missingColumns,
    extraTables,
    checkedTables: expectedTables.length,
    checkedColumns,
  };
}

/** 漂移是否为空（只关心"缺"，多出来的表不算问题）。 */
export function driftIsEmpty(drift: SchemaDrift): boolean {
  return drift.missingTables.length === 0 && drift.missingColumns.length === 0;
}
