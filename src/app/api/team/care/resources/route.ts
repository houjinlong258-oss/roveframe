import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requireBusinessContext, requirePermission } from '@/lib/tenant';

/**
 * 老板端的关怀资源清单（静态、精选、可直接拨打/打开）。
 *
 * ## 为什么是静态常量而不是数据库表
 *
 * 这份清单的内容是**公开的求助渠道**，不是门店数据：
 *   · 它不随租户变化，放进库里只会多一份要维护、且会与代码漂移的副本；
 *   · 它没有写入口（没有任何接口能改它）—— 一份只能读的表等价于一个常量。
 * 将来若要做"门店自定义推荐资源"，那时再建表，并把自定义条目与本清单**并列**
 * 返回（而不是覆盖），否则一次误编辑就会让求助渠道消失。
 *
 * ## 与员工端共用同一份内容
 *
 * 老板端与员工端看到的是同一批资源：链接和电话没有"角色相关"的部分。
 * 分开维护两份必然漂移（其中一份会先过期），所以两边引用同一形状的数据。
 *
 * ## phone 与 url 允许为空
 *
 * 不同地区的渠道形态不同（有的是电话，有的是网页）。用 `null` 明确表示"这个地区
 * 没有这条渠道"，而不是空字符串 —— 空串在 UI 上会渲染成一个空的 tel: 链接。
 */

interface CareResource {
  title: string;
  description: string;
  url: string | null;
  phone: string | null;
  /** global | US | international …（UI 用它分组，不用于权限判断） */
  region: string;
  category: 'crisis' | 'helpline' | 'self_care' | 'training';
}

const RESOURCES: readonly CareResource[] = [
  {
    title: '988 Suicide & Crisis Lifeline',
    description: 'Call or text 988 any time, day or night, in the US. Free and confidential support for people in distress, plus prevention and crisis resources.',
    url: 'https://988lifeline.org/',
    phone: '988',
    region: 'US',
    category: 'crisis',
  },
  {
    title: 'Crisis Text Line',
    description: 'Text HOME to 741741 to reach a trained volunteer crisis counselor in the US. For anything from anxiety to self-harm.',
    url: 'https://www.crisistextline.org/',
    phone: '741741',
    region: 'US',
    category: 'crisis',
  },
  {
    title: 'Find A Helpline',
    description: 'Free, confidential support over phone, text or chat in over 130 countries. Start here if you are outside the US.',
    url: 'https://findahelpline.com/',
    phone: null,
    region: 'international',
    category: 'crisis',
  },
  {
    title: 'International Association for Suicide Prevention — crisis centres',
    description: 'Directory of crisis centres worldwide, maintained by the IASP.',
    url: 'https://www.iasp.info/resources/Crisis_Centres/',
    phone: null,
    region: 'international',
    category: 'crisis',
  },
  {
    title: 'SAMHSA National Helpline',
    description: 'Free, confidential, 24/7 treatment referral and information service (US) for mental health or substance use concerns. English and Spanish.',
    url: 'https://www.samhsa.gov/find-help/national-helpline',
    phone: '1-800-662-4357',
    region: 'US',
    category: 'helpline',
  },
  {
    title: '211',
    description: 'Dial 211 (US and much of Canada) for local help with food, housing, utilities, counselling and other everyday needs. Confidential and free.',
    url: 'https://www.211.org/',
    phone: '211',
    region: 'US',
    category: 'helpline',
  },
  {
    title: 'World Health Organization — mental health',
    description: 'Plain-language guidance on stress, burnout and when to seek professional help.',
    url: 'https://www.who.int/health-topics/mental-health',
    phone: null,
    region: 'global',
    category: 'self_care',
  },
  {
    title: 'Insight Timer',
    description: 'Free guided meditations and short breathing exercises — useful for a five-minute reset between shifts.',
    url: 'https://insighttimer.com/',
    phone: null,
    region: 'global',
    category: 'self_care',
  },
  {
    title: 'Mental Health First Aid',
    description: 'Evidence-based training on how to recognise and respond to signs of distress in the workplace. Courses are available in many countries.',
    url: 'https://www.mentalhealthfirstaid.org/',
    phone: null,
    region: 'global',
    category: 'training',
  },
];

export async function GET(request: NextRequest) {
  let context;
  try {
    context = requireBusinessContext(await getTenantContext(request));
    requirePermission(context, 'workforce:care');
  } catch (error) {
    const status = (error as { status?: number }).status === 403 ? 403 : 401;
    return NextResponse.json({ error: status === 403 ? 'forbidden' : 'unauthorized' }, { status });
  }

  // 与员工端**逐字段同形**（title / description / url / phone / region / category），
  // 便于两侧复用同一个渲染组件。这里额外返回 category 供老板端分组展示；
  // 员工端的实现若没有 category，前端按缺省值处理即可。
  return NextResponse.json({ resources: RESOURCES.map((resource) => ({ ...resource })) });
}
