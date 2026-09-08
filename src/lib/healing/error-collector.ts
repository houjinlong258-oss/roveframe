/**
 * Sprint 5 — Error Self-Healing MVP
 * error-collector.ts
 *
 * Captures structured runtime error reports from the application, validates them,
 * and persists them in an in-process ring buffer (max 500 entries).
 * Exposes helpers for the analyzer and the REST handler.
 *
 * No Supabase write is performed here so that this module works before any
 * database migration is applied.
 */

export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';
export type ErrorCategory =
  | 'runtime'
  | 'api'
  | 'database'
  | 'auth'
  | 'validation'
  | 'network'
  | 'unknown';

export interface CapturedError {
  id: string;
  timestamp: string;          // ISO-8601
  severity: ErrorSeverity;
  category: ErrorCategory;
  message: string;
  stack?: string;
  url?: string;               // Request URL or page path where the error occurred
  method?: string;            // HTTP method (if applicable)
  statusCode?: number;        // HTTP status code (if applicable)
  context?: Record<string, unknown>; // Arbitrary structured metadata
  businessId?: string;        // Tenant scope (if available)
  userId?: string;            // Actor (if available)
  fingerprint: string;        // Deterministic dedup key
}

export interface ErrorReport {
  message: string;
  stack?: string;
  url?: string;
  method?: string;
  statusCode?: number;
  context?: Record<string, unknown>;
  businessId?: string;
  userId?: string;
}

// ---------------------------------------------------------------------------
// Internal ring buffer
// ---------------------------------------------------------------------------

const MAX_BUFFER = 500;
const _buffer: CapturedError[] = [];

function _makeId(): string {
  return `err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function _fingerprint(msg: string, stack?: string, url?: string): string {
  // Use first 120 chars of message + first stack frame line as the key.
  const stackLine = stack?.split('\n')[1]?.trim() ?? '';
  const raw = `${msg.slice(0, 120)}|${stackLine}|${url ?? ''}`;
  // Simple djb2 hash (no crypto dep required)
  let h = 5381;
  for (let i = 0; i < raw.length; i++) {
    h = ((h << 5) + h) ^ raw.charCodeAt(i);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function _classifyCategory(report: ErrorReport): ErrorCategory {
  const msg = report.message.toLowerCase();
  // Keyword checks first so that descriptive messages take priority over HTTP status codes
  if (
    msg.includes('supabase') ||
    msg.includes('database') ||
    msg.includes('sql') ||
    msg.includes('postgres') ||
    msg.includes('relation') ||
    msg.includes('does not exist') ||
    msg.includes('column') ||
    msg.includes('table')
  ) return 'database';
  if (msg.includes('unauthorized') || msg.includes('forbidden')) return 'auth';
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('timeout')) return 'network';
  if (msg.includes('json') || msg.includes('parse') || msg.includes('validation') || msg.includes('unexpected end')) return 'validation';
  // Fall back to HTTP status code
  if (report.statusCode) {
    if (report.statusCode === 401 || report.statusCode === 403) return 'auth';
    if (report.statusCode >= 400 && report.statusCode < 500) return 'validation';
    if (report.statusCode >= 500) return 'api';
  }
  return 'runtime';
}

function _classifySeverity(report: ErrorReport, category: ErrorCategory): ErrorSeverity {
  if (category === 'database' || (report.statusCode && report.statusCode >= 500)) return 'critical';
  if (category === 'auth') return 'high';
  if (category === 'api' || category === 'network') return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Capture and record a structured error. Returns the persisted entry. */
export function captureError(report: ErrorReport): CapturedError {
  const category = _classifyCategory(report);
  const severity = _classifySeverity(report, category);
  const fp = _fingerprint(report.message, report.stack, report.url);

  const entry: CapturedError = {
    id: _makeId(),
    timestamp: new Date().toISOString(),
    severity,
    category,
    message: report.message,
    stack: report.stack,
    url: report.url,
    method: report.method,
    statusCode: report.statusCode,
    context: report.context,
    businessId: report.businessId,
    userId: report.userId,
    fingerprint: fp,
  };

  // Keep ring buffer bounded
  if (_buffer.length >= MAX_BUFFER) {
    _buffer.shift();
  }
  _buffer.push(entry);

  return entry;
}

/** Return a snapshot of the recent error buffer (newest first). */
export function getRecentErrors(limit = 50): CapturedError[] {
  return [..._buffer].reverse().slice(0, limit);
}

/** Return all errors matching a fingerprint (for duplicate grouping). */
export function getErrorsByFingerprint(fingerprint: string): CapturedError[] {
  return _buffer.filter((e) => e.fingerprint === fingerprint);
}

/** Return errors for a specific business. */
export function getErrorsByBusiness(businessId: string, limit = 50): CapturedError[] {
  return _buffer
    .filter((e) => e.businessId === businessId)
    .slice(-limit)
    .reverse();
}

/** Clear all captured errors (used by tests). */
export function clearErrorBuffer(): void {
  _buffer.length = 0;
}

/** Total error count in buffer. */
export function errorBufferSize(): number {
  return _buffer.length;
}
