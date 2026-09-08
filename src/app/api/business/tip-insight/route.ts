import { NextRequest, NextResponse } from 'next/server';
import { getForwardHeaders } from '@/lib/api-helpers';
import { invokeChat } from '@/lib/ai/router';
import { getTenantContext, requireBusinessContext } from '@/lib/tenant';
import { scopedTable } from '@/lib/tenant-db';

// AI 小费洞察：基于近 7 天小费数据生成可执行建议（含员工表现排名、桌位、时段）
// （P0-S2 完整版：tenant 过滤）
export async function GET(request: NextRequest) {
  const ctx = requireBusinessContext(await getTenantContext(request));
  const locale = request.nextUrl.searchParams.get('locale') ?? 'en';
  const forwardHeaders = getForwardHeaders(request);

  const weekStart = new Date();
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - 6);

  const ordersRes = await scopedTable(ctx, 'orders', 'tip, tip_percent, table_no, tip_staff_id, created_at')
    .gte('created_at', weekStart.toISOString())
    .neq('status', 'cancelled');
  const orders = (ordersRes.data ?? []) as {
    tip: string | number | null;
    tip_percent: string | number | null;
    table_no: string | null;
    tip_staff_id: string | null;
    created_at: string;
  }[];

  const staffRes = await scopedTable(ctx, 'staff', 'id, name');
  const staffName = new Map<string, string>(
    ((staffRes.data ?? []) as { id: string; name: string }[]).map((s) => [s.id, s.name]),
  );

  const tipped = orders.filter((o) => Number(o.tip ?? 0) > 0);
  const totalTip = orders.reduce((s, o) => s + Number(o.tip ?? 0), 0);
  const avgPercent = tipped.length ? tipped.reduce((s, o) => s + Number(o.tip_percent ?? 0), 0) / tipped.length : 0;

  const hourTip = new Map<number, number>();
  const tableTip = new Map<string, number>();
  const staffTip = new Map<string, { tip: number; count: number }>();
  for (const o of tipped) {
    const h = new Date(o.created_at).getHours();
    hourTip.set(h, (hourTip.get(h) ?? 0) + Number(o.tip ?? 0));
    if (o.table_no) tableTip.set(o.table_no, (tableTip.get(o.table_no) ?? 0) + Number(o.tip ?? 0));
    if (o.tip_staff_id) {
      const cur = staffTip.get(o.tip_staff_id) ?? { tip: 0, count: 0 };
      staffTip.set(o.tip_staff_id, { tip: cur.tip + Number(o.tip ?? 0), count: cur.count + 1 });
    }
  }

  const topTables = [...tableTip.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, v]) => `${t}($${v.toFixed(2)})`).join(', ');
  const topHours = [...hourTip.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h, v]) => `${h}点($${v.toFixed(2)})`).join(', ');
  const staffRank = [...staffTip.entries()]
    .sort((a, b) => b[1].tip - a[1].tip)
    .map(([id, v]) => `${staffName.get(id) ?? id}($${v.tip.toFixed(2)}/${v.count}单)`)
    .join(', ');

  const langText = locale === 'zh' ? '中文' : locale === 'es' ? '西班牙语' : '英文';
  const facts = [
    `近7天小费总额 $${totalTip.toFixed(2)}`,
    `有小费订单 ${tipped.length} 单，平均小费比例 ${avgPercent.toFixed(1)}%`,
    `员工小费排名: ${staffRank || '暂无'}`,
    `给最多小费的桌位: ${topTables || '暂无'}`,
    `给最多小费的时段: ${topHours || '暂无'}`,
  ].join('\n');

  const system = `你是 RoveFrame AI COO。用${langText}根据小费数据给出简洁、可执行的小费经营洞察：先按员工表现排名并点评，再分析桌位/时段，最后给出提高小费的 2-3 条建议。用 Markdown 分点，不要编造数据。`;

  const insight = await invokeChat(
    'agent',
    [
      { role: 'system', content: system },
      { role: 'user', content: facts },
    ],
    forwardHeaders,
    { tenantId: ctx.tenantId, businessId: ctx.businessId, userId: ctx.userId },
  );

  return NextResponse.json({ insight });
}
