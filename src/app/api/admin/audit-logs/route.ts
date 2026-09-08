import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { adminHandler } from '@/lib/admin-api';

/**
 * GET /api/admin/audit-logs — 平台审计日志（只读，append-only）。
 * 没有 PUT/PATCH/DELETE：商户端与平台端都不能修改或删除审计。
 */
export async function GET(request: Request) {
  return adminHandler(request, { action: 'admin.audit.read', roles: ['super_admin', 'admin', 'support_readonly'] }, async () => {
    const url = new URL(request.url);
    const tenantId = url.searchParams.get('tenantId');
    const client = getSupabaseClient();
    let query = client
      .from('platform_admin_audit_logs')
      .select('id, admin_id, action, target_tenant_id, request_id, summary, created_at')
      .order('created_at', { ascending: false })
      .limit(200);
    if (tenantId) query = query.eq('target_tenant_id', tenantId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return NextResponse.json({ logs: data ?? [] });
  });
}

/** 审计日志不可变：任何写方法一律 405 */
function methodNotAllowed() {
  return NextResponse.json({ error: 'audit logs are append-only' }, { status: 405 });
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
