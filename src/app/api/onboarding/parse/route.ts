import { NextResponse } from 'next/server';
import {
  parseBusinessDescription,
  sanitizeOnboardingInput,
  MAX_ONBOARDING_INPUT,
} from '@/lib/onboarding/parse';
import { checkFixedWindow, getClientIp, rateLimitResponse } from '@/lib/rate-limit';

/** 公开解析端点的每 IP 阈值（见下方 POST 的注释）。 */
export const ONBOARDING_PARSE_LIMIT_PER_MIN = 20;

/**
 * POST /api/onboarding/parse
 * 自然语言 → 严格 schema 草稿。纯函数，无任何副作用：
 * 不创建 tenant/business、不连接外部系统、不发送邮件。
 * 公开路由（注册前可用），有输入长度与频率两层自我保护。
 *
 * ## 频率保护是后补的（这段注释此前不成立）
 *
 * 原文写的是"有输入长度与频率的自我保护"，而代码里**只有长度检查** ——
 * 独立审查把它记为"注释与代码不一致"，并指出这种不一致本身就是缺陷
 * （下一个人读注释会以为限流已经在，于是不再加）。
 *
 * 选择补实现而不是改注释：本路由是**公开**的（注册前可用、无需会话），
 * `parseBusinessDescription` 是同步 CPU 工作，没有限流时任何人可以无限次打它。
 * 现在按 IP 限流，并把 429 交给 `rateLimitResponse`（带 Retry-After）。
 *
 * 阈值取 20 次/分钟：引导向导里正常用户是"打几段字、重试几次"的量级，
 * 20 次足够宽松；而它同时把脚本化滥用挡在 CPU 之前。
 */
export async function POST(request: Request) {
  // 限流放在**解析 body 之前**：连坏请求也要计数，否则"解析失败"就是免费的。
  const decision = checkFixedWindow(`onboarding:parse:ip:${getClientIp(request)}`, {
    limit: ONBOARDING_PARSE_LIMIT_PER_MIN,
    windowMs: 60_000,
  });
  if (!decision.ok) return rateLimitResponse(decision);

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
