/**
 * Phase 2/7 — Enterprise Kernel: Memory（四级企业记忆）
 *
 * Global Knowledge（平台级知识库文档）
 *   → Industry Knowledge（按行业标签过滤的文档）
 *   → Business Memory（本店经营快照 + 定制规则）
 *   → Customer Memory（单个客户 360，可选）
 *
 * 每层独立容错：某层数据源不可用（迁移未应用/无凭据）时降级为空层，
 * 不阻塞整体组装。纯组装层，不写库。
 */

import { getSupabaseClient } from '@/storage/database/supabase-client';

export interface MemoryLayer {
  level: 'global' | 'industry' | 'business' | 'customer';
  available: boolean;
  /** 组装的文本上下文（可注入系统提示词） */
  content: string;
}

export interface EnterpriseMemoryContext {
  tenantId: string;
  businessId: string;
  layers: MemoryLayer[];
  /** 拼好的完整上下文（非空层用标题分隔） */
  combined: string;
}

interface DocRow {
  title: string;
  content: string;
  industry: string | null;
}

async function loadDocs(tenantId: string, businessId: string, industry?: string): Promise<DocRow[]> {
  try {
    let q = getSupabaseClient()
      .from('knowledge_docs')
      .select('title, content, industry')
      .order('created_at', { ascending: false })
      .limit(20);
    q = q.eq('tenant_id', tenantId).eq('business_id', businessId);
    if (industry) q = q.eq('industry', industry);
    const { data, error } = await q;
    if (error || !data) return [];
    return data as DocRow[];
  } catch {
    return [];
  }
}

async function loadBusinessIndustry(tenantId: string, businessId: string): Promise<string | null> {
  try {
    const { data, error } = await getSupabaseClient()
      .from('businesses')
      .select('industry')
      .eq('tenant_id', tenantId)
      .eq('id', businessId)
      .maybeSingle();
    if (error || !data) return null;
    return (data as { industry: string | null }).industry;
  } catch {
    return null;
  }
}

async function loadBusinessSnapshot(tenantId: string, businessId: string): Promise<string> {
  try {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { data, error } = await getSupabaseClient()
      .from('orders')
      .select('total')
      .eq('tenant_id', tenantId)
      .eq('business_id', businessId)
      .gte('created_at', since);
    if (error || !data) return '';
    const rows = data as { total: string }[];
    const revenue = rows.reduce((s, r) => s + Number(r.total || 0), 0);
    return `近 7 天：订单 ${rows.length} 笔，营收 ${Math.round(revenue * 100) / 100}。`;
  } catch {
    return '';
  }
}

async function loadCustomerMemory(
  tenantId: string,
  businessId: string,
  customerId: string,
): Promise<string> {
  try {
    const { data, error } = await getSupabaseClient()
      .from('customers')
      .select('name, visit_count, total_spent, churn_risk, last_visit_at')
      .eq('tenant_id', tenantId)
      .eq('business_id', businessId)
      .eq('id', customerId)
      .maybeSingle();
    if (error || !data) return '';
    const c = data as {
      name: string;
      visit_count: number | null;
      total_spent: string | null;
      churn_risk: string | null;
      last_visit_at: string | null;
    };
    return `客户 ${c.name}：到店 ${c.visit_count ?? 0} 次，累计消费 ${c.total_spent ?? 0}，流失风险 ${c.churn_risk ?? '未知'}，最近到店 ${c.last_visit_at ?? '未知'}。`;
  } catch {
    return '';
  }
}

/**
 * 组装四级记忆。customerId 可选；任一数据源失败时对应层降级为空。
 */
export async function assembleMemoryContext(opts: {
  tenantId: string;
  businessId: string;
  customerId?: string;
}): Promise<EnterpriseMemoryContext> {
  const { tenantId } = opts;
  const { businessId } = opts;
  if (!businessId) throw new Error('business scope is required for enterprise memory');
  const layers: MemoryLayer[] = [];

  // L1 Global
  const globalDocs: DocRow[] = [];
  layers.push({
    level: 'global',
    available: globalDocs.length > 0,
    content: globalDocs.map((d) => `• ${d.title}`).join('\n'),
  });

  // L2 Industry
  const industry = await loadBusinessIndustry(tenantId, businessId);
  const industryDocs = industry ? await loadDocs(tenantId, businessId, industry) : [];
  layers.push({
    level: 'industry',
    available: industryDocs.length > 0,
    content: industryDocs.map((d) => `• ${d.title}`).join('\n'),
  });

  // L3 Business
  const snapshot = await loadBusinessSnapshot(tenantId, businessId);
  layers.push({ level: 'business', available: snapshot.length > 0, content: snapshot });

  // L4 Customer
  if (opts.customerId) {
    const customer = await loadCustomerMemory(tenantId, businessId, opts.customerId);
    layers.push({ level: 'customer', available: customer.length > 0, content: customer });
  }

  const combined = layers
    .filter((l) => l.available && l.content)
    .map((l) => `## ${l.level.toUpperCase()}\n${l.content}`)
    .join('\n\n');

  return { tenantId, businessId, layers, combined };
}
