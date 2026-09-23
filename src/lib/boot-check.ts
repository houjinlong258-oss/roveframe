import { getSupabaseCredentials, getSupabaseServiceRoleKey } from '@/storage/database/supabase-client';
import * as schemaModule from '@/storage/database/shared/schema';
import {
  diffSchema,
  driftIsEmpty,
  expectedSchemaFromModule,
  liveSchemaFromOpenApi,
  type SchemaDrift,
} from '@/lib/schema-drift';

export interface BootCheckResult {
  table: string;
  missing: boolean;
  message: string;
}

/**
 * 启动自检 / 部署 preflight —— **完整的 schema 漂移检测**。
 *
 * ## 这一版修掉了什么（Phase 19 上线阻断项 6）
 *
 * 旧实现的 `REQUIRED_TABLES` 是**手写的 11 张表**（schema.ts 里有 52 张），
 * 于是 `/api/health` 的 `missingCount: 0` 只证明那 11 张存在。独立审查实测指出：
 * "52/52" 那个数字来自审查者自己的探针，**不是**来自 `/api/health`；
 * 而唯一被当作 schema 门禁的 `scripts/verify-migrations.mjs` 是文件级比对，
 * 从不连接数据库。缺口是"用 11 张表的证据冒充 52 张表的结论"。
 *
 * 现在期望值**从 `schema.ts` 派生**（drizzle 的 `getTableColumns` 知道每张表
 * 有哪些列），实际值从**真实库**的 PostgREST OpenAPI 文档读取（一次请求拿到
 * 全部表与全部列）。没有需要手工维护的表清单，也没有探针列清单。
 *
 * ## 缺表/缺列时系统什么行为（fail-closed，且不是静默降级）
 *
 *   · `runBootChecks()` 每个缺失项返回 `missing: true`；
 *   · `/api/health` 有任一 `missing` ⇒ 整体 `ok: false` 且 HTTP **503**
 *     （部署 preflight 与编排健康检查据此拒绝放行）；
 *   · `/api/metrics` 的 `roveframe_health_database_ok` 变成 0（可被告警消费）；
 *   · `src/server.ts` 启动时打印缺失清单到日志（**大声**，不是静默）。
 *
 * **刻意不阻止进程启动**：缺表可以降级运行，进程死掉不是 —— 那会把一个
 * 可诊断的降级状态升级成 crash-loop，日志里反而什么也看不到。这条决策沿用
 * server.ts 既有注释的理由，此处显式记录，避免被读成"没做 fail-closed"。
 *
 * **取不到真实 schema 时也是 fail-closed**：网络失败 / 无凭据 / 文档结构不对
 * 一律报 `missing: true`，绝不会因为"读不到"就返回"完整"。
 * 这是 Phase 15 那个 `if (error) return []` 的同族错误，不能再犯。
 *
 * ## health_check 不是本检查的依赖
 *
 * 本模块**不查 `health_check` 表**（它自己也要被检查）。真实值来自 PostgREST
 * 的 schema 文档，那是一份从目录（catalog）生成的元数据，不依赖任何业务表。
 */

/** 取真实 schema 的超时。启动期不能因为一个网络请求卡住自检。 */
const SCHEMA_FETCH_TIMEOUT_MS = 10_000;

/** `runBootChecks()` 出问题时的**唯一**结果表名（不是数据库里的表）。 */
export const BOOT_CHECK_SELF_LABEL = '<schema-diff>';

let lastDrift: SchemaDrift | null = null;

/** 最近一次自检的漂移明细（供测试/诊断读取，不参与判定）。 */
export function lastSchemaDrift(): SchemaDrift | null {
  return lastDrift;
}

/**
 * 从真实库读取 schema（PostgREST OpenAPI 文档）。
 *
 * 失败返回 null，由调用方按 fail-closed 处理 —— **不在这里吞掉错误**。
 */
export async function fetchLiveSchema(): Promise<Record<string, string[]> | null> {
  let url: string;
  let key: string | undefined;
  try {
    url = getSupabaseCredentials().url;
    key = getSupabaseServiceRoleKey();
  } catch (error) {
    console.error(
      '[boot-check] 无法解析 Supabase 凭据：',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
  if (!key) {
    console.error('[boot-check] COZE_SUPABASE_SERVICE_ROLE_KEY 未配置，无法读取真实 schema');
    return null;
  }

  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/`, {
      headers: { apikey: key, authorization: `Bearer ${key}`, accept: 'application/openapi+json' },
      signal: AbortSignal.timeout(SCHEMA_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[boot-check] schema 文档请求失败：HTTP ${res.status}`);
      return null;
    }
    const live = liveSchemaFromOpenApi(await res.json());
    if (Object.keys(live).length === 0) {
      // 200 但解析不出任何表：文档结构变了。绝不能当成"没有缺失"。
      console.error('[boot-check] schema 文档解析为空 —— 结构可能已变，按失败处理');
      return null;
    }
    return live as Record<string, string[]>;
  } catch (error) {
    console.error(
      '[boot-check] 读取真实 schema 失败：',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/**
 * 把一次漂移判定压成 `BootCheckResult[]`。
 *
 * 形状保持不变（`/api/health`、`/api/metrics`、`server.ts` 都按它消费），
 * 但语义从"每张表一个探针结果"变成"整份 schema 的差异清单"。
 */
export function driftToBootChecks(drift: SchemaDrift): BootCheckResult[] {
  const results: BootCheckResult[] = [];

  for (const table of drift.missingTables) {
    results.push({ table, missing: true, message: '表在 schema.ts 里声明，但真实库中不存在' });
  }
  for (const { table, columns } of drift.missingColumns) {
    results.push({
      table,
      missing: true,
      message: `表存在但缺列：${columns.join(', ')}`,
    });
  }

  if (results.length === 0) {
    results.push({
      table: BOOT_CHECK_SELF_LABEL,
      missing: false,
      message: `已核对 ${drift.checkedTables} 张表 / ${drift.checkedColumns} 列，与 schema.ts 一致`
        + (drift.extraTables.length ? `（真实库另有 ${drift.extraTables.length} 张非 schema 表/视图）` : ''),
    });
  }
  return results;
}

/** 启动自检：与 schema.ts 全量比对，缺表/缺列返回清晰提示（供 server 启动时打印）。 */
export async function runBootChecks(): Promise<BootCheckResult[]> {
  const expected = expectedSchemaFromModule(schemaModule as unknown as Record<string, unknown>);
  if (Object.keys(expected).length === 0) {
    // 派生失败（schema.ts 结构变了 / 打包把表定义丢了）也必须报出来，
    // 否则"0 张期望"会让漂移检查静默通过。
    return [{
      table: BOOT_CHECK_SELF_LABEL,
      missing: true,
      message: '无法从 schema.ts 派生表清单（0 张表）—— 自检失效，按失败处理',
    }];
  }

  const live = await fetchLiveSchema();
  if (live === null) {
    return [{
      table: BOOT_CHECK_SELF_LABEL,
      missing: true,
      message: '无法读取真实 schema（网络/凭据/文档结构）—— UNVERIFIED，按失败处理，不返回"完整"',
    }];
  }

  const drift = diffSchema(expected, live);
  lastDrift = drift;
  return driftToBootChecks(drift);
}

/** 供测试断言：判定为"无漂移"必须同时满足两个条件。 */
export { driftIsEmpty };
