import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getDeviceIdFromRequest, setDeviceIdCookieHeader } from '@/lib/customer-identity';
import { getErrorMessage } from '@/lib/api-helpers';

/**
 * Customer Favorites API (PWA Sprint 2 - C-PWA-2.3)
 *
 * 公开 API,无 tenant 过滤(customer_favorites 不带 tenant_id)
 * 用 cookie 中的 device_id 隔离
 *
 * GET    /api/customer/favorites            -> { favorites: [{ business_id, created_at }] }
 * POST   /api/customer/favorites { business_id }  -> 201
 * DELETE /api/customer/favorites?business_id=xxx -> 200
 *
 * 首次访问:无 device_id cookie → 生成 UUID + Set-Cookie
 */

export async function GET(request: NextRequest) {
  try {
    const deviceId = await ensureDeviceId(request);
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('customer_favorites')
      .select('business_id, created_at')
      .eq('device_id', deviceId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return jsonWithDeviceIdCookie({ favorites: data ?? [] }, deviceId, request);
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const deviceId = await ensureDeviceId(request);
    const body = (await request.json()) as { business_id?: string };
    if (!body.business_id) {
      return NextResponse.json({ error: 'business_id required' }, { status: 400 });
    }
    const client = getSupabaseClient();
    // 校验 business 存在(避免 dangling FK)
    const bizRes = await client
      .from('businesses')
      .select('id')
      .eq('id', body.business_id)
      .maybeSingle();
    if (bizRes.error) throw bizRes.error;
    if (!bizRes.data) {
      return NextResponse.json({ error: 'business not found' }, { status: 404 });
    }
    // upsert: 已存在则忽略(unique (device_id, business_id) 兜底)
    const { error } = await client
      .from('customer_favorites')
      .upsert(
        { device_id: deviceId, business_id: body.business_id },
        { onConflict: 'device_id,business_id', ignoreDuplicates: true },
      );
    if (error) throw error;
    return jsonWithDeviceIdCookie({ ok: true, business_id: body.business_id }, deviceId, request, 201);
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const deviceId = await ensureDeviceId(request);
    const businessId = request.nextUrl.searchParams.get('business_id');
    if (!businessId) {
      return NextResponse.json({ error: 'business_id required' }, { status: 400 });
    }
    const client = getSupabaseClient();
    const { error } = await client
      .from('customer_favorites')
      .delete()
      .eq('device_id', deviceId)
      .eq('business_id', businessId);
    if (error) throw error;
    return jsonWithDeviceIdCookie({ ok: true, business_id: businessId }, deviceId, request);
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}

/**
 * 拿 device_id:优先从 cookie 读,没有用 NextResponse 设新 cookie
 * (用 next/headers cookies() API)
 */
async function ensureDeviceId(request: NextRequest): Promise<string> {
  const fromCookie = getDeviceIdFromRequest(request);
  if (fromCookie) return fromCookie;
  // 第一次访问,生成新的
  return crypto.randomUUID();
}

/**
 * 统一响应:携带 Set-Cookie(确保 device_id 持久化到浏览器)
 */
function jsonWithDeviceIdCookie(
  body: Record<string, unknown>,
  deviceId: string,
  request: NextRequest,
  status = 200,
): NextResponse {
  const res = NextResponse.json(body, { status });
  // 只有当 cookie 之前没有时才设(避免重复 Set-Cookie)
  if (!getDeviceIdFromRequest(request)) {
    res.headers.append('Set-Cookie', setDeviceIdCookieHeader(deviceId));
  }
  return res;
}
