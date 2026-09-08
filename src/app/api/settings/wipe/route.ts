import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';

// 清空示例业务数据（保留设置、模型与邮箱配置）
// P0-6：双 scope（tenant+business）删除 + 服务端签发的一次性确认令牌 + dry-run 预览。
// 多 business 租户下只清当前门店，绝不按 tenant 全删。

const WIPE_TABLES = [
  'email_send_tasks', 'emails', 'chat_messages',
  'marketing_contents', 'reviews', 'reservations', 'orders',
  'inventory_items', 'products', 'customers', 'alerts', 'doc_chunks', 'knowledge_docs',
] as const;

interface WipeToken {
  userId: string;
  tenantId: string;
  businessId: string;
  expiresAt: number;
}

const TOKEN_TTL_MS = 5 * 60_000;
const wipeTokens = new Map<string, WipeToken>();

/** GET：签发一次性确认令牌（5 分钟有效，绑定当前用户+门店，使用后即失效）。 */
export async function GET(request: Request) {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'settings:write');
  const token = randomUUID();
  wipeTokens.set(token, {
    userId: context.userId,
    tenantId: context.tenantId,
    businessId: context.businessId,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  // 清理过期令牌（顺带限制内存增长）
  const now = Date.now();
  for (const [key, value] of wipeTokens) {
    if (value.expiresAt < now) wipeTokens.delete(key);
  }
  return NextResponse.json({ token, expiresInSec: TOKEN_TTL_MS / 1000 });
}

async function wipeSettings(request: Request) {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'settings:write');
  const body = (await request.json().catch(() => ({}))) as {
    token?: unknown;
    dryRun?: unknown;
  };
  const token = typeof body.token === 'string' ? body.token : '';
  const dryRun = body.dryRun === true;
  const issued = token ? wipeTokens.get(token) : undefined;
  if (!issued) {
    return NextResponse.json({ error: 'confirmation token required' }, { status: 403 });
  }
  wipeTokens.delete(token); // 一次性
  if (
    issued.expiresAt < Date.now() ||
    issued.userId !== context.userId ||
    issued.tenantId !== context.tenantId ||
    issued.businessId !== context.businessId
  ) {
    return NextResponse.json({ error: 'confirmation token invalid or expired' }, { status: 403 });
  }

  const supabase = getSupabaseClient();
  if (dryRun) {
    const counts: Record<string, number> = {};
    for (const table of WIPE_TABLES) {
      const { count, error } = await supabase
        .from(table)
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', context.tenantId)
        .eq('business_id', context.businessId);
      if (error) throw new Error(`${table}: ${error.message}`);
      counts[table] = count ?? 0;
    }
    return NextResponse.json({ dryRun: true, wouldDelete: counts });
  }

  for (const table of WIPE_TABLES) {
    const { error } = await supabase
      .from(table)
      .delete()
      .eq('tenant_id', context.tenantId)
      .eq('business_id', context.businessId);
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  return NextResponse.json({ ok: true });
}

export const DELETE = protectBusinessMutation(
  { permission: 'settings:write', action: 'settings.wipe', entity: 'settings' },
  wipeSettings,
);
