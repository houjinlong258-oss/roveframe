import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { adminHandler } from '@/lib/admin-api';

/**
 * GET /api/admin/providers — 全平台 AI Provider 连接健康（掩码）。
 * 只返回 provider id、启用状态、测试状态与掩码；绝不返回 api_key_encrypted。
 */
export async function GET(request: Request) {
  return adminHandler(request, { action: 'admin.providers.read' }, async () => {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('model_configs')
      .select('tenant_id, provider, is_enabled, last_test_ok, last_tested_at, last_test_error, api_key_encrypted, models_updated_at')
      .order('tenant_id')
      .limit(500);
    if (error) throw new Error(error.message);

    const rows = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      tenantId: row.tenant_id,
      provider: row.provider,
      isEnabled: row.is_enabled,
      lastTestOk: row.last_test_ok,
      lastTestedAt: row.last_tested_at,
      lastTestError: row.last_test_error ?? null, // 写入时已脱敏
      keyConfigured: Boolean(row.api_key_encrypted),
      modelsUpdatedAt: row.models_updated_at ?? null,
    }));

    return NextResponse.json({ providers: rows });
  });
}
