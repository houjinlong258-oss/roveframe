import { NextRequest, NextResponse } from 'next/server';
import { getForwardHeaders } from '@/lib/api-helpers';
import { buildBriefing, getChannelConfig, listConnectedChannels, sendChannelMessage } from '@/lib/channels';
import { CHANNEL_KEYS, type ChannelKey } from '@/lib/channels-presets';

// 推送到社交通讯渠道
// body: { provider?: ChannelKey, text?: string, locale?: string }
//   - 无 provider：向所有已连接渠道广播（默认 AI 经营简报）
//   - 有 provider：仅向该渠道发送（text 缺省时用 AI 简报，常用于发送测试消息）
export async function POST(request: NextRequest) {
  const body = await request.json();
  const provider = (body.provider ?? null) as ChannelKey | null;
  const text = (body.text ?? '') as string;
  const locale = (body.locale ?? 'en') as string;
  const forwardHeaders = getForwardHeaders(request);

  if (provider && !CHANNEL_KEYS.includes(provider)) {
    return NextResponse.json({ error: 'invalid channel provider' }, { status: 400 });
  }

  const targets: ChannelKey[] = provider ? [provider] : await listConnectedChannels();
  if (targets.length === 0) {
    return NextResponse.json({ ok: false, error: 'no connected channels' });
  }

  const message = text && text.trim() ? text.trim() : await buildBriefing(locale, forwardHeaders);

  const sent: string[] = [];
  const failed: { provider: string; error: string }[] = [];
  for (const ch of targets) {
    const config = await getChannelConfig(ch);
    if (!config) {
      failed.push({ provider: ch, error: 'not configured' });
      continue;
    }
    try {
      await sendChannelMessage(ch, config, message);
      sent.push(ch);
    } catch (err) {
      failed.push({ provider: ch, error: err instanceof Error ? err.message : 'send failed' });
    }
  }

  return NextResponse.json({ ok: sent.length > 0, sent, failed });
}