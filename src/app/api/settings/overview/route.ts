import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// 数据管理：各类业务数据量概览
export async function GET() {
  const supabase = getSupabaseClient();
  const tables = ['products', 'orders', 'customers', 'reviews', 'emails', 'knowledge_docs', 'marketing_contents', 'reservations'] as const;
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true });
    if (error) throw new Error(error.message);
    counts[table] = count ?? 0;
  }
  return NextResponse.json({ counts });
}
