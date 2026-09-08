import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTenantContext, requirePermission } from '@/lib/tenant';

// 数据管理：各类业务数据量概览
export async function GET(request: Request) {
  const context = await getTenantContext(request);
  requirePermission(context, 'settings:read');
  const supabase = getSupabaseClient();
  const tables = ['products', 'orders', 'customers', 'reviews', 'emails', 'knowledge_docs', 'marketing_contents', 'reservations'] as const;
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true }).eq('tenant_id', context.tenantId);
    if (error) throw new Error(error.message);
    counts[table] = count ?? 0;
  }
  return NextResponse.json({ counts });
}
