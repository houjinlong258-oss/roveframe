import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { encrypt, decrypt, mask } from '@/lib/crypto';
import { PROVIDER_PRESETS } from '@/lib/ai/providers';

// 模型服务商接入管理
export async function GET() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('model_configs').select('*');
  if (error) throw new Error(error.message);

  const byProvider: Record<string, { maskedKey: string; baseUrl: string | null; defaultModel: string | null; isEnabled: boolean; lastTestOk: boolean | null }> = {};
  for (const row of data ?? []) {
    let plain = '';
    if (row.api_key_encrypted) {
      try {
        plain = decrypt(row.api_key_encrypted);
      } catch {
        plain = '';
      }
    }
    byProvider[row.provider] = {
      maskedKey: mask(plain),
      baseUrl: row.base_url,
      defaultModel: row.default_model,
      isEnabled: row.is_enabled,
      lastTestOk: row.last_test_ok,
    };
  }

  const providers = Object.entries(PROVIDER_PRESETS).map(([id, preset]) => {
    const stored = byProvider[id];
    const fallback = {
      maskedKey: '',
      baseUrl: preset.baseUrl || null,
      defaultModel: preset.models[0] ?? null,
      isEnabled: false,
      lastTestOk: null,
    };
    return {
      id,
      label: preset.label,
      models: preset.models,
      keyHint: preset.keyHint,
      ...(stored ?? fallback),
    };
  });
  return NextResponse.json({ providers });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const provider: string = body.provider;
  const preset = PROVIDER_PRESETS[provider];
  if (!preset) return NextResponse.json({ error: 'unknown provider' }, { status: 400 });

  const supabase = getSupabaseClient();
  const record: Record<string, unknown> = {
    provider,
    base_url: body.baseUrl ?? preset.baseUrl ?? null,
    default_model: body.defaultModel ?? preset.models[0] ?? null,
    is_enabled: true,
    last_test_ok: body.lastTestOk ?? null,
    last_tested_at: body.lastTestOk != null ? new Date().toISOString() : null,
  };
  if (body.apiKey) record.api_key_encrypted = encrypt(body.apiKey);

  const { data: existing } = await supabase.from('model_configs').select('id').eq('provider', provider).maybeSingle();
  if (existing) {
    const { error } = await supabase.from('model_configs').update(record).eq('id', existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from('model_configs').insert(record);
    if (error) throw new Error(error.message);
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const provider = request.nextUrl.searchParams.get('provider');
  if (!provider) return NextResponse.json({ error: 'provider required' }, { status: 400 });
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('model_configs').delete().eq('provider', provider);
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
}
