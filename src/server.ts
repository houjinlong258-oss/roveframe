import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { startScheduler } from '@/lib/scheduler';
import { runBootChecks } from '@/lib/boot-check';
import { autoMigrate } from '@/lib/migration';

const dev = process.env.COZE_PROJECT_ENV !== 'PROD';
const hostname = process.env.HOSTNAME || 'localhost';
const port = parseInt(process.env.PORT || '5000', 10);

// Create Next.js app
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
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
    })();
    // 定时任务：每日经营简报 + 异常告警推送 + Telegram 双向查询
    startScheduler();
  });
});
