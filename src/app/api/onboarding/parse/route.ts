import { NextResponse } from 'next/server';
import {
  parseBusinessDescription,
  sanitizeOnboardingInput,
  MAX_ONBOARDING_INPUT,
} from '@/lib/onboarding/parse';

/**
 * POST /api/onboarding/parse
 * 自然语言 → 严格 schema 草稿。纯函数，无任何副作用：
 * 不创建 tenant/business、不连接外部系统、不发送邮件。
 * 公开路由（注册前可用），但有输入长度与频率的自我保护。
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) {
    return NextResponse.json({ error: 'text required' }, { status: 400 });
  }
  if (text.length > MAX_ONBOARDING_INPUT * 2) {
    return NextResponse.json({ error: `input too long (max ${MAX_ONBOARDING_INPUT} chars)` }, { status: 413 });
  }

  const sanitized = sanitizeOnboardingInput(text);
  if (sanitized.length < 4) {
    return NextResponse.json({ error: 'please describe your business in a few words' }, { status: 400 });
  }

  try {
    const draft = parseBusinessDescription(sanitized);
    return NextResponse.json({ draft });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'parse failed' },
      { status: 422 },
    );
  }
}
