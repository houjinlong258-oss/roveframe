import { NextRequest, NextResponse } from 'next/server';
import { getForwardHeaders } from '@/lib/api-helpers';
import { invokeChat, type ChatContent } from '@/lib/ai/router';

// AI 商品创建/优化：根据文本描述或商品图片生成名称/描述/分类/SEO 关键词/标签
export async function POST(request: NextRequest) {
  const body = await request.json();
  const brief = String(body.brief ?? '').trim();
  const image = typeof body.image === 'string' ? body.image.trim() : '';
  if (!brief && !image) return NextResponse.json({ error: 'brief or image required' }, { status: 400 });
  const locale = body.locale === 'zh' ? 'zh' : body.locale === 'es' ? 'es' : 'en';
  const forwardHeaders = getForwardHeaders(request);

  const lang = locale === 'zh' ? '中文' : locale === 'es' ? '西班牙语' : '英文';
  const system =
    `你是电商商品文案专家。用${lang}根据用户提供的描述或照片生成商品信息，只返回 JSON（不要 Markdown 代码块，不要多余文字）：` +
    '{"name":"商品名","description":"一句话卖点描述","category":"分类（如 招牌菜/经典菜/零售）","seo_keywords":["关键词1","关键词2","关键词3"],"tags":["标签1","标签2"]}';

  // 有图片时构造多模态 user 内容（图 + 可选文字）
  const userContent: ChatContent = image
    ? [
        { type: 'text', text: brief || '请根据这张商品照片生成商品名称、描述、分类与关键词。' },
        { type: 'image_url', image_url: { url: image } },
      ]
    : brief;

  const raw = await invokeChat(
    'content',
    [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ],
    forwardHeaders,
  );

  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return NextResponse.json({ product: parsed });
  } catch {
    // AI 未返回合法 JSON 时兜底
    return NextResponse.json({
      product: { name: (brief || '商品').slice(0, 40), description: brief || '', category: '招牌菜', seo_keywords: [], tags: [] },
    });
  }
}