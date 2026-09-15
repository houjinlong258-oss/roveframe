import { getForwardHeaders, jsonError, errorResponse, sseResponse } from '@/lib/api-helpers';
import { streamChat, type ChatMessage } from '@/lib/ai/router';
import { embedText } from '@/lib/embedding';
import { getTenantContext, requireBusinessContext } from '@/lib/tenant';
import { scopedTable } from '@/lib/tenant-db';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { protectBusinessMutation } from '@/lib/mutation-guard';

async function askKnowledge(request: Request) {
  try {
    const ctx = requireBusinessContext(await getTenantContext(request));
    const body = (await request.json()) as { question: string; locale?: string };
    if (!body.question?.trim()) return jsonError('empty question', 400);
    const locale = body.locale ?? 'en';
    const forwardHeaders = getForwardHeaders(request);
    const client = getSupabaseClient();

    // 1. 问题向量化
    const queryEmbedding = await embedText(body.question, forwardHeaders);

    // 2. 向量检索最相关的分块（RPC 必须传 tenant_id，否则跨租户串味）
    const { data: chunks, error } = await client.rpc('match_doc_chunks', {
      query_embedding: JSON.stringify(queryEmbedding),
      match_count: 5,
      filter_tenant_id: ctx.tenantId,
      filter_business_id: ctx.businessId,
    });

    /**
     * 检索状态必须显式三态上报，禁止把失败伪装成命中。
     *
     * 原实现在 RPC 报错或零命中时，回落到「当前租户最近的 5 个分块」，
     * 并把它们编号成 [1]…[5] 交给模型引用 —— 用户看到的是带来源编号的
     * 答案，却与问题毫无关系。这属于本仓库明令禁止的静默 fallback。
     * 现在：失败就是 unavailable，零命中就是 no_match，两者都不注入任何分块。
     */
    type RetrievalStatus = 'matched' | 'no_match' | 'unavailable';
    let retrievalStatus: RetrievalStatus;
    let sources: { title: string }[] = [];
    let contextText = '';

    if (error) {
      retrievalStatus = 'unavailable';
      console.warn('[knowledge/ask] vector retrieval unavailable:', error.message);
    } else if (!chunks || chunks.length === 0) {
      retrievalStatus = 'no_match';
    } else {
      retrievalStatus = 'matched';
      contextText = (chunks as { content: string }[]).map((c, i) => `[${i + 1}] ${c.content}`).join('\n\n');
      const docIds = Array.from(new Set((chunks as { doc_id: string }[]).map((c) => c.doc_id)));
      const docsRes = await scopedTable(ctx, 'knowledge_docs', 'id, title').in('id', docIds);
      sources = ((docsRes.data ?? []) as { title: string }[]).map((d) => ({ title: d.title }));
    }

    const retrievalNotice = retrievalStatus === 'matched'
      ? ''
      : retrievalStatus === 'no_match'
        ? (locale === 'zh'
          ? '\n\n注意：本次检索未命中任何知识库内容。你必须如实告知用户「知识库中暂无相关内容」，并建议补充文档；禁止编造来源编号。'
          : '\n\nNote: retrieval matched nothing in the knowledge base. You MUST tell the user plainly that no relevant content exists and suggest adding a document. Do not invent citation numbers.')
        : (locale === 'zh'
          ? '\n\n注意：本次向量检索服务不可用（技术故障，非「没有内容」）。你必须如实告知用户检索当前不可用，并说明这不是知识库为空；禁止编造来源编号。'
          : '\n\nNote: vector retrieval is UNAVAILABLE (a technical failure, not an empty knowledge base). You MUST tell the user retrieval is currently unavailable and that this does not mean the knowledge base is empty. Do not invent citation numbers.');

    const systemPrompt = locale === 'zh'
      ? `你是商户知识库助手。仅根据下方知识库内容回答问题。
规则：
- 如果知识库中有答案，结构化回答并标注来源编号，如 [1]
- 如果知识库中没有相关信息，明确说明"知识库中暂无相关内容"，并建议补充文档
- 用 Markdown 排版

知识库内容：
${contextText || '（无可用内容）'}${retrievalNotice}`
      : `You are the business knowledge base assistant. Answer ONLY based on the knowledge base content below.
Rules:
- If the answer exists, respond in a structured way and cite sources like [1]
- If not covered, clearly say "No relevant content in the knowledge base yet" and suggest adding a document
- Use Markdown formatting

Knowledge base content:
${contextText || '(no content available)'}${retrievalNotice}`;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: body.question },
    ];

    const response = sseResponse(streamChat('rag', messages, forwardHeaders, { tenantId: ctx.tenantId, businessId: ctx.businessId, userId: ctx.userId }));
    response.headers.set('X-Sources', encodeURIComponent(JSON.stringify(sources)));
    // 检索状态显式上报：前端可据此区分「命中」「没命中」「检索坏了」，而不是
    // 把三种情况都渲染成带来源编号的答案。
    response.headers.set('X-Retrieval-Status', retrievalStatus);
    response.headers.set('Access-Control-Expose-Headers', 'X-Retrieval-Status, X-Sources');
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

export const POST = protectBusinessMutation(
  { permission: 'knowledge:read', action: 'knowledge.ask', entity: 'knowledge_docs' },
  askKnowledge,
);
