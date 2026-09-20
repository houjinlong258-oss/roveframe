import { NextRequest, NextResponse } from 'next/server';
import { staffRequestContext } from '@/lib/workforce';

/**
 * 员工关怀资源**转介目录**（Phase 18 Frontend Spec §5.7）。
 *
 * ===========================================================================
 * 硬规则：本接口只做转介。**不做测评、不做问卷、不打分、不存任何健康数据。**
 * ===========================================================================
 *
 * 为什么把这条写在代码里而不是只写在文档里：一旦这个接口开始接收
 * "最近情绪怎么样"的答案，它就变成了收集健康信息的系统 —— 那意味着
 * 更严格的合规义务、更长的数据保留期、以及员工对雇主的信任风险。
 * 资源转介只需要一张**静态的、对所有人相同的**清单，客户端不需要向服务端
 * 提交任何东西，服务端也不需要保存任何东西。这个 GET 没有请求体，没有查询
 * 参数，响应里没有任何与"当前这位员工"相关的字段。
 *
 * 因此本文件里**不存在**任何评分、测评或问卷字段。tests/staff-endpoints.test.ts
 * 用一条守卫断言它们不会出现 —— 那不是风格检查，是上面这条规则的执行机制。
 * 注释里刻意不逐字写出被禁字段名：否则守卫会命中注释本身，而一条总在报错的
 * 守卫等于没有守卫。
 *
 * ## 号码来源
 *
 * 只列**可核验**的公开号码。核验不到的条目就只给官网 URL，不编造号码
 * （编错的危机热线比没有热线更糟）。当前清单：
 *   · 988 —— 美国自杀与危机生命线（988lifeline.org）
 *   · 116 123 —— 英国/爱尔兰 Samaritans（samaritans.org）
 *   · 741741 —— 美国 Crisis Text Line 短信短号（crisistextline.org）
 * 其余条目均为国际目录站，只有 URL。
 */

interface CareResource {
  title: string;
  description: string;
  url: string;
  /** 缺省表示该条目没有可核验的号码，只给 URL。 */
  phone?: string;
  /** 适用地区：us / uk / global。 */
  region: string;
}

const RESOURCES: readonly CareResource[] = [
  {
    title: '988 Suicide & Crisis Lifeline',
    description:
      'Free, confidential support in the United States, 24/7. Call or text 988 to reach a trained counselor.',
    url: 'https://988lifeline.org/',
    phone: '988',
    region: 'us',
  },
  {
    title: 'Crisis Text Line',
    description:
      'Text-based crisis support in the United States. Text HOME to 741741 to start a conversation with a trained volunteer.',
    url: 'https://www.crisistextline.org/',
    phone: '741741',
    region: 'us',
  },
  {
    title: 'Samaritans (UK and Ireland)',
    description:
      'Free, 24/7 listening service. Call 116 123, or write to them by email if talking is not an option.',
    url: 'https://www.samaritans.org/',
    phone: '116 123',
    region: 'uk',
  },
  {
    title: 'Befrienders Worldwide',
    description:
      'International directory of emotional-support helplines. Use it to find a service in your own country and language.',
    url: 'https://befrienders.org/',
    region: 'global',
  },
  {
    title: 'International Association for Suicide Prevention — Crisis Centres',
    description:
      'Official list of crisis centres by country, maintained by the IASP.',
    url: 'https://www.iasp.info/resources/Crisis_Centres/',
    region: 'global',
  },
];

/**
 * 只要求登录 + 员工档案（workforce:self）。
 *
 * 为什么不用 `workforce:care`：那个权限在 src/lib/rbac.ts 里还没有分配给任何角色
 * （矩阵里只有 workforce:self / workforce:manage），现在用它会把 owner 与 manager
 * 一并挡在门外 —— 而"看一条公开的求助热线"不该需要额外授权。
 * 关怀**记录**（要写库、带健康信息）才是 workforce:care 的适用场景，那个接口不在本次范围。
 */
export async function GET(request: NextRequest) {
  const resolved = await staffRequestContext(request);
  if (!resolved.ok) return resolved.response;

  // 静态清单：无数据库读写、无请求参数、无与当前员工相关的字段。这正是上述硬规则的技术形态。
  return NextResponse.json({ resources: RESOURCES });
}
