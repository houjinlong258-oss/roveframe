import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext } from '@/lib/tenant';
import { getSupabaseClient } from '@/storage/database/supabase-client';

interface AuditEventRow {
  created_at: string;
  action: string;
  tool_name: string | null;
  agent_id: string | null;
  user_id: string | null;
  arguments_hash: string | null;
  approval_id: string | null;
  execution_id: string | null;
  status: string | null;
  result: unknown;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return '"' + text.replace(/"/g, '""') + '"';
}

/** Production Audit Store 导出（CSV，tenant/business 限定）。 */
export async function GET(request: NextRequest) {
  try {
    const context = requireBusinessContext(await getTenantContext(request));
    const { searchParams } = new URL(request.url);
    const approvalId = searchParams.get('approval_id') ?? undefined;

    let query = getSupabaseClient().from('audit_events')
      .select('created_at, action, tool_name, agent_id, user_id, arguments_hash, approval_id, execution_id, status, result')
      .eq('tenant_id', context.tenantId)
      .eq('business_id', context.businessId)
      .order('created_at', { ascending: false })
      .limit(2000);
    if (approvalId) query = query.eq('approval_id', approvalId);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const rows = (data ?? []) as AuditEventRow[];
    const header = ['timestamp', 'action', 'tool_name', 'agent_id', 'user_id', 'arguments_hash', 'approval_id', 'execution_id', 'status', 'result'];
    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push([
        csvCell(row.created_at), csvCell(row.action), csvCell(row.tool_name), csvCell(row.agent_id),
        csvCell(row.user_id), csvCell(row.arguments_hash), csvCell(row.approval_id),
        csvCell(row.execution_id), csvCell(row.status), csvCell(row.result),
      ].join(','));
    }
    const csv = '\uFEFF' + lines.join('\r\n');
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="audit-export-' + new Date().toISOString().slice(0, 10) + '.csv"',
      },
    });
  } catch (authError) {
    const message = authError instanceof Error ? authError.message : String(authError);
    if (message.includes('uthenticat') || message.includes('session')) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
