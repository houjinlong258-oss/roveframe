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

/**
 * Phase 12 / P0-4 —— 请求 id 贯通。
 *
 * 一次请求要能跨「中间件 → 路由 handler → 日志 → 上游 AI / Runtime」被串起来，
 * 否则线上排查只能靠时间戳猜。此前只有零星几处自己生成 requestId（13 个文件
 * 提到它），没有统一点，因此没有一条链路是完整可追的。
 *
 * 两条规则：
 *   1. 优先复用调用方传入的 `x-request-id`（负载均衡/网关通常已生成），
 *      这样跨服务是一次追踪而不是两次。
 *   2. **但只接受形态受控的值。** 该 id 会进入日志；原样接受任意客户端字符串
 *      等于开放日志注入（换行可伪造日志行、超长可撑爆日志）。不匹配就重新生成，
 *      不报错 —— request id 的价值在于可追踪，不在于校验失败时中断请求。
 */
const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

function resolveRequestId(request: NextRequest): string {
  const incoming = request.headers.get(REQUEST_ID_HEADER);
  if (incoming && REQUEST_ID_PATTERN.test(incoming)) return incoming;
  return globalThis.crypto.randomUUID();
}

function unauthorized(error: string): NextResponse {
  return NextResponse.json({ error: `unauthorized: ${error}` }, { status: 401 });
}

async function handleApiRequest(request: NextRequest, requestId: string): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // 平台控制面：与商户会话完全分离，不走 Supabase 商户 token 边界，
  // 由路由内 requirePlatformAdmin 独立守卫（商户 token 一律无效）。
  if (pathname.startsWith('/api/admin/')) {
    const headers = new Headers(request.headers);
    stripRfHeaders(headers);
    headers.set(REQUEST_ID_HEADER, requestId);
    return NextResponse.next({ request: { headers } });
  }

  // 公开路由：剥离伪造头后直接放行
  if (isPublicApiPath(pathname)) {
    const headers = new Headers(request.headers);
    stripRfHeaders(headers);
    headers.set(REQUEST_ID_HEADER, requestId);
    return NextResponse.next({ request: { headers } });
  }

  const resolved = await resolveRequestUser(request);
  if (!resolved.ok) {
    return unauthorized(resolved.error);
  }

  const headers = new Headers(request.headers);
  injectRfHeaders(headers, resolved.user);
  headers.set(REQUEST_ID_HEADER, requestId);
  return NextResponse.next({ request: { headers } });
}

export default async function proxy(request: NextRequest): Promise<NextResponse | Response> {
  const { pathname } = request.nextUrl;
  const requestId = resolveRequestId(request);

  // 回显在**所有**响应上，包括 401：鉴权失败恰恰是最需要追踪的一类请求。
  if (pathname.startsWith('/api/') || pathname === '/api') {
    const response = await handleApiRequest(request, requestId);
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return response;
  }

  const response = intlMiddleware(request);
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

export const config = {
  // 覆盖 API 路由 + 页面路由；排除 _next 静态资源、Vercel 内部路径和静态文件
  matcher: ['/((?!_next|_vercel|.*\\..*).*)'],
};
