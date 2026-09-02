/**
 * 多租户上下文（P0-S2 完整版：JWT + RLS）
 *
 * 解析优先级：
 *   1) Authorization Bearer JWT → 读 app_metadata.tenant_id
 *   2) x-tenant-id header       → 内部 / 精简模式 fallback
 *   3) DEFAULT_TENANT_ID        → 单租户回填数据
 *
 * 后续（P0-S3 RBAC）切到用户 JWT 直连 RLS 时，本模块的 decodeJwtPayload
 * 需补 verify（SUPABASE_JWT_SECRET + iss + aud），此处留 TODO。
 */

export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000000';
export const DEFAULT_BUSINESS_ID = '00000000-0000-0000-0000-000000000001';

export interface TenantContext {
  tenantId: string;
  businessId: string | null;
  userId: string | null;
  /** 解析来源：jwt = Authorization Bearer，header = x-tenant-id，default = DEFAULT_TENANT_ID */
  source: 'jwt' | 'header' | 'default';
}

interface JwtPayload {
  sub?: string;
  app_metadata?: {
    tenant_id?: string;
    business_id?: string;
  };
  user_metadata?: {
    business_id?: string;
  };
  exp?: number;
}

/** 从 Authorization 头提取 Bearer token；缺失或格式错误返回 null */
function extractBearerToken(request?: Request): string | null {
  const auth = request?.headers?.get('authorization');
  if (!auth) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(auth);
  return match ? match[1] : null;
}

/**
 * 解码 JWT payload 段（不验签）。
 * 用 Node 内置 Buffer + base64url 解码，避免引入 jose/jsonwebtoken 依赖。
 * TODO(P0-S3): 切到完整 JWT verify —— SUPABASE_JWT_SECRET + iss + aud。
 */
function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as JwtPayload;
  } catch {
    return null;
  }
}

export function getTenantContext(request?: Request): TenantContext {
  // 1) Authorization Bearer JWT（完整版主路径）
  const token = extractBearerToken(request);
  if (token) {
    const payload = decodeJwtPayload(token);
    const tenantId = payload?.app_metadata?.tenant_id;
    if (tenantId) {
      return {
        tenantId,
        businessId:
          payload?.app_metadata?.business_id ??
          payload?.user_metadata?.business_id ??
          null,
        userId: payload?.sub ?? null,
        source: 'jwt',
      };
    }
  }

  // 2) x-tenant-id header（精简模式 / 内部调用 / 旧调用方兜底）
  const headerTenant = request?.headers?.get('x-tenant-id');
  if (headerTenant) {
    return {
      tenantId: headerTenant,
      businessId: request?.headers?.get('x-business-id') ?? null,
      userId: null,
      source: 'header',
    };
  }

  // 3) 默认租户（单租户回填数据 + 无凭据本地启动）
  return {
    tenantId: process.env.DEFAULT_TENANT_ID || DEFAULT_TENANT_ID,
    businessId: null,
    userId: null,
    source: 'default',
  };
}

/** 供写入时注入 tenant_id（保留旧 API） */
export function withTenantId(tenantId: string): { tenant_id: string } {
  return { tenant_id: tenantId };
}
