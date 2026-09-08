import { NextRequest, NextResponse } from 'next/server';
import { testChannelConnection } from '@/lib/channels';
import { CHANNEL_KEYS, type ChannelKey } from '@/lib/channels-presets';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';

// 渠道连通性测试
async function testChannel(request: NextRequest) {
  const context = requireBusinessContext(await getTenantContext(request));
  requirePermission(context, 'channels:write');
  const body = await request.json();
  const provider: ChannelKey = body.provider;
  const config = (body.config ?? {}) as Record<string, string>;

  if (!provider || !CHANNEL_KEYS.includes(provider)) {
    return NextResponse.json({ ok: false, error: 'invalid channel provider' }, { status: 400 });
  }
  const result = await testChannelConnection(provider, config);
  return NextResponse.json(result);
}

export const POST = protectBusinessMutation(
  { permission: 'channels:write', action: 'channels.test', entity: 'channels' },
  testChannel,
);
