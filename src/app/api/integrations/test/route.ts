import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';

// 集成连通性测试：按服务商调用真实只读接口
async function testIntegration(request: NextRequest) {
  const context = await getTenantContext(request);
  requirePermission(context, 'integrations:write');
  const body = await request.json();
  const provider: string = body.provider;
  const config = body.config ?? {};

  try {
    switch (provider) {
      case 'erpnext': {
        const { url, apiKey, apiSecret } = config;
        if (!url || !apiKey || !apiSecret) return NextResponse.json({ ok: false, error: 'url, apiKey, apiSecret required' });
        const resp = await fetch(`${url.replace(/\/$/, '')}/api/method/ping`, {
          headers: { Authorization: `token ${apiKey}:${apiSecret}` },
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) return NextResponse.json({ ok: false, error: `HTTP ${resp.status}` });
        return NextResponse.json({ ok: true });
      }
      case 'square': {
        const { accessToken } = config;
        if (!accessToken) return NextResponse.json({ ok: false, error: 'accessToken required' });
        const resp = await fetch('https://connect.squareup.com/v2/locations', {
          headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': '2024-05-15' },
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) return NextResponse.json({ ok: false, error: `HTTP ${resp.status}` });
        return NextResponse.json({ ok: true });
      }
      case 'shopify': {
        const { shopDomain, accessToken } = config;
        if (!shopDomain || !accessToken) return NextResponse.json({ ok: false, error: 'shopDomain, accessToken required' });
        const resp = await fetch(`https://${shopDomain}/admin/api/2024-04/shop.json`, {
          headers: { 'X-Shopify-Access-Token': accessToken },
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) return NextResponse.json({ ok: false, error: `HTTP ${resp.status}` });
        return NextResponse.json({ ok: true });
      }
      case 'stripe': {
        const { secretKey } = config;
        if (!secretKey) return NextResponse.json({ ok: false, error: 'secretKey required' });
        const resp = await fetch('https://api.stripe.com/v1/balance', {
          headers: { Authorization: `Bearer ${secretKey}` },
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) return NextResponse.json({ ok: false, error: `HTTP ${resp.status}` });
        return NextResponse.json({ ok: true });
      }
      case 'paypal': {
        const { clientId, clientSecret } = config;
        if (!clientId || !clientSecret) return NextResponse.json({ ok: false, error: 'clientId, clientSecret required' });
        const resp = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
          body: 'grant_type=client_credentials',
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) return NextResponse.json({ ok: false, error: `HTTP ${resp.status}` });
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ ok: false, error: 'unknown provider' }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'connection failed' });
  }
}

export const POST = protectBusinessMutation(
  { permission: 'integrations:write', action: 'integrations.test', entity: 'integration_configs' },
  testIntegration,
);
