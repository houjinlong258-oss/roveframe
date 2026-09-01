import { NextRequest, NextResponse } from 'next/server';
import { getSettings, updateSettings } from '@/lib/settings';

// 业务信息 / 语言与地区 / AI 偏好 / 模型分配（单行 jsonb）
export async function GET() {
  const settings = await getSettings();
  return NextResponse.json(settings);
}

export async function PUT(request: NextRequest) {
  const body = await request.json();
  const patch: Record<string, unknown> = {};
  for (const key of ['business', 'locale', 'ai_prefs', 'model_assign'] as const) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 });
  }
  await updateSettings(patch);
  return NextResponse.json({ ok: true });
}
