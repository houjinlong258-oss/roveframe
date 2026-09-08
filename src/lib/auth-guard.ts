/**
 * Production Hardening — 统一 API 鉴权中间件（withAuth）+ Tenant Context
 *
 * 设计（三层）：
 *   1. proxy.ts 网络边界层：对所有 /api/** 非公开路由做全量 Supabase 校验，
 *      通过后注入 x-rf-* 租户上下文请求头（注入前先剥离客户端伪造头）。
 *   2. withAuth 路由层包装器：敏感路由在 handler 内再做一次完整校验（纵深防御，
 *      不依赖 proxy 的执行），并支持角色门控。
 *   3. getAuthContext 快速路径：普通路由读取 proxy 注入的 x-rf-* 头获得
 *      租户上下文，避免每个请求重复打 Supabase。
 *
 * 安全说明：
 *   - x-rf-* 头只在 proxy 校验成功后由服务端写入；proxy 会先删除客户端传入的
 *     同名头，因此路由可以信任这些头（前提：请求必须经过 proxy —— matcher 已覆盖
 *     全部 /api 路径）。敏感操作不要使用该快速路径，必须用 withAuth 完整校验。
 *   - token → user 的解析结果做 60s 进程内 TTL 缓存，降低页面并行请求的延迟。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { jsonError } from './api-helpers';
import {
  AuthenticatedUser,
  getRequestAccessToken,
  resolveUserByToken,
} from './auth';

export type Role = AuthenticatedUser['role'];

export interface AuthContext {
  user: AuthenticatedUser;
  tenantId: string;
  businessId: string | null;
  role: Role;
}

export type AuthedHandler<R extends Request = Request> = (
  request: R,
  ctx: AuthContext
) => Promise<Response> | Response;

// ---------------------------------------------------------------------------
// 公开路由（无需登录）。前缀匹配。
// ---------------------------------------------------------------------------

export const PUBLIC_API_PREFIXES: readonly string[] = [
  '/api/auth/login',
  '/api/auth/signup',
  '/api/auth/logout',
  '/api/store/menu',
  '/api/store/orders',
  '/api/store/staff', // 店员通过链接内 token 访问（顾客端呼叫店员）
  '/api/customer/favorites', // 顾客端 PWA
  '/api/webhooks', // POS/支付平台推送入口（无会话凭据，handler 内 HMAC 验签）
  '/api/agent/approvals/events', // RoveAgent 服务间审批事件推送（无会话凭据，handler 内 X-RoveAgent-Key 共享密钥校验）
  '/api/onboarding/parse', // 自然语言解析草稿（纯函数无副作用，确认写入走 /api/onboarding/confirm 需登录）
  '/api/health', // 部署 preflight / 健康检查（无会话凭据，仅返回缺表与降级状态）
];

export function isPublicApiPath(pathname: string): boolean {
  return PUBLIC_API_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
}

// ---------------------------------------------------------------------------
// proxy 注入头常量
// ---------------------------------------------------------------------------

export const RF_HEADERS = {
  userId: 'x-rf-user-id',
  tenantId: 'x-rf-tenant-id',
  businessId: 'x-rf-business-id',
  role: 'x-rf-role',
  email: 'x-rf-email',
} as const;

const ALL_RF_HEADERS = Object.values(RF_HEADERS);

/** 从给定 Headers 上剥离所有 x-rf-* 头（防客户端伪造） */
export function stripRfHeaders(headers: Headers): void {
  for (const h of ALL_RF_HEADERS) headers.delete(h);
}

/** 校验成功后由 proxy 调用：剥离伪造头并注入可信租户上下文 */
export function injectRfHeaders(headers: Headers, user: AuthenticatedUser): void {
  stripRfHeaders(headers);
  headers.set(RF_HEADERS.userId, user.userId);
  headers.set(RF_HEADERS.tenantId, user.tenantId);
  headers.set(RF_HEADERS.businessId, user.businessId ?? '');
  headers.set(RF_HEADERS.role, user.role);
  headers.set(RF_HEADERS.email, user.email);
}

// ---------------------------------------------------------------------------
// JWT 本地校验快速路径（Supabase HS256）
//
// 配置 COZE_SUPABASE_JWT_SECRET 后启用：签名 + exp 在进程内验证（<1ms），
// 不再为每个请求打两次 Supabase。role 不在 JWT 声明里（存于 public.users），
// 因此 role 按 userId 缓存 5 分钟；本地验签通过但 role 缓存未命中时，
// 降级一次远程解析补齐 role。secret 未配置时完全走原远程路径。
// ---------------------------------------------------------------------------

const ROLE_CACHE_TTL_MS = 5 * 60_000;
const roleCache = new Map<string, { role: Role; expiresAt: number }>();

function b64urlDecode(input: string): Buffer {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

interface LocalClaims {
  userId: string;
  email: string;
  tenantId: string;
  businessId: string | null;
  name: string | null;
}

/** 本地验签；secret 未配置或任何校验失败返回 null（调用方降级远程）。 */
export function verifyJwtLocally(token: string): LocalClaims | null {
  const secret = process.env.COZE_SUPABASE_JWT_SECRET;
  if (!secret) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  // alg 白名单：只允许 HS256（防 alg=none / 算法混淆攻击）
  try {
    const header = JSON.parse(b64urlDecode(headerB64).toString('utf8')) as { alg?: string };
    if (header.alg !== 'HS256') return null;
  } catch {
    return null;
  }

  const expected = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
  let actual: Buffer;
  try {
    actual = b64urlDecode(signatureB64);
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }

  // exp 必填且不得过期（本地时间，秒级时间戳）
  const exp = payload.exp;
  if (typeof exp !== 'number' || exp * 1000 <= Date.now()) return null;

  const sub = payload.sub;
  const appMeta = (payload.app_metadata ?? {}) as { tenant_id?: unknown; business_id?: unknown };
  const userMeta = (payload.user_metadata ?? {}) as { name?: unknown };
  if (typeof sub !== 'string' || typeof appMeta.tenant_id !== 'string') return null;

  return {
    userId: sub,
    email: typeof payload.email === 'string' ? payload.email : '',
    tenantId: appMeta.tenant_id,
    businessId: typeof appMeta.business_id === 'string' ? appMeta.business_id : null,
    name: typeof userMeta.name === 'string' ? userMeta.name : null,
  };
}

function cachedRole(userId: string): Role | null {
  const hit = roleCache.get(userId);
  if (hit && hit.expiresAt > Date.now()) return hit.role;
  if (hit) roleCache.delete(userId);
  return null;
}

function rememberRole(userId: string, role: Role): void {
  roleCache.set(userId, { role, expiresAt: Date.now() + ROLE_CACHE_TTL_MS });
  if (roleCache.size > 5000) {
    const now = Date.now();
    for (const [k, v] of roleCache) {
      if (v.expiresAt <= now) roleCache.delete(k);
    }
  }
}

// 演示模式（仅 RF_E2E_DEMO=1 且非生产）：自播种演示用户角色。
// 必须在模块作用域内做——dev 模式下 middleware/proxy/路由/instrumentation
// 各自持有独立的模块实例，跨模块播种不可达。
// 不放宽任何检查：请求仍须携带 COZE_SUPABASE_JWT_SECRET 签名正确的 JWT。
// TTL 给 24h（正常 role 缓存只有 5min，演示期间不能中途过期掉回远程解析）
if (process.env.RF_E2E_DEMO === '1' && process.env.COZE_PROJECT_ENV !== 'PROD') {
  roleCache.set('demo-owner', { role: 'owner', expiresAt: Date.now() + 24 * 3600_000 });
}

/** 测试用：清空鉴权缓存 */
export function _clearAuthCaches(): void {
  tokenCache.clear();
  roleCache.clear();
}

/**
 * 测试用：预置 role 缓存。
 * 配合 COZE_SUPABASE_JWT_SECRET 构造的本地可验签 JWT，
 * 让测试在无 Supabase 环境下走通 withAuth 完整链路（含角色门控）。
 */
export function _seedRoleForTest(userId: string, role: Role): void {
  rememberRole(userId, role);
}

interface CacheEntry {
  user: AuthenticatedUser;
  expiresAt: number;
}

const TOKEN_CACHE_TTL_MS = 60_000;
const tokenCache = new Map<string, CacheEntry>();

export async function resolveRequestUser(
  request: Request
): Promise<{ ok: true; user: AuthenticatedUser } | { ok: false; error: string }> {
  const token = getRequestAccessToken(request);
  if (!token) return { ok: false, error: 'missing session credential' };

  const now = Date.now();
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > now) {
    return { ok: true, user: cached.user };
  }

  // 快速路径：JWT 本地验签（需配置 COZE_SUPABASE_JWT_SECRET）
  const local = verifyJwtLocally(token);
  if (local) {
    const role = cachedRole(local.userId);
    if (role) {
      const user: AuthenticatedUser = { ...local, role };
      tokenCache.set(token, { user, expiresAt: now + TOKEN_CACHE_TTL_MS });
      return { ok: true, user };
    }
    // role 未缓存：落一次远程解析补齐（之后 5 分钟内都走本地）
  }

  try {
    const result = await resolveUserByToken(token);
    if (!result.ok) {
      if (cached) tokenCache.delete(token);
      return { ok: false, error: result.error };
    }
    rememberRole(result.data.userId, result.data.role);
    tokenCache.set(token, {
      user: result.data,
      expiresAt: now + TOKEN_CACHE_TTL_MS,
    });
    // 防御性清理，避免缓存无界增长
    if (tokenCache.size > 2000) {
      for (const [k, v] of tokenCache) {
        if (v.expiresAt <= now) tokenCache.delete(k);
      }
    }
    return { ok: true, user: result.data };
  } catch (e) {
    // Supabase 未配置/不可达时 resolveUserByToken 会直接抛错；
    // 鉴权层必须 fail closed 成 401，而不是把异常冒泡成 500
    if (cached) tokenCache.delete(token);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// getAuthContext —— 快速路径（读取 proxy 注入头）
// ---------------------------------------------------------------------------

/**
 * 读取 proxy 注入的租户上下文。请求未经 proxy 校验时返回 null。
 * 仅用于普通路由的租户信息读取；敏感操作请使用 withAuth。
 */
export function getAuthContext(request: Request): AuthContext | null {
  const h = request.headers;
  const userId = h.get(RF_HEADERS.userId);
  const tenantId = h.get(RF_HEADERS.tenantId);
  const role = h.get(RF_HEADERS.role) as Role | null;
  if (!userId || !tenantId || !role) return null;
  if (role !== 'owner' && role !== 'manager' && role !== 'staff') return null;
  const businessId = h.get(RF_HEADERS.businessId) || null;
  return {
    user: {
      userId,
      tenantId,
      businessId,
      role,
      email: h.get(RF_HEADERS.email) ?? '',
      name: null,
    },
    tenantId,
    businessId,
    role,
  };
}

// ---------------------------------------------------------------------------
// withAuth —— 路由层包装器（完整校验 + 角色门控）
// ---------------------------------------------------------------------------

export interface WithAuthOptions {
  /** 允许的角色；缺省表示任何已认证用户 */
  roles?: readonly Role[];
}

export function withAuth<R extends Request = Request>(
  handler: AuthedHandler<R>,
  options: WithAuthOptions = {}
) {
  return async (request: R): Promise<Response> => {
    const resolved = await resolveRequestUser(request);
    if (!resolved.ok) {
      return jsonError(`unauthorized: ${resolved.error}`, 401);
    }
    const { user } = resolved;
    if (options.roles && !options.roles.includes(user.role)) {
      return jsonError('forbidden: insufficient role', 403);
    }
    const ctx: AuthContext = {
      user,
      tenantId: user.tenantId,
      businessId: user.businessId,
      role: user.role,
    };
    return handler(request, ctx);
  };
}
