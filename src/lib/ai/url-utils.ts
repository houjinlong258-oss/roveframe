/**
 * AI provider endpoint 的 URL 拼接与 SSRF 校验。
 *
 * - joinEndpoint 处理 base URL 已含 /v1、尾斜杠、双斜杠等情况。
 * - assertBaseUrlAllowed 阻止生产环境把模型请求打到云 metadata、
 *   loopback、内网管理地址；本地模型仅在非生产显式 opt-in。
 */

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
  return false;
}

export interface BaseUrlCheck {
  ok: boolean;
  reason?: string;
  url?: URL;
}

/**
 * 校验自定义 base URL。
 * 生产默认：仅 https，公网主机，禁止 metadata/loopback/私网。
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

  const host = url.hostname.toLowerCase();
  const isLoopback = host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.');

  // 云 metadata 在任何环境下都禁止
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_IPS.has(host)) {
    return { ok: false, reason: 'metadata_endpoint_blocked' };
  }

  if (url.protocol === 'https:') {
    if (production && !allowLocal && (isLoopback || isPrivateIPv4(host))) {
      return { ok: false, reason: 'private_address_blocked_in_production' };
    }
    return { ok: true, url };
  }

  if (url.protocol === 'http:') {
    const localTarget = isLoopback || isPrivateIPv4(host);
    // 公网明文 http 任何环境都拒绝（密钥会明文传输）
    if (!localTarget) return { ok: false, reason: 'plaintext_http_to_public_host' };
    // 本地模型必须显式 opt-in
    if (!allowLocal) return { ok: false, reason: 'local_http_requires_optin' };
    return { ok: true, url };
  }

  return { ok: false, reason: 'unsupported_protocol' };
}

/** 校验失败时抛出带原因的 Error；成功返回规范化 URL 字符串。 */
export function assertBaseUrlAllowed(raw: string, policy: BaseUrlPolicy = {}): string {
  const check = checkBaseUrl(raw, policy);
  if (!check.ok) {
    throw new Error(`base_url_rejected:${check.reason}`);
  }
  return check.url!.toString().replace(/\/+$/, '');
}
