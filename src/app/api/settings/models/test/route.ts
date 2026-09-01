import { NextRequest, NextResponse } from 'next/server';
import { PROVIDER_PRESETS } from '@/lib/ai/providers';

// 真实连通性测试：对目标服务商发一次最小请求
export async function POST(request: NextRequest) {
  const body = await request.json();
  const provider: string = body.provider;
  const preset = PROVIDER_PRESETS[provider];
  if (!preset) return NextResponse.json({ error: 'unknown provider' }, { status: 400 });

  const apiKey: string = body.apiKey;
  const baseUrl: string = body.baseUrl || preset.baseUrl;
  const model: string = body.model || preset.models[0];
  if (!apiKey) return NextResponse.json({ ok: false, error: 'API Key required' }, { status: 400 });
  if (!baseUrl || !model) return NextResponse.json({ ok: false, error: 'Base URL and model required' }, { status: 400 });

  try {
    if (preset.protocol === 'anthropic') {
      const resp = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) return NextResponse.json({ ok: false, error: `HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}` });
      return NextResponse.json({ ok: true });
    }

    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return NextResponse.json({ ok: false, error: `HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}` });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'connection failed' });
  }
}
