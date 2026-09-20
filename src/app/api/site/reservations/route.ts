import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { resolvePublishedSiteBySlug } from '@/lib/public-site';
import {
  checkFixedWindow,
  getClientIp,
  rateLimitResponse,
} from '@/lib/rate-limit';

/**
 * 官网预约（公开写入口）。
 *
 * ## 为什么不复用 /api/reservations
 *
 * 那三个 handler 全部要求登录（src/app/api/reservations/route.ts:19,75,94 都调
 * `requireBusinessContext(await getTenantContext(request))`）。官网访客没有会话，
 * 而"官网能预约"正是这次要补的能力。
 *
 * ## 边界
 *
 *   · 租户 / 商家**只从 slug 服务端解析**，客户端传什么都不看。公开接口上
 *     任何"客户端指定 tenant_id"的形态都是越权写入。
 *   · 字段白名单 + 长度上限 + 时间必须落在合理窗口内。
 *   · 限流按 IP 与 slug 两条线（复用 src/lib/rate-limit 的固定窗口）。
 *   · 写入 status='pending'：预约在后台仍需人工确认，官网不能直接把桌子占掉。
 */

const MAX_PARTY_SIZE = 40;
/** 只接受未来 1 小时到 180 天之间的预约，挡住误填与明显的脚本噪声。 */
const MIN_LEAD_MS = 60 * 60 * 1000;
const MAX_LEAD_MS = 180 * 24 * 60 * 60 * 1000;

interface BookingBody {
  slug?: unknown;
  customer_name?: unknown;
  phone?: unknown;
  party_size?: unknown;
  reserved_at?: unknown;
  notes?: unknown;
}

function asTrimmedString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export async function POST(request: NextRequest) {
  let body: BookingBody;
  try {
    body = (await request.json()) as BookingBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const slug = asTrimmedString(body.slug, 63).toLowerCase();
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });

  const ipLimit = checkFixedWindow(`site:booking:ip:${getClientIp(request)}`, {
    limit: 10,
    windowMs: 60 * 60_000,
  });
  if (!ipLimit.ok) return rateLimitResponse(ipLimit);
  const slugLimit = checkFixedWindow(`site:booking:slug:${slug}`, {
    limit: 60,
    windowMs: 60 * 60_000,
  });
  if (!slugLimit.ok) return rateLimitResponse(slugLimit);

  const site = await resolvePublishedSiteBySlug(slug);
  if (!site) return NextResponse.json({ error: 'site not found' }, { status: 404 });

  const customerName = asTrimmedString(body.customer_name, 80);
  const phone = asTrimmedString(body.phone, 40);
  if (!customerName) return NextResponse.json({ error: 'name required' }, { status: 400 });
  if (phone.replace(/[^0-9]/g, '').length < 5) {
    return NextResponse.json({ error: 'valid phone required' }, { status: 400 });
  }

  const partySize = Number(body.party_size ?? 2);
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > MAX_PARTY_SIZE) {
    return NextResponse.json({ error: `party_size must be 1..${MAX_PARTY_SIZE}` }, { status: 400 });
  }

  const reservedAtRaw = asTrimmedString(body.reserved_at, 40);
  const reservedAt = new Date(reservedAtRaw);
  if (!reservedAtRaw || Number.isNaN(reservedAt.getTime())) {
    return NextResponse.json({ error: 'reserved_at must be an ISO timestamp' }, { status: 400 });
  }
  const lead = reservedAt.getTime() - Date.now();
  if (lead < MIN_LEAD_MS || lead > MAX_LEAD_MS) {
    return NextResponse.json({ error: 'reserved_at is outside the bookable window' }, { status: 400 });
  }

  const notes = asTrimmedString(body.notes, 500);

  const { data, error } = await getSupabaseClient()
    .from('reservations')
    .insert({
      tenant_id: site.tenant_id,
      business_id: site.business_id,
      customer_name: customerName,
      phone,
      party_size: partySize,
      table_no: null,
      reserved_at: reservedAt.toISOString(),
      // 与后台手工登记区分开：后台能看出这条是官网自助来的。
      source: 'website',
      notes: notes || null,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error) {
    console.error('[site/reservations] insert failed:', error.message);
    return NextResponse.json({ error: 'booking could not be stored' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: (data as { id: string }).id });
}
