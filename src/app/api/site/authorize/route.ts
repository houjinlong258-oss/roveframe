import { NextRequest, NextResponse } from 'next/server';
import { isHostAuthorizedForCertificate } from '@/lib/public-site';

/**
 * 证书签发的询问端点（Caddy `on_demand_tls.ask`）。
 *
 * Caddy 在为一个**尚未持有证书**的 Host 握手前会先问这里；只有 2xx 才去签发。
 * 没有这道闸，任何把域名解析到本服务器的人都能让本机替他申请 Let's Encrypt
 * 证书 —— 既是滥用，也会把签发的速率配额耗光，让真正的商家签不出来。
 *
 * 因此这里是 **fail-closed**：任何解析失败、查库失败、状态不是 active，
 * 一律 404。查询参数名 `domain` 是 Caddy 的约定；同时接受 Host 头，
 * 以便用 curl 手工核对。
 *
 * 公开路径（无会话凭据），见 src/lib/auth-guard.ts 的 PUBLIC_API_PREFIXES。
 */
export async function GET(request: NextRequest) {
  const host = request.nextUrl.searchParams.get('domain') ?? request.headers.get('host');
  let allowed = false;
  try {
    allowed = await isHostAuthorizedForCertificate(host ?? '');
  } catch {
    // 明确吞掉异常并保持拒绝：这里抛 500 会让 Caddy 反复重试同一个域名。
    allowed = false;
  }
  return new NextResponse(null, { status: allowed ? 200 : 404 });
}
