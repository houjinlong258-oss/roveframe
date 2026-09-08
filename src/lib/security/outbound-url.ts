/**
 * 出站 URL 统一安全校验与受控 fetch（P0 SSRF 防护）。
 *
 * 供 AI 路由（外部模型/多模态图片）、渠道 webhook、集成连通性测试等
 * 所有「服务端代客户端/配置发起出站请求」的调用点统一使用。
 *
 * 防护层次：
 *   1. 协议白名单（仅 http/https）
 *   2. 静态 hostname 拒绝（localhost、*.internal、DNS 重绑定域名 nip.io 族）
 *   3. IP 字面量逐段检查（v4/v6、v4-mapped、云 metadata）
 *   4. 域名 DNS 全量解析后逐地址检查（防「公网域名解析到内网」重绑定）
 *   5. 重定向逐跳复检（redirect: manual，≤5 跳，非 GET 不跟随）
 *
 * 默认策略与生产一致：仅 https + 公网地址；本地模型（Ollama/LM Studio）
 * 等场景由调用方显式传 allowPrivate + allowHttp opt-in（仅限非生产）。
 */
import { lookup } from 'node:dns/promises';

export interface OutboundUrlPolicy {
  /** 允许 http:// 明文（显式 opt-in，仅非生产本地模型场景） */
  allowHttp?: boolean;
  /** 允许解析到 loopback/私网/保留地址（显式 opt-in，仅非生产本地模型场景） */
  allowPrivate?: boolean;
}

/** 云 metadata 与链路本地保留地址（任何策略下都拒绝） */
const BLOCKED_METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.azure.internal',
]);

const BLOCKED_METADATA_IPS = new Set(['169.254.169.254', '100.100.100.200']);

/** 已知 DNS 重绑定/本机别名域名后缀（静态拒绝，无需解析） */
const REBINDING_HOSTNAME_PATTERNS: readonly RegExp[] = [
  /\.nip\.io$/i,
  /\.sslip\.io$/i,
  /\.xip\.io$/i,
  /\.lvh\.me$/i,
  /\.traefik\.me$/i,
  /^localtest\.me$/i,
  /^localhost$/i,
  /^localhost\.localdomain$/i,
  /\.local$/i,
  /\.home\.arpa$/i,
  /\.internal$/i,
  /\.lan$/i,
  /\.localhost$/i,
];

// ---------------------------------------------------------------------------
// 字面量分析（无网络）
// ---------------------------------------------------------------------------

function parseDottedQuad(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    nums.push(value);
  }
  return nums;
}

/** 十进制数字形式的整段 IPv4（URL 解析器通常已归一，这里兜底） */
export function parseSingleNumberIpv4(host: string): number[] | null {
  if (!/^\d{1,10}$/.test(host)) return null;
  const value = Number(host);
  if (!Number.isSafeInteger(value) || value > 0xffffffff) return null;
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** 展开 IPv6（支持 ::、内嵌 IPv4、%zone），返回 16 字节或 null */
export function expandIpv6(host: string): number[] | null {
  const noZone = host.split('%')[0];
  if (!noZone.includes(':')) return null;
  const parts = noZone.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  let v4: number[] | null = null;
  if (right.length && right[right.length - 1].includes('.')) {
    v4 = parseDottedQuad(right[right.length - 1]);
    if (!v4) return null;
    right.pop();
  }
  for (const group of [...left, ...right]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
  }
  const consumed = left.length + right.length + (v4 ? 2 : 0);
  let fill = 0;
  if (parts.length === 2) {
    fill = 8 - consumed;
    if (fill < 0) return null;
  } else if (consumed !== 8) {
    return null;
  }
  const bytes: number[] = [];
  for (const group of [...left, ...Array(fill).fill('0'), ...right]) {
    const value = parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  if (v4) bytes.push(...v4);
  return bytes.length === 16 ? bytes : null;
}

function isPrivateIPv4(nums: number[]): boolean {
  const [a, b] = nums;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 192 && b === 0 && nums[2] === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && nums[2] === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  if (a === 198 && b === 51 && nums[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && nums[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function ipv6Prefix(bytes: number[], bits: number, expectedHex: number[]): boolean {
  const fullBytes = Math.floor(bits / 8);
  for (let i = 0; i < fullBytes; i += 1) {
    if (bytes[i] !== expectedHex[i]) return false;
  }
  const remainingBits = bits % 8;
  if (remainingBits > 0) {
    const mask = 0xff << (8 - remainingBits);
    if ((bytes[fullBytes] & mask) !== (expectedHex[fullBytes] & mask)) return false;
  }
  return true;
}

export function isBlockedIPv6(bytes: number[]): boolean {
  if (bytes.every((b) => b === 0)) return true; // ::
  if (ipv6Prefix(bytes, 8, [0x00])) return true; // 保留
  if (ipv6Prefix(bytes, 128, [...Array(15).fill(0), 1])) return true; // ::1 loopback
  if (ipv6Prefix(bytes, 10, [0xfe, 0x80])) return true; // fe80::/10 link-local
  if (ipv6Prefix(bytes, 7, [0xfc])) return true; // fc00::/7 ULA
  if (bytes[0] === 0xff) return true; // multicast
  if (ipv6Prefix(bytes, 32, [0x20, 0x01, 0x0d, 0xb8])) return true; // 2001:db8::/32 文档
  // IPv4-mapped（::ffff:a.b.c.d）按内嵌 v4 判定
  if (ipv6Prefix(bytes, 96, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff])) {
    return isPrivateIPv4([bytes[12], bytes[13], bytes[14], bytes[15]]);
  }
  return false;
}

/** 云 metadata 主机名（任何策略下都拒绝） */
export function isMetadataHostname(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return BLOCKED_METADATA_HOSTNAMES.has(normalized);
}

/** 已知 DNS 重绑定/本机别名域名（默认拒绝；allowPrivate 显式 opt-in 时放行） */
export function isRebindingHostname(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return REBINDING_HOSTNAME_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** 静态拒绝：重绑定域名与云 metadata 主机名（同步字面校验用） */
export function isBlockedHostname(host: string): boolean {
  return isMetadataHostname(host) || isRebindingHostname(host);
}

/** IP 字面量（v4/v6/mapped）是否为保留/私网/loopback/链路本地 */
export function isBlockedAddressLiteral(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (BLOCKED_METADATA_IPS.has(normalized)) return true;
  const v4 = parseDottedQuad(normalized) ?? parseSingleNumberIpv4(normalized);
  if (v4) return isPrivateIPv4(v4);
  const v6 = expandIpv6(normalized);
  if (v6) return isBlockedIPv6(v6);
  return false;
}

// ---------------------------------------------------------------------------
// DNS 解析校验（防域名重绑定）
// ---------------------------------------------------------------------------

async function resolveAddresses(host: string): Promise<string[]> {
  const results = await lookup(host, { all: true });
  return results.map((entry) => entry.address);
}

/** 域名解析后的每个地址都必须是公网地址，否则抛错（DNS 失败亦拒绝）。 */
export async function assertDnsResolutionSafe(host: string): Promise<void> {
  let addresses: string[];
  try {
    addresses = await resolveAddresses(host);
  } catch {
    throw new Error('outbound_url_rejected:dns_resolution_failed');
  }
  if (addresses.length === 0) {
    throw new Error('outbound_url_rejected:dns_resolution_failed');
  }
  for (const address of addresses) {
    if (isBlockedAddressLiteral(address)) {
      throw new Error('outbound_url_rejected:dns_resolves_to_private');
    }
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/** 校验出站 URL；通过时返回规范化后的 URL 字符串，否则抛结构化 Error。 */
export async function assertSafeOutboundUrl(
  raw: string,
  policy: OutboundUrlPolicy = {},
): Promise<string> {
  const allowHttp = policy.allowHttp ?? false;
  const allowPrivate = policy.allowPrivate ?? false;

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('outbound_url_rejected:invalid_url');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('outbound_url_rejected:unsupported_protocol');
  }
  if (url.protocol === 'http:' && !allowHttp) {
    throw new Error('outbound_url_rejected:plaintext_http_forbidden');
  }

  const host = url.hostname.toLowerCase();
  if (isMetadataHostname(host)) {
    throw new Error('outbound_url_rejected:blocked_hostname');
  }
  if (!allowPrivate && isRebindingHostname(host)) {
    throw new Error('outbound_url_rejected:blocked_hostname');
  }

  // 云 metadata IP 在任何策略下（含本地模型 opt-in）都拒绝
  const hostBare = host.replace(/^\[|\]$/g, '');
  if (BLOCKED_METADATA_IPS.has(hostBare)) {
    throw new Error('outbound_url_rejected:blocked_hostname');
  }

  const literalBlocked = isBlockedAddressLiteral(host);
  if (literalBlocked) {
    if (allowPrivate) return url.toString();
    throw new Error('outbound_url_rejected:private_address_blocked');
  }

  // 非 IP 字面量：DNS 解析后逐地址复检
  const looksLikeIp = parseDottedQuad(host.replace(/^\[|\]$/g, '')) !== null
    || parseSingleNumberIpv4(host) !== null
    || expandIpv6(host.replace(/^\[|\]$/g, '')) !== null;
  if (!looksLikeIp) {
    if (!allowPrivate) {
      await assertDnsResolutionSafe(host);
    }
  }
  return url.toString();
}

const MAX_OUTBOUND_REDIRECTS = 5;

/**
 * 受控 fetch：请求前校验 URL，重定向逐跳复检（最多 5 跳）。
 * 非 GET/HEAD 方法不跟随重定向（防 POST 凭据/正文被重放到任意目标）。
 */
export async function fetchWithOutboundGuard(
  url: string,
  init: RequestInit,
  policy: OutboundUrlPolicy = {},
  redirectsLeft: number = MAX_OUTBOUND_REDIRECTS,
): Promise<Response> {
  const target = await assertSafeOutboundUrl(url, policy);
  const method = (init.method ?? 'GET').toUpperCase();
  const resp = await fetch(target, { ...init, redirect: 'manual' });
  const isRedirect = resp.status >= 300 && resp.status < 400;
  if (!isRedirect) return resp;
  const location = resp.headers.get('location');
  if (!location) return resp;
  if (redirectsLeft <= 0) {
    throw new Error('outbound_url_rejected:too_many_redirects');
  }
  if (method !== 'GET' && method !== 'HEAD') {
    throw new Error('outbound_url_rejected:redirect_after_mutation_blocked');
  }
  const next = new URL(location, target).toString();
  return fetchWithOutboundGuard(next, init, policy, redirectsLeft - 1);
}
