/**
 * Production Hardening — CapturedError 持久化存储
 *
 * Supabase 表 error_events 可用时以数据库为准（重启不丢、按 tenant_id 隔离、
 * 指纹跨重启去重）；数据库未配置或迁移未应用时回退到进程内环形缓冲
 * （error-collector.ts，保持 Sprint 5 行为与测试兼容）。
 *
 * 模式探测带 60s 缓存：应用迁移后最多 60s 自动切回数据库模式。
 */

import { getSupabaseClient } from '@/storage/database/supabase-client';
import {
  CapturedError,
  ErrorCategory,
  ErrorSeverity,
  captureError as memoryCapture,
  getRecentErrors as memoryRecent,
  getErrorsByFingerprint as memoryByFingerprint,
  ErrorReport,
} from './error-collector';

const TABLE = 'error_events';
const PROBE_INTERVAL_MS = 60_000;

let _dbMode: boolean | null = null;
let _lastProbe = 0;

async function isDbMode(): Promise<boolean> {
  const now = Date.now();
  if (_dbMode !== null && now - _lastProbe < PROBE_INTERVAL_MS) return _dbMode;
  _lastProbe = now;
  try {
    const { error } = await getSupabaseClient().from(TABLE).select('id').limit(1);
    _dbMode = !error;
  } catch {
    _dbMode = false;
  }
  return _dbMode;
}

/** 测试用：重置模式探测缓存 */
export function _resetPersistenceProbe(): void {
  _dbMode = null;
  _lastProbe = 0;
}

// ---------------------------------------------------------------------------
// 行 <-> 领域对象映射
// ---------------------------------------------------------------------------

interface ErrorRow {
  id: string;
  tenant_id: string;
  timestamp: string;
  severity: string;
  category: string;
  message: string;
  stack: string | null;
  url: string | null;
  method: string | null;
  status_code: number | null;
  context: unknown;
  business_id: string | null;
  user_id: string | null;
  fingerprint: string;
}

function toRow(e: CapturedError, tenantId: string): Record<string, unknown> {
  return {
    id: e.id,
    tenant_id: tenantId,
    timestamp: e.timestamp,
    severity: e.severity,
    category: e.category,
    message: e.message,
    stack: e.stack ?? null,
    url: e.url ?? null,
    method: e.method ?? null,
    status_code: e.statusCode ?? null,
    context: e.context ?? null,
    business_id: e.businessId ?? null,
    user_id: e.userId ?? null,
    fingerprint: e.fingerprint,
  };
}

function fromRow(r: ErrorRow): CapturedError {
  return {
    id: r.id,
    timestamp: r.timestamp,
    severity: r.severity as ErrorSeverity,
    category: r.category as ErrorCategory,
    message: r.message,
    stack: r.stack ?? undefined,
    url: r.url ?? undefined,
    method: r.method ?? undefined,
    statusCode: r.status_code ?? undefined,
    context: (r.context ?? undefined) as Record<string, unknown> | undefined,
    businessId: r.business_id ?? undefined,
    userId: r.user_id ?? undefined,
    fingerprint: r.fingerprint,
  };
}

// ---------------------------------------------------------------------------
// 公开 API（tenant 隔离，async）
// ---------------------------------------------------------------------------

/** 采集并持久化一条错误报告（DB 优先，失败降级内存） */
export async function captureErrorPersisted(
  report: ErrorReport,
  tenantId: string
): Promise<CapturedError> {
  // 复用内存采集器完成分类/严重度/指纹计算
  const captured = memoryCapture(report);
  if (await isDbMode()) {
    const { error } = await getSupabaseClient().from(TABLE).insert(toRow(captured, tenantId));
    if (!error) return captured;
  }
  return captured;
}

export async function listCapturedErrors(limit = 20, tenantId?: string): Promise<CapturedError[]> {
  if (await isDbMode()) {
    let q = getSupabaseClient()
      .from(TABLE)
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(limit);
    if (tenantId) q = q.eq('tenant_id', tenantId);
    const { data, error } = await q;
    if (!error && data) return (data as ErrorRow[]).map(fromRow);
  }
  return memoryRecent(limit);
}

export async function getCapturedErrorById(
  id: string,
  tenantId?: string
): Promise<CapturedError | undefined> {
  if (await isDbMode()) {
    let q = getSupabaseClient().from(TABLE).select('*').eq('id', id);
    if (tenantId) q = q.eq('tenant_id', tenantId);
    const { data, error } = await q.maybeSingle();
    if (!error && data) return fromRow(data as ErrorRow);
    return undefined;
  }
  return memoryRecent(500).find((e) => e.id === id);
}

/** 同一指纹出现次数（用于去重统计） */
export async function countByFingerprint(fingerprint: string, tenantId?: string): Promise<number> {
  if (await isDbMode()) {
    let q = getSupabaseClient()
      .from(TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('fingerprint', fingerprint);
    if (tenantId) q = q.eq('tenant_id', tenantId);
    const { count, error } = await q;
    if (!error && typeof count === 'number') return count;
    return 1;
  }
  return memoryByFingerprint(fingerprint).length;
}
