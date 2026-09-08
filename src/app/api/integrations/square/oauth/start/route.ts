import { createHmac } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext } from '@/lib/tenant';
import { buildSquareOAuthUrl, squareOAuthEnv } from '@/lib/connectors/square';

const STATE_TTL_MS = 10 * 60_000;

function stateSecret(): string {
  const secret = process.env.ENCRYPTION_SECRET?.trim();
  if (!secret) throw new Error('ENCRYPTION_SECRET is not configured');
  return secret;
}

function buildState(tenantId: string, businessId: string, ts: number): string {
  const payload = tenantId + '.' + businessId + '.' + ts;
  const mac = createHmac('sha256', stateSecret()).update(payload).digest('hex').slice(0, 32);
  return Buffer.from(payload + '.' + mac).toString('base64url');
}

/** Connect with Square：生成签名 state 并跳转 Square OAuth 授权页。 */
export async function GET(request: NextRequest) {
  const ctx = requireBusinessContext(await getTenantContext(request));
  const { appId } = squareOAuthEnv();
  if (!appId) {
    return NextResponse.json({ error: 'SQUARE_APP_ID is not configured on this deployment' }, { status: 503 });
  }
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin).replace(/\/$/, '');
  const redirectUri = appUrl + '/api/integrations/square/oauth/callback';
  const state = buildState(ctx.tenantId, ctx.businessId, Date.now());
  const authorizeUrl = buildSquareOAuthUrl({ appId, redirectUri, state });
  return NextResponse.redirect(authorizeUrl);
}

/** 供回调校验 state（同一签名密钥与 TTL）。 */
export function verifySquareOAuthState(state: string): { tenantId: string; businessId: string } | null {
  try {
    const raw = Buffer.from(state, 'base64url').toString('utf8');
    const parts = raw.split('.');
    if (parts.length !== 4) return null;
    const [tenantId, businessId, tsText, mac] = parts;
    const ts = Number(tsText);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > STATE_TTL_MS) return null;
    const payload = tenantId + '.' + businessId + '.' + ts;
    const expected = createHmac('sha256', stateSecret()).update(payload).digest('hex').slice(0, 32);
    if (mac !== expected) return null;
    return { tenantId, businessId };
  } catch {
    return null;
  }
}
