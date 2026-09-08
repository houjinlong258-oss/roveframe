/**
 * proxy.ts — Next.js 16 网络边界层（Node.js runtime）
 *
 * 职责：
 *   1. /api/**  —— 统一 API 鉴权边界。公开路由（登录/注册/顾客端点餐）放行；
 *      其余路由必须通过 Supabase token 校验，校验成功后向请求头注入
 *      x-rf-* 租户上下文（注入前剥离客户端伪造的同名头），失败返回 401。
 *   2. 其他路径 —— next-intl 国际化路由（保持原行为）。
 *
 * 注意：proxy 是网络边界而非唯一鉴权点；敏感路由（审批/写入/清空等）在
 * handler 内还通过 withAuth 做第二次完整校验（纵深防御）。
 */

import { NextRequest, NextResponse } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';
import {
  injectRfHeaders,
  isPublicApiPath,
  resolveRequestUser,
  stripRfHeaders,
} from './lib/auth-guard';

const intlMiddleware = createMiddleware(routing);

function unauthorized(error: string): NextResponse {
  return NextResponse.json({ error: `unauthorized: ${error}` }, { status: 401 });
}

async function handleApiRequest(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // 平台控制面：与商户会话完全分离，不走 Supabase 商户 token 边界，
  // 由路由内 requirePlatformAdmin 独立守卫（商户 token 一律无效）。
  if (pathname.startsWith('/api/admin/')) {
    const headers = new Headers(request.headers);
    stripRfHeaders(headers);
    return NextResponse.next({ request: { headers } });
  }

  // 公开路由：剥离伪造头后直接放行
  if (isPublicApiPath(pathname)) {
    const headers = new Headers(request.headers);
    stripRfHeaders(headers);
    return NextResponse.next({ request: { headers } });
  }

  const resolved = await resolveRequestUser(request);
  if (!resolved.ok) {
    return unauthorized(resolved.error);
  }

  const headers = new Headers(request.headers);
  injectRfHeaders(headers, resolved.user);
  return NextResponse.next({ request: { headers } });
}

export default async function proxy(request: NextRequest): Promise<NextResponse | Response> {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith('/api/') || pathname === '/api') {
    return handleApiRequest(request);
  }
  return intlMiddleware(request);
}

export const config = {
  // 覆盖 API 路由 + 页面路由；排除 _next 静态资源、Vercel 内部路径和静态文件
  matcher: ['/((?!_next|_vercel|.*\\..*).*)'],
};
