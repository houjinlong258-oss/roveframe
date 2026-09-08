/**
 * Platform Admin / SaaS Control Plane 核心库。
 *
 * 与商户端完全分离：
 * - 独立 cookie 命名空间（rf_admin_session），不复用商户 Supabase 会话。
 * - requirePlatformAdmin 是平台后台唯一守卫；商户 token 一律拒绝。
 * - 所有读写写 platform_admin_audit_logs（脱敏摘要）。
 * - 禁止万能 token、任意 tenant_id 越权、明文秘密读取。
 *
 * DB 不可用（迁移未执行）时降级内存存储，仅用于本地/测试。
 */

import crypto from 'crypto';
import { getSupabaseClient } from '@/storage/database/supabase-client';

export const PLATFORM_ADMIN_COOKIE = 'rf_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

export type PlatformAdminRole = 'super_admin' | 'admin' | 'support_readonly';

export interface PlatformAdminContext {
  adminId: string;
  email: string;
  role: PlatformAdminRole;
  sessionId: string;
}

export class PlatformAuthError extends Error {
  readonly status = 401;
}

export class PlatformForbiddenError extends Error {
  readonly status = 403;
}

// ---------------------------------------------------------------------------
// 密码散列（scrypt）
// ---------------------------------------------------------------------------

export function hashAdminPassword(password: string): string {
  if (password.length < 10) throw new Error('platform admin password must be at least 10 characters');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyAdminPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ---------------------------------------------------------------------------
// 内存降级存储（测试缝；生产依赖迁移后的表）
// ---------------------------------------------------------------------------

interface MemorySession {
  id: string;
  adminId: string;
  tokenHash: string;
  expiresAt: number;
  revokedAt: number | null;
}

interface MemoryAdmin {
  id: string;
  email: string;
  passwordHash: string;
  role: PlatformAdminRole;
  isActive: boolean;
}

const memory = {
  admins: [] as MemoryAdmin[],
  sessions: [] as MemorySession[],
  audit: [] as Array<Record<string, unknown>>,
  dbDown: false,
};

/** 测试专用：清空内存态并注入管理员 */
export function _seedPlatformAdminForTest(email: string, password: string, role: PlatformAdminRole = 'admin'): MemoryAdmin {
  const admin: MemoryAdmin = {
    id: `padmin_${crypto.randomUUID().slice(0, 8)}`,
    email,
    passwordHash: hashAdminPassword(password),
    role,
    isActive: true,
  };
  memory.admins.push(admin);
  return admin;
}

export function _clearPlatformAdminMemory(): void {
  memory.admins = [];
  memory.sessions = [];
  memory.audit = [];
  memory.dbDown = false;
}

export function _readPlatformAuditMemory(): Array<Record<string, unknown>> {
  return [...memory.audit];
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

async function findAdminByEmail(email: string): Promise<(MemoryAdmin & { password_hash?: string }) | null> {
  if (!memory.dbDown) {
    try {
      const { data, error } = await getSupabaseClient()
        .from('platform_admins')
        .select('id, email, password_hash, role, is_active')
        .ilike('email', email)
        .maybeSingle();
      if (!error && data) {
        return {
          id: data.id as string,
          email: data.email as string,
          passwordHash: data.password_hash as string,
          role: data.role as PlatformAdminRole,
          isActive: data.is_active as boolean,
        };
      }
      if (error) memory.dbDown = true;
    } catch {
      memory.dbDown = true;
    }
  }
  return memory.admins.find((a) => a.email.toLowerCase() === email.toLowerCase()) ?? null;
}

/** 登录：校验邮箱+密码，创建独立会话，返回明文 token（仅此一次） */
export async function loginPlatformAdmin(email: string, password: string): Promise<{ token: string; admin: PlatformAdminContext } | null> {
  const admin = await findAdminByEmail(email);
  if (!admin || !admin.isActive) return null;
  if (!verifyAdminPassword(password, admin.passwordHash)) return null;

  const token = crypto.randomBytes(32).toString('base64url');
  const sessionId = crypto.randomUUID();
  const expiresAt = Date.now() + SESSION_TTL_MS;

  if (!memory.dbDown) {
    try {
      const client = getSupabaseClient();
      const { error } = await client.from('platform_admin_sessions').insert({
        id: sessionId,
        admin_id: admin.id,
        token_hash: hashToken(token),
        expires_at: new Date(expiresAt).toISOString(),
      });
      if (error) throw new Error(error.message);
      await client.from('platform_admins').update({ last_login_at: new Date().toISOString() }).eq('id', admin.id);
    } catch {
      memory.dbDown = true;
    }
  }
  if (memory.dbDown) {
    memory.sessions.push({ id: sessionId, adminId: admin.id, tokenHash: hashToken(token), expiresAt, revokedAt: null });
  }

  return {
    token,
    admin: { adminId: admin.id, email: admin.email, role: admin.role, sessionId },
  };
}

/** 解析请求中的平台管理员会话；无效/过期/撤销返回 null */
export async function resolvePlatformAdmin(request: Request): Promise<PlatformAdminContext | null> {
  const cookieHeader = request.headers.get('cookie') ?? '';
  const match = new RegExp(`(?:^|;\\s*)${PLATFORM_ADMIN_COOKIE}=([^;]+)`).exec(cookieHeader);
  const token = match?.[1];
  if (!token) return null;
  const tokenHash = hashToken(token);

  if (!memory.dbDown) {
    try {
      const client = getSupabaseClient();
      const { data, error } = await client
        .from('platform_admin_sessions')
        .select('id, admin_id, expires_at, revoked_at')
        .eq('token_hash', tokenHash)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (data) {
        if (data.revoked_at || new Date(data.expires_at as string).getTime() < Date.now()) return null;
        const { data: admin } = await client
          .from('platform_admins')
          .select('id, email, role, is_active')
          .eq('id', data.admin_id as string)
          .maybeSingle();
        if (!admin || !admin.is_active) return null;
        return { adminId: admin.id as string, email: admin.email as string, role: admin.role as PlatformAdminRole, sessionId: data.id as string };
      }
    } catch {
      memory.dbDown = true;
    }
  }

  const session = memory.sessions.find((s) => s.tokenHash === tokenHash);
  if (!session || session.revokedAt || session.expiresAt < Date.now()) return null;
  const admin = memory.admins.find((a) => a.id === session.adminId);
  if (!admin || !admin.isActive) return null;
  return { adminId: admin.id, email: admin.email, role: admin.role, sessionId: session.id };
}

/** 登出：撤销当前会话 */
export async function logoutPlatformAdmin(context: PlatformAdminContext): Promise<void> {
  if (!memory.dbDown) {
    try {
      await getSupabaseClient()
        .from('platform_admin_sessions')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', context.sessionId);
      return;
    } catch {
      memory.dbDown = true;
    }
  }
  const session = memory.sessions.find((s) => s.id === context.sessionId);
  if (session) session.revokedAt = Date.now();
}

/**
 * 平台后台唯一守卫。
 * 商户 Supabase token / 商户 cookie 在这里没有任何效力——只看独立会话。
 */
export async function requirePlatformAdmin(request: Request, allowedRoles?: PlatformAdminRole[]): Promise<PlatformAdminContext> {
  const context = await resolvePlatformAdmin(request);
  if (!context) throw new PlatformAuthError('platform admin session required');
  if (allowedRoles && !allowedRoles.includes(context.role)) {
    throw new PlatformForbiddenError(`role ${context.role} not allowed`);
  }
  return context;
}

// ---------------------------------------------------------------------------
// 平台审计（append-only；只写脱敏摘要）
// ---------------------------------------------------------------------------

export interface PlatformAuditEntry {
  adminId: string | null;
  action: string;
  targetTenantId?: string | null;
  targetBusinessId?: string | null;
  requestId?: string;
  summary?: Record<string, unknown>;
}

const FORBIDDEN_SUMMARY_KEYS = /api[-_]?key|secret|password|token|credential/i;

function sanitizeSummary(summary: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(summary)) {
    if (FORBIDDEN_SUMMARY_KEYS.test(key)) continue; // 秘密字段一律不进审计
    clean[key] = typeof value === 'string' && value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  return clean;
}

export async function writePlatformAudit(entry: PlatformAuditEntry): Promise<void> {
  const row = {
    admin_id: entry.adminId,
    action: entry.action,
    target_tenant_id: entry.targetTenantId ?? null,
    target_business_id: entry.targetBusinessId ?? null,
    request_id: entry.requestId ?? crypto.randomUUID(),
    summary: sanitizeSummary(entry.summary ?? {}),
  };
  if (!memory.dbDown) {
    try {
      const { error } = await getSupabaseClient().from('platform_admin_audit_logs').insert(row);
      if (!error) return;
      memory.dbDown = true;
    } catch {
      memory.dbDown = true;
    }
  }
  memory.audit.push({ ...row, created_at: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Support access grant
// ---------------------------------------------------------------------------

export interface SupportGrant {
  id: string;
  tenantId: string;
  adminId: string;
  reason: string;
  readOnly: boolean;
  endsAt: string;
}

const memoryGrants: Array<SupportGrant & { startsAt: string; revokedAt: string | null }> = [];

export function _clearSupportGrantsMemory(): void {
  memoryGrants.length = 0;
}

/** 创建限时、最小权限的排障授权（默认只读） */
export async function createSupportGrant(input: {
  tenantId: string;
  adminId: string;
  reason: string;
  readOnly?: boolean;
  ttlMinutes?: number;
}): Promise<SupportGrant> {
  if (!input.reason.trim()) throw new Error('support grant reason is required');
  const ttl = Math.min(Math.max(input.ttlMinutes ?? 60, 5), 24 * 60);
  const grant: SupportGrant & { startsAt: string; revokedAt: string | null } = {
    id: crypto.randomUUID(),
    tenantId: input.tenantId,
    adminId: input.adminId,
    reason: input.reason,
    readOnly: input.readOnly ?? true,
    startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + ttl * 60_000).toISOString(),
    revokedAt: null,
  };
  if (!memory.dbDown) {
    try {
      const { error } = await getSupabaseClient().from('support_access_grants').insert({
        id: grant.id,
        tenant_id: grant.tenantId,
        admin_id: grant.adminId,
        reason: grant.reason,
        read_only: grant.readOnly,
        starts_at: grant.startsAt,
        ends_at: grant.endsAt,
      });
      if (!error) return grant;
      memory.dbDown = true;
    } catch {
      memory.dbDown = true;
    }
  }
  memoryGrants.push(grant);
  return grant;
}

/** 获取当前有效的授权；过期/撤销立即失效 */
export async function getActiveSupportGrant(tenantId: string, adminId: string): Promise<SupportGrant | null> {
  const now = new Date().toISOString();
  if (!memory.dbDown) {
    try {
      const { data, error } = await getSupabaseClient()
        .from('support_access_grants')
        .select('id, tenant_id, admin_id, reason, read_only, ends_at')
        .eq('tenant_id', tenantId)
        .eq('admin_id', adminId)
        .is('revoked_at', null)
        .gt('ends_at', now)
        .order('ends_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (data) {
        return {
          id: data.id as string,
          tenantId: data.tenant_id as string,
          adminId: data.admin_id as string,
          reason: data.reason as string,
          readOnly: data.read_only as boolean,
          endsAt: data.ends_at as string,
        };
      }
      return null;
    } catch {
      memory.dbDown = true;
    }
  }
  const grant = memoryGrants.find(
    (g) => g.tenantId === tenantId && g.adminId === adminId && !g.revokedAt && g.endsAt > now,
  );
  return grant ?? null;
}
