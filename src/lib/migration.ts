import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

/**
 * P0-14：单一迁移事实源。
 *
 * 建表 DDL 的权威来源是磁盘上的 SQL 文件：
 *   1) scripts/migrate.sql                 —— 平台表 + 增量迁移（幂等）
 *   2) scripts/migrate-business-tables.sql —— 业务表 + pgvector RAG（幂等）
 *
 * autoMigrate 仅按顺序执行这两个文件；不再内嵌第二份 SQL 副本，
 * 杜绝「自动迁移建出的库与 schema/代码不符」的漂移。
 * scripts/verify-migrations.mjs 在 CI 中断言 SQL 文件与 schema.ts 表名一致。
 */

export interface MigrateResult {
  ok: boolean;
  method: 'pg-dsn' | 'management-api' | 'none';
  error?: string;
}

const MIGRATION_FILES = [
  'scripts/migrate.sql',
  'scripts/migrate-business-tables.sql',
  'scripts/migrate-pilot-ready.sql',
  // Phase 15：本文件一直在仓库里，却**不在**这份清单中，于是
  // `chat_sessions` 的 5 个 runtime_* 列在任何自动迁移路径下都不会被创建，
  // 而 `src/app/api/agent/chat/route.ts` 每轮对话都要写它们 →
  // 生产日志持续出现 "runtime metadata columns unavailable"，
  // 「这条回答是 Runtime 出的还是降级出的」在数据层无从查证（正是该迁移要解决的问题）。
  //
  // CI 的 verify-migrations.mjs 没拦住，因为它只比对**表名**与索引口径，
  // 从不比对列。已在 tests/migration-column-coverage.test.ts 补上列级守卫。
  //
  // 该文件全部使用 ADD COLUMN IF NOT EXISTS，幂等，可安全加入执行链。
  'scripts/migrate-runtime-metadata.sql',
  // Phase 15：以下 4 个迁移此前同样不在清单里，但它们创建的对象**正被现网功能使用**。
  // 实测（scripts/_verify_fresh_deploy_gap.mts）：当前库里这些对象存在，
  // 只是因为有人**手工应用**过；全新部署不会创建它们，相关功能直接不可用：
  //
  //   platform-admin       → /api/admin/* 平台管理台、订阅（subscription 在 src 下 78 处引用）
  //   production-hardening → coding-agent 审批流、error_events、audit_logs（17 处引用）
  //   customer-favorites   → 顾客端收藏（公开接口）
  //   ai-provider-views    → ai_providers / ai_credentials / ai_usage_logs 三个视图
  //
  // 四个文件均已核实幂等（create table if not exists / create or replace view）。
  // 顺序放在基础迁移之后：它们依赖 public.tenants / businesses 等前置对象。
  'scripts/migrate-platform-admin.sql',
  'scripts/migrate-production-hardening.sql',
  'scripts/migrate-customer-favorites.sql',
  'scripts/migrate-ai-provider-views.sql',
  // Phase 16 任务 2：订阅套餐种子 + 存量租户的计费归属 + 平台默认 entitlement。
  // 之所以必须是迁移（而不是一个"记得跑"的脚本）：权益门禁是 fail-closed 的，
  // 没有订阅行的租户会被降为只读。若迁移不在链上，一次全新部署就会把**所有**
  // 商家锁成只读。种子里的存量回填语句用 `on conflict (tenant_id) do nothing`，
  // 因此重复执行不会把已 suspended 的租户重置回 active。
  'scripts/migrate-subscriptions-seed.sql',
  // Phase 16 任务 4：退订表 + 出件任务的退订令牌列。
  // 没有它，外发链路就没有退订能力（欧美市场批量邮件不可合法使用）。
  'scripts/migrate-email-compliance.sql',
  // Phase 16 任务 4：邮箱账号的连接验证证据列（last_test_ok / last_tested_at / last_test_error）
  'scripts/migrate-email-account-verification.sql',
  // Phase 17：商户官网。没有它，"Agent 生成官网 + 域名证书 + 官网下单/预约入口"
  // 这几件事在**全新部署**上全部不可用（表不存在 ⇒ 官网页 500），而本地开发库
  // 因为手工建过表看不出问题 —— 与 runtime-metadata 那次是同一类缺陷。
  'scripts/migrate-public-sites.sql',
  // Phase 18 / P18-1：员工账号与员工档案的关联（staff.user_id）。
  // 没有它，"这个登录的人对应哪条员工记录"查不出来 —— 员工端的排班、考勤、
  // 外卖派单全部没有归属。
  'scripts/migrate-staff-identity.sql',
  // Phase 18 / P18-4：外卖配送单 + settings.delivery + **外卖专用幂等唯一索引**。
  // 最后那条索引是必须的：既有索引带 `where source='qr'`（见
  // scripts/migrate-business-tables.sql:496），外卖 source='web' 落不进去，
  // 并发同 key 会落两张单（详见该文件注释）。
  'scripts/migrate-delivery-orders.sql',
  // Phase 18 / P18-6：员工排班与考勤。
  // 考勤表里那条**部分唯一索引**（staff_id where clock_out_at is null）是并发安全的关键：
  // 员工连点两次打卡，第二次撞索引报错，而不是产生两条进行中的记录。
  'scripts/migrate-workforce.sql',
  // Phase 18 / P18-7：员工关怀（记录 + 待办）。待办表在 signal_key 上有唯一索引，
  // 让每分钟跑一次的调度器可以幂等地重复计算信号，而不会把同一个生日提醒刷成十条。
  'scripts/migrate-workforce-care.sql',
  // Phase 18 / P18-9：顾客账号与会话。
  // 顾客是**与商家隔离的第二套身份**：自建 scrypt 口令 + 独立 cookie，
  // 刻意不复用 GoTrue —— 把顾客塞进商家用户池会重演 AGENTS.md 陷阱 8
  // （共享 client 被用户 session 污染，service_role 静默失效）。
  'scripts/migrate-customer-accounts.sql',
  // Phase 18 / P18-10：骑手轨迹（delivery_positions）+ delivery_orders 的
  // 收货坐标列（dest_lat / dest_lng）。
  // 后者是 ETA 的**唯一诚实来源**：地址是文本，没有地理编码服务就换不出坐标；
  // 顾客下单时由本人设备定位提供，取不到就为 NULL，ETA 返回 null 而不是编一个。
  'scripts/migrate-delivery-positions.sql',
  // Phase 19（上线阻断项 1）：RLS 覆盖。
  //
  // 这两个文件此前都**不在**清单里，而这正是缺口长期存在的制度原因：
  //   · `migrate-rls.sql`（33 张表）是 Phase 15 **手工**应用的，从未在任何自动
  //     迁移路径上执行过 —— 于是"全新部署有数据库层隔离"这句话没有代码支撑；
  //   · 它用的是**手写的表清单**，Phase 17/18 新增的表从未被加进去。
  //
  // 实测后果（独立审查用项目自己的 anon key 读到）：`delivery_orders` 21/21 行
  // （含收件人姓名/电话/地址）、`delivery_positions` 16/16（骑手经纬度轨迹）、
  // `staff_attendance` 3/3、`public_sites` 1/1（含一个**可用**的点餐 token，
  // 用它调 /api/store/menu 返回 200 与真实菜单）。
  //
  // 我这轮用只读的 `pg_policies` 复核后发现未启用 RLS 的是 **12 张** ——
  // 审查者只能看见当时**有数据**的 4 张；另 8 张是空表，"anon 读到 0 行"与
  // "RLS 拦住了"在他那里不可区分。
  //
  // 顺序放在最后：策略要引用 public.users / tenants / businesses，必须先存在。
  // 两个文件都幂等（to_regclass 判断 + drop policy if exists + create policy），
  // 且都在末尾带自检 notice（同时检查"未启用 RLS"与"启用了却零策略"——
  // 只查前者会把后者判成通过，Phase 15 §3.2 正是栽在那上面）。
  'scripts/migrate-rls.sql',
  'scripts/migrate-rls-gaps.sql',
] as const;

/** 供回归测试断言"自动迁移覆盖了代码真正读写的列"。 */
export const MIGRATION_FILE_LIST: readonly string[] = MIGRATION_FILES;

/** 读取迁移 SQL 文件；cwd=仓库根或打包产物上一级均可命中。 */
function migrationSql(): string {
  const candidates = [
    process.cwd(),
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '..', '..'),
  ];
  const chunks: string[] = [];
  for (const relative of MIGRATION_FILES) {
    let found: string | null = null;
    for (const root of candidates) {
      const absolute = path.join(root, relative);
      try {
        found = readFileSync(absolute, 'utf8');
        break;
      } catch {
        // try next candidate root
      }
    }
    if (found === null) {
      throw new Error(
        `migration SQL file not found: ${relative}. Run from the repository root ` +
        '(scripts/migrate*.sql files are the single source of truth).',
      );
    }
    chunks.push(found);
  }
  return chunks.join('\n');
}

const DSN_KEYS = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'DIRECT_URL',
  'COZE_SUPABASE_DATABASE_URL',
  'SUPABASE_DATABASE_URL',
  'PG_CONNECTION_STRING',
];

/** 从 COZE_SUPABASE_URL（https://<ref>.supabase.co）解析项目 ref */
function projectRef(): string {
  const m = /https?:\/\/([^.]+)\.supabase\.co/.exec(process.env.COZE_SUPABASE_URL ?? '');
  return m?.[1] ?? '';
}

/**
 * 直连 DSN 的 SSL 决策（纯函数，可单测）。
 *
 * 为什么需要它：node-postgres 只要收到**显式** `ssl` 选项就无视连接串里的 `sslmode`。
 * 原实现无条件传 `{ rejectUnauthorized: false }`，对远程 Supabase 是对的，但对
 * **同机/内置 Postgres**（默认不开 SSL）会在握手阶段直接报
 * "The server does not support SSL connections" —— 开机自动迁移永远失败，
 * 而失败只体现在启动日志里，容器照样 healthy。
 *
 * 规则刻意保持既有行为不变（不自作主张放宽）：
 *   · DSN 里写 `sslmode=disable`，或显式 `DATABASE_SSL=disable` → 不启用 SSL
 *   · 其余一切情况 → 沿用旧行为：SSL + 不校验证书
 */
export function resolveMigrationSsl(
  dsn: string,
  env: Record<string, string | undefined> = process.env,
): false | { rejectUnauthorized: boolean } {
  if (env.DATABASE_SSL === 'disable') return false;
  if (/(?:\?|&)sslmode=disable(?:&|$)/.test(dsn)) return false;
  return { rejectUnauthorized: false };
}

/**
 * 自动建表：优先用 Postgres DSN；否则用 Supabase Management API。
 * 两者都缺失时返回 method=none（由调用方决定是否告警）。
 */
export async function autoMigrate(): Promise<MigrateResult> {
  const sql = migrationSql();

  // 1) Postgres 直连（pg）
  const dsn = DSN_KEYS.map((k) => process.env[k]).find((v): v is string => Boolean(v));
  if (dsn) {
    const pool = new Pool({ connectionString: dsn, ssl: resolveMigrationSsl(dsn) });
    try {
      await pool.query(sql);
      return { ok: true, method: 'pg-dsn' };
    } catch (e) {
      return { ok: false, method: 'pg-dsn', error: e instanceof Error ? e.message : String(e) };
    } finally {
      await pool.end();
    }
  }

  // 2) Supabase Management API（需要 SUPABASE_ACCESS_TOKEN）
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref = projectRef();
  if (token && ref) {
    const resp = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    });
    if (resp.ok) return { ok: true, method: 'management-api' };
    return { ok: false, method: 'management-api', error: `HTTP ${resp.status}: ${await resp.text()}` };
  }

  return { ok: false, method: 'none', error: '未配置 DATABASE_URL 或 SUPABASE_ACCESS_TOKEN' };
}
