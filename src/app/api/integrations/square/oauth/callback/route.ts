import { NextRequest, NextResponse } from 'next/server';
import { encrypt } from '@/lib/crypto';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { exchangeSquareCode, fetchSquareLocations, squareOAuthEnv } from '@/lib/connectors/square';
import { verifySquareOAuthState } from '../start/route';

/** Square OAuth 回调：验 state → 换 token → 绑定 location → 加密持久化。 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin).replace(/\/$/, '');
  const settingsUrl = appUrl + '/settings?integrated=square&status=';
  if (!code || !state) {
    return NextResponse.redirect(settingsUrl + 'error&reason=missing_params');
  }
  const scope = verifySquareOAuthState(state);
  if (!scope) {
    return NextResponse.redirect(settingsUrl + 'error&reason=invalid_state');
  }

  // 服务身份 ≠ 租户授权：state 携带的 tenant/business 配对必须真实存在。
  const supabase = getSupabaseClient();
  const { data: biz } = await supabase.from('businesses')
    .select('id').eq('tenant_id', scope.tenantId).eq('id', scope.businessId).maybeSingle();
  if (!biz) {
    return NextResponse.redirect(settingsUrl + 'error&reason=business_not_found');
  }

  const { appId, appSecret } = squareOAuthEnv();
  if (!appId || !appSecret) {
    return NextResponse.redirect(settingsUrl + 'error&reason=oauth_not_configured');
  }

  try {
    const redirectUri = appUrl + '/api/integrations/square/oauth/callback';
    const tokens = await exchangeSquareCode({ appId, appSecret, code, redirectUri });
    const locations = await fetchSquareLocations(tokens.access_token);
    const config = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? '',
      expiresAt: tokens.expires_at ?? '',
      merchantId: tokens.merchant_id ?? '',
      locationIds: locations.map((loc) => loc.id),
      locationNames: locations.map((loc) => loc.name),
    };
    const record = {
      provider: 'square',
      config_encrypted: encrypt(JSON.stringify(config)),
      sync_scope: [],
      is_enabled: true,
      status: 'connected',
      last_sync_at: new Date().toISOString(),
    };
    const { data: existing } = await supabase.from('integration_configs')
      .select('id').eq('tenant_id', scope.tenantId).eq('business_id', scope.businessId)
      .eq('provider', 'square').maybeSingle();
    const result = existing
      ? await supabase.from('integration_configs').update(record)
        .eq('id', (existing as { id: string }).id)
        .eq('tenant_id', scope.tenantId).eq('business_id', scope.businessId)
      : await supabase.from('integration_configs').insert({
          tenant_id: scope.tenantId, business_id: scope.businessId, ...record,
        });
    if (result.error) {
      return NextResponse.redirect(settingsUrl + 'error&reason=' + encodeURIComponent(result.error.message));
    }
    return NextResponse.redirect(settingsUrl + 'ok');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return NextResponse.redirect(settingsUrl + 'error&reason=' + encodeURIComponent(reason));
  }
}
