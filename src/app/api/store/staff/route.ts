import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// 公开接口：顾客下单后选择服务员工（返回活跃员工）
export async function GET() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('staff')
    .select('id, name, role, photo_url')
    .eq('is_active', true)
    .order('created_at');
  if (error) throw new Error(error.message);
  return NextResponse.json({ staff: data ?? [] });
}