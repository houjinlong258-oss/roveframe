import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTenantContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';

// 清空示例业务数据（保留设置、模型与邮箱配置）
async function wipeSettings(request: Request) {
  const context = await getTenantContext(request);
  requirePermission(context, 'settings:write');
  const supabase = getSupabaseClient();
  const tables = [
    'email_send_tasks', 'emails', 'chat_messages',
    'marketing_contents', 'reviews', 'reservations', 'orders',
    'inventory_items', 'products', 'customers', 'alerts', 'doc_chunks', 'knowledge_docs',
  ];
  for (const table of tables) {
    const { error } = await supabase.from(table).delete().eq('tenant_id', context.tenantId);
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  return NextResponse.json({ ok: true });
}

export const DELETE = protectBusinessMutation(
  { permission: 'settings:write', action: 'settings.wipe', entity: 'settings' },
  wipeSettings,
);
