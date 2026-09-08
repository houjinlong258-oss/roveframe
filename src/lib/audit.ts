import { getSupabaseClient } from '@/storage/database/supabase-client';

export interface AuditEntry {
  tenantId: string;
  actorId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

// ---------------------------------------------------------------------------
// 测试缝：设置后 writeAudit 转为同步调用 sink（不发 Supabase）。
// 仅供 tests/ 使用，生产代码不应调用。
// ---------------------------------------------------------------------------

export type AuditSink = (entry: AuditEntry) => void;
let _testSink: AuditSink | null = null;

export function _setAuditSinkForTest(sink: AuditSink | null): void {
  _testSink = sink;
}

/** 写审计日志（best-effort，失败不阻断主流程） */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  if (_testSink) {
    _testSink(entry);
    return;
  }
  try {
    const { error } = await getSupabaseClient().from('audit_logs').insert({
      tenant_id: entry.tenantId,
      actor_id: entry.actorId ?? null,
      action: entry.action,
      entity: entry.entity,
      entity_id: entry.entityId ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
    });
    if (error) console.error('[audit] best-effort write failed');
  } catch (error) {
    console.error('[audit] best-effort write failed', error instanceof Error ? error.name : 'unknown');
  }
}

/**
 * Security boundary audit. Unlike legacy best-effort logging, this rejects on
 * any storage error so a protected mutation cannot begin without a durable,
 * redacted audit intent.
 */
export async function writeRequiredAudit(entry: AuditEntry): Promise<void> {
  if (_testSink) {
    _testSink(entry);
    return;
  }
  const { error } = await getSupabaseClient().from('audit_logs').insert({
    tenant_id: entry.tenantId,
    actor_id: entry.actorId ?? null,
    action: entry.action,
    entity: entry.entity,
    entity_id: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
  if (error) throw new Error('required security audit is unavailable');
}

// ---------------------------------------------------------------------------
// 审计读取（Phase 8：审批详情页的活动时间线）
// ---------------------------------------------------------------------------

export interface AuditRow {
  id: number;
  tenantId: string;
  actorId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

interface AuditLogRow {
  id: number;
  tenant_id: string;
  actor_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  created_at: string;
}

/** 查询某实体最近的审计记录（best-effort，DB 不可用时返回空数组） */
export async function listAuditForEntity(
  tenantId: string,
  entity: string,
  entityId: string,
  limit = 20
): Promise<AuditRow[]> {
  try {
    const { data, error } = await getSupabaseClient()
      .from('audit_logs')
      .select('id, tenant_id, actor_id, action, entity, entity_id, before, after, created_at')
      .eq('tenant_id', tenantId)
      .eq('entity', entity)
      .eq('entity_id', entityId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return (data as AuditLogRow[]).map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      actorId: r.actor_id,
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id,
      before: r.before,
      after: r.after,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}
