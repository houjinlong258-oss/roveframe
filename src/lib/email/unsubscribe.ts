/**
 * 邮件退订 —— 合规的**执行点**（Phase 16 任务 4）。
 *
 * 三件事必须一起成立，缺一条就不算合规：
 *   1. 每封批量邮件带 `List-Unsubscribe` / `List-Unsubscribe-Post` 头（RFC 8058）；
 *   2. 正文里有一个人能点的退订链接（不能只靠头，很多客户端不读头）；
 *   3. 退订**被持续遵守** —— 出件前过滤，而不是记下来就算。
 *
 * 地址归一化用 `lower(trim())`。这不是洁癖：不做归一化时
 * `Alice@x.com` 与 `alice@x.com` 会是两个身份，退订后换个大小写就能继续发，
 * 等于退订无效。
 */

import { randomBytes } from 'node:crypto';
import { getSupabaseClient } from '@/storage/database/supabase-client';

/** 归一化地址：去空白 + 小写。所有比较与写入都必须经过它。 */
export function canonicalizeEmail(address: string): string {
  return address.trim().toLowerCase();
}

/** 退订链接里的一次性令牌（32 字节，URL-safe） */
export function generateUnsubscribeToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * 退订链接的对外形状。
 *
 * 用 `/api/email/unsubscribe?token=…` —— 一个**公开**路由。
 * 为什么不做成页面：邮件客户端里的退订按钮会直接 POST 到头里的 URL
 * （RFC 8058 `List-Unsubscribe-Post: List-Unsubscribe=One-Click`），
 * 那必须是 API 而不是一个需要 JS 的页面；同时 GET 也要能给人看。
 */
export function unsubscribeUrlFor(origin: string, token: string): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}/api/email/unsubscribe?token=${encodeURIComponent(token)}`;
}

/** 商家侧能看到并能点的落点（前台页面，给人用）。 */
export function unsubscribePageUrlFor(origin: string, locale: string, token: string): string {
  const base = origin.replace(/\/+$/, '');
  const lang = ['en', 'zh', 'es'].includes(locale) ? locale : 'en';
  return `${base}/${lang}/unsubscribe?token=${encodeURIComponent(token)}`;
}

export interface UnsubscribeRecord {
  id: string;
  tenant_id: string;
  business_id: string;
  email: string;
  token: string;
}

/** 查这条地址是否已退订（出件前必查）。查库失败按"不可发送"处理由调用方决定。 */
export async function findUnsubscribe(
  tenantId: string,
  businessId: string,
  address: string,
): Promise<UnsubscribeRecord | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('email_unsubscribes')
    .select('id, tenant_id, business_id, email, token')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .eq('email', canonicalizeEmail(address))
    .maybeSingle();
  if (error) throw new Error(`unsubscribe lookup failed: ${error.message}`);
  return (data as UnsubscribeRecord | null) ?? null;
}

/** 按令牌反查（退订入口用它定位 tenant/business/email）。 */
export async function findUnsubscribeByToken(token: string): Promise<UnsubscribeRecord | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('email_unsubscribes')
    .select('id, tenant_id, business_id, email, token')
    .eq('token', token)
    .maybeSingle();
  if (error) throw new Error(`unsubscribe token lookup failed: ${error.message}`);
  return (data as UnsubscribeRecord | null) ?? null;
}

/**
 * 写入退订（幂等）。
 *
 * 同一个地址重复退订返回 `created: false`，不报错 —— 用户点两次不该看到错误，
 * 而且邮件客户端确实会重试 one-click POST。
 */
export async function recordUnsubscribe(input: {
  tenantId: string;
  businessId: string;
  address: string;
  token?: string;
  reason?: string;
  source?: string;
}): Promise<{ created: boolean; token: string }> {
  const supabase = getSupabaseClient();
  const email = canonicalizeEmail(input.address);
  const existing = await findUnsubscribe(input.tenantId, input.businessId, email);
  if (existing) return { created: false, token: existing.token };

  const token = input.token ?? generateUnsubscribeToken();
  const { error } = await supabase.from('email_unsubscribes').insert({
    tenant_id: input.tenantId,
    business_id: input.businessId,
    email,
    token,
    reason: input.reason ?? 'link',
    source: input.source ?? null,
  });
  if (error) {
    // 并发退订：唯一索引冲突说明另一个请求刚写入，按幂等处理
    if (/duplicate key|unique constraint/i.test(error.message)) {
      const again = await findUnsubscribe(input.tenantId, input.businessId, email);
      if (again) return { created: false, token: again.token };
    }
    throw new Error(`unsubscribe insert failed: ${error.message}`);
  }
  return { created: true, token };
}

/** 出件主循环批量预取：一次查询拿到本批所有已退订地址，避免逐封查库。 */
export async function loadUnsubscribedAddresses(
  tenantId: string,
  businessId: string,
  addresses: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(addresses.map(canonicalizeEmail))].filter(Boolean);
  if (unique.length === 0) return new Set();
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('email_unsubscribes')
    .select('email')
    .eq('tenant_id', tenantId)
    .eq('business_id', businessId)
    .in('email', unique);
  if (error) throw new Error(`unsubscribe batch lookup failed: ${error.message}`);
  return new Set((data ?? []).map((row) => canonicalizeEmail(String((row as { email: string }).email))));
}

/**
 * 在正文末尾追加退订说明。
 *
 * 纯文本邮件（当前出件就是 text）没有可点击的锚点，所以链接明文附在文末，
 * 同时把同样的 URL 放进 `List-Unsubscribe` 头 —— 两条路都给。
 */
export function appendUnsubscribeFooter(body: string, url: string, businessName?: string): string {
  const who = businessName ? ` from ${businessName}` : '';
  const footer =
    `\n\n---\n` +
    `You are receiving this email${who} because you are a customer on record.\n` +
    `Unsubscribe: ${url}\n`;
  // 已经带过页脚就不要重复追加（同一封信可能被重排后再追加一次）
  if (body.includes(url)) return body;
  return `${body.trimEnd()}${footer}`;
}

/** RFC 8058 要求的两个头。`List-Unsubscribe-Post` 让客户端能一键退订。 */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
