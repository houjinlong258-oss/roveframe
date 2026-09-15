import { NextRequest, NextResponse } from 'next/server';
import { getForwardHeaders } from '@/lib/api-helpers';
import { invokeChat, type ChatContent } from '@/lib/ai/router';
import { getTenantContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';

// AI 商品创建/优化：根据文本描述或商品图片生成名称/描述/分类/SEO 关键词/标签
async function generateProduct(request: NextRequest) {
  const context = await getTenantContext(request);
  requirePermission(context, 'products:write');
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
    { tenantId: context.tenantId, businessId: context.businessId, userId: context.userId },
  );

  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return NextResponse.json({ product: parsed, source: 'model' });
  } catch {
    // 模型未返回合法 JSON。原实现在这里返回 HTTP 200 + 一个编造的商品
    // （category 硬编码 '招牌菜'，name 缺省 '商品'），与成功响应无法区分。
    // 现在只回填**用户自己提供**的信息，并显式标记 source='fallback'：
    // 不推断分类、不生成关键词，缺什么由用户补。
    return NextResponse.json({
      product: {
        name: brief.slice(0, 40),
        description: brief,
        category: '',
        seo_keywords: [],
        tags: [],
      },
      source: 'fallback',
      warning: locale === 'zh'
        ? 'AI 未返回合法 JSON，已回填你输入的描述。分类、SEO 关键词与标签需要手动填写。'
        : locale === 'es'
          ? 'La IA no devolvió JSON válido; se rellenó con tu descripción. La categoría, las palabras clave y las etiquetas deben completarse a mano.'
          : 'The AI did not return valid JSON; your description was filled in as-is. Category, SEO keywords and tags must be completed manually.',
    });
  }
}

export const POST = protectBusinessMutation(
  { permission: 'products:write', action: 'products.generate', entity: 'products' },
  generateProduct,
);
