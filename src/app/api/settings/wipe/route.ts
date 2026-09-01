import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// 清空示例业务数据（保留设置、模型与邮箱配置）
export async function DELETE() {
  const supabase = getSupabaseClient();
  const tables = [
    'email_send_tasks', 'emails', 'chat_messages',
    'marketing_contents', 'reviews', 'reservations', 'orders',
    'inventory_items', 'products', 'customers', 'alerts', 'doc_chunks', 'knowledge_docs',
  ];
  for (const table of tables) {
    const { error } = await supabase.from(table).delete().neq('id', '');
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  return NextResponse.json({ ok: true });
}
