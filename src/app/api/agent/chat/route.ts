import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getForwardHeaders, jsonError, getErrorMessage, sseResponse } from '@/lib/api-helpers';
import { streamChat, type ChatMessage } from '@/lib/ai/router';
import { getBusinessContext, contextToPrompt } from '@/lib/business-context';

const SYSTEM_ZH = `你是 RoveFrame AI COO —— 中小企业的 AI 首席运营官。你基于商户的真实经营数据提供分析和可执行建议。
要求：
- 回答专业、结构化，用 Markdown 排版（标题、加粗、列表）
- 给出具体数字和可执行步骤，不说空话
- 建议按优先级排列
- 如果涉及金额，使用美元（$）`;

const SYSTEM_EN = `You are RoveFrame AI COO — an AI Chief Operating Officer for SMBs. You analyze real business data and give actionable advice.
Requirements:
- Professional, structured answers in Markdown (headings, bold, lists)
- Concrete numbers and executable steps, no fluff
- Order suggestions by priority
- Use USD ($) for amounts`;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { session_id?: string; message: string; locale?: string };
    if (!body.message?.trim()) return jsonError('empty message', 400);
    const locale = body.locale ?? 'en';
    const client = getSupabaseClient();
    const forwardHeaders = getForwardHeaders(request);

    // 会话：不存在则创建
    let sessionId = body.session_id;
    if (!sessionId) {
      const { data, error } = await client
        .from('chat_sessions')
        .insert({ title: body.message.slice(0, 40) })
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      sessionId = data.id;
    }

    // 历史消息
    const { data: history, error: hErr } = await client
      .from('chat_messages')
      .select('role, content')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(20);
    if (hErr) throw new Error(hErr.message);

    // 保存用户消息
    const { error: uErr } = await client.from('chat_messages').insert({
      session_id: sessionId,
      role: 'user',
      content: body.message,
    });
    if (uErr) throw new Error(uErr.message);

    // 组装 prompt：系统 + 实时经营上下文 + 历史 + 当前问题
    const ctx = await getBusinessContext();
    const messages: ChatMessage[] = [
      { role: 'system', content: `${locale === 'zh' ? SYSTEM_ZH : SYSTEM_EN}\n\n${contextToPrompt(ctx, locale)}` },
      ...(history ?? []).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: body.message },
    ];

    const stream = streamChat('agent', messages, forwardHeaders);

    // 包装流：结束后落库 assistant 消息并刷新会话标题/时间
    async function* wrapped(): AsyncGenerator<string> {
      let full = '';
      for await (const chunk of stream) {
        full += chunk;
        yield chunk;
      }
      const db = getSupabaseClient();
      await db.from('chat_messages').insert({ session_id: sessionId, role: 'assistant', content: full });
      await db.from('chat_sessions').update({ updated_at: new Date().toISOString() }).eq('id', sessionId);
    }

    const response = sseResponse(wrapped());
    response.headers.set('X-Session-Id', sessionId!);
    return response;
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}
