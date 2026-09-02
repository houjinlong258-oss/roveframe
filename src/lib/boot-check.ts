import { getSupabaseClient } from '@/storage/database/supabase-client';

export interface BootCheckResult {
  table: string;
  missing: boolean;
  message: string;
}

const REQUIRED_TABLES = ['cron_state', 'staff', 'business_memories'];

/** 启动自检：探测新增的表/列是否已建，缺了返回清晰的提示（供 server 启动时打印） */
export async function runBootChecks(): Promise<BootCheckResult[]> {
  const client = getSupabaseClient();
  const results: BootCheckResult[] = [];

  for (const table of REQUIRED_TABLES) {
    const { error } = await client.from(table).select('*', { count: 'exact', head: true });
    results.push({ table, missing: Boolean(error), message: error?.message ?? '' });
  }

  const { error: colErr } = await client.from('orders').select('tip, tip_percent, tip_staff_id').limit(1);
  results.push({ table: 'orders(tip/tip_percent/tip_staff_id)', missing: Boolean(colErr), message: colErr?.message ?? '' });

  return results;
}