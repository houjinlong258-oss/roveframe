/**
 * 应用对外 origin 的**单一解析口**。
 *
 * 需要它的地方都有一个共同性质：链接会被**离开本站**再回来
 * （邮件里的退订链接、支付回跳、OAuth 回调），因此不能用相对路径。
 *
 * 解析优先级：
 *   1. `NEXT_PUBLIC_APP_URL`（部署方可显式指定，反向代理/自定义域名场景必须用它）
 *   2. 请求自身的 origin（直连容器端口时可用；生产若走代理，代理必须传对 host）
 *
 * 与 Stripe/Square 回调用的是同一套约定（它们原先各自内联了两行同样的代码）。
 */
export function resolveAppOrigin(request?: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // 配置写错时不要静默回落到请求 origin —— 那会让邮件里的链接指向容器内网地址。
      // 抛错让部署方立刻看到配置问题。
      throw new Error('NEXT_PUBLIC_APP_URL is not a valid absolute URL');
    }
  }
  if (request) {
    try {
      return new URL(request.url).origin;
    } catch {
      // fall through
    }
  }
  throw new Error('cannot resolve app origin: set NEXT_PUBLIC_APP_URL or pass a request');
}
