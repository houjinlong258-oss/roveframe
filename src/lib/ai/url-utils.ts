/**
 * AI provider endpoint 的 URL 拼接与 SSRF 校验。
 *
 * - joinEndpoint 处理 base URL 已含 /v1、尾斜杠、双斜杠等情况。
 * - assertBaseUrlAllowed 阻止生产环境把模型请求打到云 metadata、
 *   loopback、内网管理地址；本地模型仅在非生产显式 opt-in。
 * - checkBaseUrlResolved 在字面校验之上叠加 DNS 解析逐地址复检
 *   （防公网域名解析到内网的重绑定），供发起真实连接前调用。
 */

import { assertDnsResolutionSafe, expandIpv6, isBlockedIPv6, isMetadataHostname, isRebindingHostname, parseSingleNumberIpv4 } from '@/lib/security/outbound-url';

/** 把 base 与 path 拼成单个 URL，避免出现 /v1/v1 或双斜杠。 */
export function joinEndpoint(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const suffix = path.trim().replace(/^\/+/, '');
  if (!base) return `/${suffix}`;
  // base 已经以该路径首段结尾（如 .../v1 + v1/messages）时不重复拼接
  const firstSeg = suffix.split('/')[0];
  if (firstSeg && base.toLowerCase().endsWith(`/${firstSeg.toLowerCase()}`)) {
    const rest = suffix.slice(firstSeg.length).replace(/^\/+/, '');
    return rest ? `${base}/${rest}` : base;
  }
  return `${base}/${suffix}`;
}

export interface BaseUrlPolicy {
  /** 允许 http:// 与 loopback/私网地址（本地模型 opt-in，仅非生产） */
  allowLocal?: boolean;
  /** 视为生产环境（默认按 NODE_ENV 判断） */
  production?: boolean;
}

const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.azure.internal',
]);

const BLOCKED_IPS = new Set(['169.254.169.254', '100.100.100.200']);

function isIPv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isPrivateIPv4(host: string): boolean {
  if (!isIPv4(host)) return false;
  const [a, b] = host.split('.').map(Number);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true;
  // CGNAT（运营商级 NAT，不可作为公网出站目标）
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** IPv6 字面量是否为 loopback/ULA/链路本地/映射私网/保留 */
function isPrivateIPv6Literal(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  const bytes = expandIpv6(bare);
  if (!bytes) return false;
  return isBlockedIPv6(bytes);
}

/**
 * host 是否为**字面量的** loopback / 私网 / 链路本地地址。
 *
 * 注意必须用 isIPv4 严格判定，不能用 `startsWith('127.')`：后者会把
 * `127.0.0.1.nip.io` 这种**域名**误判成本地字面量 —— 那正是重绑定攻击的典型形态，
 * 报「这是本地地址」会掩盖真实性质。（这个坑是写守卫时被自己的断言抓到的。）
 */
function isLocalLiteralHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '::1' ||
    (isIPv4(host) && host.startsWith('127.')) ||
    isPrivateIPv4(host) ||
    isPrivateIPv6Literal(host)
  );
}

export interface BaseUrlCheck {
  ok: boolean;
  reason?: string;
  url?: URL;
}

/**
 * 校验自定义 base URL（同步字面校验，不发起 DNS）。
 * 生产默认：仅 https，公网主机，禁止 metadata/loopback/私网/重绑定域名。
 * 非生产 + allowLocal：允许 http 与 loopback/私网（本地 Ollama/LM Studio 等），
 * 但仍禁止云 metadata 地址。
 */
export function checkBaseUrl(raw: string, policy: BaseUrlPolicy = {}): BaseUrlCheck {
  const production = policy.production ?? process.env.NODE_ENV === 'production';
  const allowLocal = policy.allowLocal ?? false;

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');

  // 云 metadata 在任何环境下都禁止
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_IPS.has(host) || isMetadataHostname(host)) {
    return { ok: false, reason: 'metadata_endpoint_blocked' };
  }

  const isLoopback = host === 'localhost' || host === '::1' || host.startsWith('127.');

  // 本机别名（localhost / *.local / *.internal …）本来就落在 REBINDING_HOSTNAME_PATTERNS 里，
  // 但它被拒的真实原因是「这是本地地址」，不是「域名会重绑定」。原因串要说对，
  // 否则用户看到 rebinding_hostname_blocked 根本猜不到该去勾「允许本地/内网地址」。
  if (!allowLocal && isLocalLiteralHost(host) && isRebindingHostname(host)) {
    return { ok: false, reason: 'local_address_requires_optin' };
  }
  // DNS 重绑定域名：默认拒绝；本地模型显式 opt-in 才放行
  if (!allowLocal && isRebindingHostname(host)) {
    return { ok: false, reason: 'rebinding_hostname_blocked' };
  }

  if (url.protocol === 'https:') {
    if (production && !allowLocal && (isLoopback || isPrivateIPv4(host) || isPrivateIPv6Literal(host))) {
      return { ok: false, reason: 'private_address_blocked_in_production' };
    }
    return { ok: true, url };
  }

  if (url.protocol === 'http:') {
    const localTarget = isLoopback || isPrivateIPv4(host) || isPrivateIPv6Literal(host);
    // 公网明文 http 任何环境都拒绝（密钥会明文传输）
    if (!localTarget) return { ok: false, reason: 'plaintext_http_to_public_host' };
    // 本地模型必须显式 opt-in
    if (!allowLocal) return { ok: false, reason: 'local_http_requires_optin' };
    return { ok: true, url };
  }

  return { ok: false, reason: 'unsupported_protocol' };
}

/**
 * 字面校验 + DNS 解析逐地址复检（防域名重绑定到私网/loopback/metadata）。
 * 供即将发起真实连接的调用点使用；DNS 失败按拒绝处理（fail-closed）。
 */
export async function checkBaseUrlResolved(raw: string, policy: BaseUrlPolicy = {}): Promise<BaseUrlCheck> {
  const check = checkBaseUrl(raw, policy);
  if (!check.ok || !check.url) return check;
  const host = check.url.hostname.toLowerCase().replace(/\.$/, '');
  const looksLikeLiteral = isIPv4(host)
    || parseSingleNumberIpv4(host) !== null
    || expandIpv6(host.replace(/^\[|\]$/g, '')) !== null;
  if (looksLikeLiteral) return check;
  if (policy.allowLocal) return check;
  try {
    await assertDnsResolutionSafe(host);
  } catch {
    return { ok: false, reason: 'dns_resolves_to_private' };
  }
  return check;
}

/** 校验失败时抛出带原因的 Error；成功返回规范化 URL 字符串。 */
export function assertBaseUrlAllowed(raw: string, policy: BaseUrlPolicy = {}): string {
  const check = checkBaseUrl(raw, policy);
  if (!check.ok) {
    throw new Error(`base_url_rejected:${check.reason}`);
  }
  return check.url!.toString().replace(/\/+$/, '');
}
