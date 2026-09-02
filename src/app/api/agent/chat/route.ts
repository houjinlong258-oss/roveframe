import { getForwardHeaders, jsonError, getErrorMessage, sseResponse } from '@/lib/api-helpers';
import { streamChat, invokeChat, type ChatMessage } from '@/lib/ai/router';
import { getBusinessContext, contextToPrompt } from '@/lib/business-context';
import { getRecentMemories, memoriesToPrompt, addMemory } from '@/lib/memory';
import { skillForIndustry } from '@/lib/skills';
import { getSettings } from '@/lib/settings';
import { getTenantContext } from '@/lib/tenant';
import { insertWithTenant, tenantTable, updateWithTenant } from '@/lib/tenant-db';

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
    const ctx = getTenantContext(request);
    const body = (await request.json()) as { session_id?: string; message: string; locale?: string };
    if (!body.message?.trim()) return jsonError('empty message', 400);
    const locale = body.locale ?? 'en';
    const forwardHeaders = getForwardHeaders(request);

    // 会话：不存在则创建（tenant 内）
    let sessionId = body.session_id;
    if (!sessionId) {
      const ins = await insertWithTenant(ctx.tenantId, 'chat_sessions', {
        title: body.message.slice(0, 40),
      })
        .select('id')
        .single();
      if (ins.error) throw new Error(ins.error.message);
      sessionId = (ins.data as { id: string }).id;
    }

    // 历史消息（tenant 内）
    const histRes = await tenantTable(ctx.tenantId, 'chat_messages', 'role, content')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(20);
    if (histRes.error) throw new Error(histRes.error.message);
    const history = (histRes.data ?? []) as { role: string; content: string }[];

    // 保存用户消息
    const insUser = await insertWithTenant(ctx.tenantId, 'chat_messages', {
      session_id: sessionId,
      role: 'user',
      content: body.message,
    });
    if (insUser.error) throw new Error(insUser.error.message);

    // 组装 prompt：系统 + 行业能力 + 实时经营上下文 + 企业长期记忆 + 历史 + 当前问题
    const bizCtx = await getBusinessContext();
    const settings = await getSettings();
    const industry = (settings.business?.industry as string) || 'restaurant';
    const memories = await getRecentMemories(5);
    const systemContent = [
      locale === 'zh' ? SYSTEM_ZH : SYSTEM_EN,
      skillForIndustry(industry),
      contextToPrompt(bizCtx, locale),
      memoriesToPrompt(memories, locale),
    ]
      .filter(Boolean)
      .join('\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: systemContent },
      ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: body.message },
    ];

    const stream = streamChat('agent', messages, forwardHeaders);

    // 包装流：结束后落库 assistant 消息并刷新会话时间（tenant 化）
    const tenantId = ctx.tenantId;
    async function* wrapped(): AsyncGenerator<string> {
      let full = '';
      for await (const chunk of stream) {
        full += chunk;
        yield chunk;
      }
      const ins = await insertWithTenant(tenantId, 'chat_messages', {
        session_id: sessionId,
        role: 'assistant',
        content: full,
      });
      if (ins.error) throw new Error(ins.error.message);
      const upd = await updateWithTenant(tenantId, 'chat_sessions', sessionId!, {
        updated_at: new Date().toISOString(),
      });
      if (upd.error) throw new Error(upd.error.message);

      // 沉淀企业长期记忆（tenant 化，失败不影响主流程）
      if (body.message.trim().length > 15) {
        try {
          const memory = await invokeChat(
            'light',
            [
              {
                role: 'system',
                content:
                  locale === 'zh'
                    ? '你是经营助手。从下面老板与 AI 的对话中，若存在值得长期记住的「企业事实/经验」（如活动 ROI、客户偏好、经营结论），用一句话提炼并输出；若无，输出空字符串。'
                    : 'You are a business assistant. Extract one memorable business fact/insight (e.g. campaign ROI, customer preference, operating conclusion) from the exchange below, in one sentence. Output an empty string if nothing is worth remembering.',
              },
              { role: 'user', content: `老板: ${body.message}\nAI: ${full.slice(0, 1500)}` },
            ],
            forwardHeaders,
          );
          if (memory && memory.trim()) await addMemory(memory.trim());
        } catch {
          // 记忆沉淀失败不影响主流程
        }
      }
    }

    const response = sseResponse(wrapped());
    response.headers.set('X-Session-Id', sessionId!);
    return response;
  } catch (error) {
    return jsonError(getErrorMessage(error));
  }
}
