import { getSupabaseClient } from '@/storage/database/supabase-client';
import { DEFAULT_TENANT_ID } from '@/lib/tenant';

export interface AuditEntry {
  tenantId?: string;
  actorId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

/** 写审计日志（best-effort，失败不阻断主流程） */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await getSupabaseClient().from('audit_logs').insert({
      tenant_id: entry.tenantId ?? DEFAULT_TENANT_ID,
      actor_id: entry.actorId ?? null,
      action: entry.action,
      entity: entry.entity,
      entity_id: entry.entityId ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
    });
  } catch {
    // 审计失败不阻断业务
  }
}