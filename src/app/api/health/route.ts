import { NextResponse } from 'next/server';
import { runBootChecks } from '@/lib/boot-check';
import { schedulerHealth } from '@/lib/scheduler';

/**
 * GET /api/health — 部署 preflight / 运行健康检查。
 * 迁移缺失（cron_state、ai_usage_ledger、平台表等）时返回 503 + 明确缺表清单，
 * 不再让调度器与持久化能力长期静默降级。
 */
export async function GET() {
  try {
    const checks = await runBootChecks();
    const missing = checks.filter((c) => c.missing);
    const scheduler = schedulerHealth();
    const ok = missing.length === 0 && !scheduler.degraded;
    return NextResponse.json(
      {
        ok,
        missingTables: missing,
        scheduler,
        encryptionConfigured: Boolean(process.env.ENCRYPTION_SECRET || process.env.COZE_SUPABASE_SERVICE_ROLE_KEY),
      },
      { status: ok ? 200 : 503 },
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }
}
