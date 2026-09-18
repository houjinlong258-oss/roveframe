import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { startScheduler } from '@/lib/scheduler';
import { runBootChecks } from '@/lib/boot-check';
import { autoMigrate } from '@/lib/migration';
// ⚠️ 必须从 rate-limit-contract 导入，**不能**从 rate-limit 导入。
// rate-limit.ts 顶部 import { NextResponse } from 'next/server'，那会把 Next 的
// 请求上下文机器拉进启动期依赖图 —— 实测让容器启动即崩：
//   Error: Invariant: AsyncLocalStorage accessed in runtime where it is not available
// rate-limit-contract 零依赖，启动期加载安全。
import { assertRateLimitContract, rateLimitBackend } from '@/lib/rate-limit-contract';

const dev = process.env.COZE_PROJECT_ENV !== 'PROD';
const hostname = process.env.HOSTNAME || 'localhost';
const port = parseInt(process.env.PORT || '5000', 10);

// ---------------------------------------------------------------------------
// Phase 12 / R-04：进程级兜底。
//
// 在此之前 `src/` 全树没有任何 `unhandledRejection` / `uncaughtException`
// 处理器，而启动路径上有**两处未被 await 的 promise**（本文件的
// `app.prepare().then(...)` 与 `void (async () => …)()`）。任一处抛出都会走
// Node 默认行为 —— 直接终止进程，不留可诊断的日志，表现为"服务莫名重启"。
//
// 两种事件的处理**刻意不同**：
//
//   unhandledRejection  → 记录，**不退出**。被拒绝的后台 promise（定时任务、
//                        清理、埋点）不应带走一个正在正常服务的进程。
//   uncaughtException   → 记录，**然后退出**。同步异常可能已让进程处于不一致
//                        状态；继续服务比崩溃更危险。退出让编排器拉起干净进程。
//
// 两者都打印完整堆栈 —— 静默是这里最不可接受的失败模式。
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled promise rejection (process continues):', reason);
  if (reason instanceof Error && reason.stack) console.error(reason.stack);
});

process.on('uncaughtException', (error) => {
  console.error('[fatal] uncaught exception — exiting so the orchestrator restarts clean:', error);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});

// 生产硬门禁：demo 数据绝不进入生产路径（fail-closed）。
if (!dev && process.env.RF_E2E_DEMO === '1') {
  throw new Error('RF_E2E_DEMO=1 is forbidden in production (COZE_PROJECT_ENV=PROD). Refusing to start.');
}

// Create Next.js app
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app
  .prepare()
  .then(() => {
    const server = createServer(async (req, res) => {
      try {
        const parsedUrl = parse(req.url!, true);
        await handle(req, res, parsedUrl);
      } catch (err) {
        console.error('Error occurred handling', req.url, err);
        res.statusCode = 500;
        res.end('Internal server error');
      }
    });
    server.once('error', err => {
      console.error(err);
      process.exit(1);
    });
    server.listen(port, () => {
      console.log(
        `> Server listening at http://${hostname}:${port} as ${
          dev ? 'development' : process.env.COZE_PROJECT_ENV
        }`,
      );
      // 启动流程：自动建表 → 自检 → 定时任务
      //
      // Phase 15：限流契约检查放在最前面。限流状态在进程内存里，
      // 因此只在单副本下成立；部署方若声明已接入共享后端而实际没有，
      // 必须在这里大声说出来（不阻止启动 —— 那是把降级升级成不可用）。
      const rateLimitContract = assertRateLimitContract();
      if (rateLimitContract) {
        console.error(`✗ [rate-limit] 部署契约不成立：${rateLimitContract}`);
      } else if (rateLimitBackend() === 'process-memory') {
        console.warn(
          '⚠️ [rate-limit] 使用进程内限流状态：本进程必须单副本运行。'
          + '多副本会使注册/登录限流与聊天并发上限成倍放宽。',
        );
      }
      // R-04：整段加 `.catch()`。此前这里是 `void (async () => …)()`，而
      // `autoMigrate()` 在找不到 `scripts/*.sql` 时会**抛错**（migration.ts
      // 的 `migrationSql()`）—— 于是一个精简镜像（缺 SQL 文件）会以
      // 未处理拒绝的形式直接杀死进程，形成 crash-loop，且日志里只有一句
      // Node 的默认提示。现在失败被完整记录，且**不影响已经监听中的服务**：
      // 缺表是可以降级运行的，进程死掉不是。
      void (async () => {
        const mig = await autoMigrate();
        if (mig.ok) {
          console.log(`✓ [migrate] 数据库自动建表完成（${mig.method === 'pg-dsn' ? 'Postgres 直连' : 'Supabase Management API'}）`);
        } else if (mig.method === 'none') {
          console.warn('⚠️ [migrate] 未配置 DATABASE_URL 或 SUPABASE_ACCESS_TOKEN，跳过自动建表。');
        } else {
          console.warn(`⚠️ [migrate] 自动建表失败：${mig.error}`);
        }

        const checks = await runBootChecks();
        const problems = checks.filter((c) => c.missing);
        if (problems.length === 0) {
          console.log('✓ [boot-check] 数据库 schema 完整');
        } else {
          console.warn('\n⚠️ [boot-check] 检测到缺失的表/列，部分功能会报错。请运行 scripts/migrate.sql：');
          for (const p of problems) console.warn(`  - ${p.table}: ${p.message}`);
        }
      })().catch((err) => {
        console.error(
          '[startup] migrate/boot-check failed — server stays up, but the schema may be incomplete:',
          err,
        );
        if (err instanceof Error && err.stack) console.error(err.stack);
      });
      // 定时任务：每日经营简报 + 异常告警推送 + Telegram 双向查询
      startScheduler();
    });
  })
  .catch((err) => {
    // Next.js 无法进入就绪状态时，这个进程没有可服务的对象。记录后退出，
    // 而不是留下一个没有任何路由可用的进程。
    console.error('[fatal] next.js failed to prepare — cannot serve requests:', err);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
