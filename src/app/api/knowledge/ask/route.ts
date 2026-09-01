import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getForwardHeaders, jsonError, getErrorMessage, sseResponse } from '@/lib/api-helpers';
import { streamChat, type ChatMessage } from '@/lib/ai/router';
import { embedText } from '@/lib/embedding';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { question: string; locale?: string };
    if (!body.question?.trim()) return jsonError('empty question', 400);
    const locale = body.locale ?? 'en';
    const forwardHeaders = getForwardHeaders(request);
    const client = getSupabaseClient();

    // 1. 问题向量化
    const queryEmbedding = await embedText(body.question, forwardHeaders);

    // 2. 向量检索最相关的分块（余弦相似度）
    const { data: chunks, error } = await client.rpc('match_doc_chunks', {
      query_embedding: JSON.stringify(queryEmbedding),
      match_count: 5,
    });

    let sources: { title: string }[] = [];
    let contextText = '';
    if (!error && chunks && chunks.length > 0) {
      contextText = chunks.map((c: { content: string }, i: number) => `[${i + 1}] ${c.content}`).join('\n\n');
      const docIds = [...new Set(chunks.map((c: { doc_id: string }) => c.doc_id))] as string[];
      const { data: docs } = await client.from('knowledge_docs').select('id, title').in('id', docIds);
      sources = (docs ?? []).map((d) => ({ title: d.title }));
    } else {
      // RPC 不存在时退回简单全量匹配（取最近文档的前几个分块）
      const { data: fallback } = await client
        .from('doc_chunks')
        .select('doc_id, content')
        .order('chunk_index', { ascending: true })
        .limit(5);
      contextText = (fallback ?? []).map((c, i) => `[${i + 1}] ${c.content}`).join('\n\n');
      const docIds = [...new Set((fallback ?? []).map((c) => c.doc_id))];
      if (docIds.length > 0) {
        const { data: docs } = await client.from('knowledge_docs').select('id, title').in('id', docIds);
        sources = (docs ?? []).map((d) => ({ title: d.title }));
      }
    }

    const systemPrompt = locale === 'zh'
      ? `你是商户知识库助手。仅根据下方知识库内容回答问题。
规则：
- 如果知识库中有答案，结构化回答并标注来源编号，如 [1]
- 如果知识库中没有相关信息，明确说明"知识库中暂无相关内容"，并建议补充文档
- 用 Markdown 排版

知识库内容：
${contextText || '（知识库为空）'}`
      : `You are the business knowledge base assistant. Answer ONLY based on the knowledge base content below.
Rules:
- If the answer exists, respond in a structured way and cite sources like [1]
- If not covered, clearly say "No relevant content in the knowledge base yet" and suggest adding a document
- Use Markdown formatting

Knowledge base content:
${contextText || '(knowledge base is empty)'}`;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: body.question },
    ];

    const response = sseResponse(streamChat('rag', messages, forwardHeaders));
    response.headers.set('X-Sources', encodeURIComponent(JSON.stringify(sources)));
    return response;
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}
