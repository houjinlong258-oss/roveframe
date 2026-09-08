import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { errorResponse, getForwardHeaders, json, sseResponse } from '@/lib/api-helpers';
import { invokeChat, type ChatMessage } from '@/lib/ai/router';
import { runAgentTurn, withAgentAudit } from '@/lib/agent';
import { roveAgentChat, roveAgentConfigured, RoveAgentUnavailable } from '@/lib/roveagent/client';
import { getBusinessContext, contextToPrompt } from '@/lib/business-context';
import { getRecentMemories, memoriesToPrompt, addMemory } from '@/lib/memory';
import { skillForIndustry } from '@/lib/skills';
import { getSettings } from '@/lib/settings';
import { getTenantContext, requireBusinessContext } from '@/lib/tenant';
import { insertWithScope, scopedTable, updateWithScope } from '@/lib/tenant-db';
import { ROLE_PERMISSIONS } from '@/lib/rbac';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { getSupabaseClient } from '@/storage/database/supabase-client';

const requestSchema = z.object({
  session_id: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(8_000),
  locale: z.enum(['en', 'zh', 'es']).default('en'),
});

const RECENT_HISTORY_MESSAGES = 20;
const MAX_CONVERSATION_SUMMARY_CHARS = 4_000;

function extendConversationSummary(
  current: string,
  messages: Array<{ role: string; content: string }>,
): string {
  const additions = messages.map((message) => {
    const content = message.content.replace(/\s+/g, ' ').trim().slice(0, 600);
    return `${message.role}: ${content}`;
  }).join('\n');
  return [current.trim(), additions].filter(Boolean).join('\n')
    .slice(-MAX_CONVERSATION_SUMMARY_CHARS);
}

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

async function runChat(request: Request) {
  try {
    const ctx = requireBusinessContext(await getTenantContext(request));
    const parsed = requestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: 'invalid chat request', details: parsed.error.flatten() }, 400);
    const body = parsed.data;
    const locale = body.locale;
    const forwardHeaders = getForwardHeaders(request);

    // 会话：严格绑定 tenant + business + user。
    let sessionId = body.session_id;
    let sessionSummary = '';
    let summarizedMessageCount = 0;
    if (!sessionId) {
      const ins = await insertWithScope(ctx, 'chat_sessions', {
        user_id: ctx.userId,
        title: body.message.slice(0, 40),
      })
        .select('id, summary, summarized_message_count')
        .single();
      if (ins.error) throw new Error(ins.error.message);
      const created = ins.data as {
        id: string;
        summary: string;
        summarized_message_count: number;
      };
      sessionId = created.id;
      sessionSummary = created.summary;
      summarizedMessageCount = created.summarized_message_count;
    } else {
      const ownedSession = await scopedTable(
        ctx,
        'chat_sessions',
        'id, summary, summarized_message_count',
      )
        .eq('id', sessionId)
        .eq('user_id', ctx.userId)
        .maybeSingle();
      if (ownedSession.error) throw new Error(ownedSession.error.message);
      if (!ownedSession.data) return json({ error: 'chat session not found' }, 404);
      const state = ownedSession.data as {
        summary: string | null;
        summarized_message_count: number | null;
      };
      sessionSummary = state.summary ?? '';
      summarizedMessageCount = state.summarized_message_count ?? 0;
    }
    const activeSessionId = sessionId;
    const requestId = randomUUID();
    const taskId = randomUUID();

    const client = getSupabaseClient();
    const countResult = await client
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', ctx.tenantId)
      .eq('business_id', ctx.businessId)
      .eq('user_id', ctx.userId)
      .eq('session_id', activeSessionId);
    if (countResult.error) throw new Error(countResult.error.message);
    const totalMessageCount = countResult.count ?? 0;
    const targetSummarizedCount = Math.max(0, totalMessageCount - RECENT_HISTORY_MESSAGES);
    if (targetSummarizedCount > summarizedMessageCount) {
      const olderRes = await scopedTable(ctx, 'chat_messages', 'role, content')
        .eq('user_id', ctx.userId)
        .eq('session_id', activeSessionId)
        .order('created_at', { ascending: true })
        .range(summarizedMessageCount, targetSummarizedCount - 1);
      if (olderRes.error) throw new Error(olderRes.error.message);
      sessionSummary = extendConversationSummary(
        sessionSummary,
        (olderRes.data ?? []) as { role: string; content: string }[],
      );
      const summaryUpdate = await updateWithScope(ctx, 'chat_sessions', activeSessionId, {
        summary: sessionSummary,
        summarized_message_count: targetSummarizedCount,
      }).eq('user_id', ctx.userId);
      if (summaryUpdate.error) throw new Error(summaryUpdate.error.message);
    }

    // Only recent turns are injected; older turns are represented by summary.
    const histRes = await scopedTable(ctx, 'chat_messages', 'role, content')
      .eq('user_id', ctx.userId)
      .eq('session_id', activeSessionId)
      .order('created_at', { ascending: false })
      .limit(RECENT_HISTORY_MESSAGES);
    if (histRes.error) throw new Error(histRes.error.message);
    const history = ([...(histRes.data ?? [])] as { role: string; content: string }[]).reverse();

    // 保存用户消息
    const insUser = await insertWithScope(ctx, 'chat_messages', {
      user_id: ctx.userId,
      session_id: activeSessionId,
      role: 'user',
      content: body.message,
    });
    if (insUser.error) throw new Error(insUser.error.message);

    // 组装 prompt：系统 + 行业能力 + 实时经营上下文 + 企业长期记忆 + 历史 + 当前问题
    const bizCtx = await getBusinessContext(ctx.tenantId, ctx.businessId);
    const settings = await getSettings(ctx.tenantId, ctx.businessId);
    const industry = bizCtx.industry;
    const memories = await getRecentMemories(ctx.tenantId, ctx.businessId, 5);
    const systemContent = [
      locale === 'zh' ? SYSTEM_ZH : SYSTEM_EN,
      skillForIndustry(industry),
      contextToPrompt(bizCtx, locale),
      memoriesToPrompt(memories, locale),
      sessionSummary
        ? `${locale === 'zh' ? '较早会话摘要' : 'Earlier conversation summary'}:\n${sessionSummary}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: systemContent },
      ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: body.message },
    ];

    const localeSettings = (settings.locale ?? {}) as Record<string, unknown>;
    let stream: AsyncGenerator<string>;
    let usedRoveAgent = false;
    if (roveAgentConfigured()) {
      // RoveAgent Gateway 优先（蓝图 Phase 2：所有 AI 请求经 RoveAgent Core）
      try {
        const result = await roveAgentChat({
          tenantId: ctx.tenantId,
          businessId: ctx.businessId,
          userId: ctx.userId,
          message: body.message,
          agent: 'ceo',
          role: ctx.role,
          permissions: ROLE_PERMISSIONS[ctx.role],
          requestId,
          taskId,
          // 与 TS 侧 chat_sessions 同一 session id → 多轮上下文跨调用持久
          sessionId: activeSessionId,
          industry,
          businessContext: contextToPrompt(bizCtx, locale),
        });
        usedRoveAgent = true;
        const reply = result.reply;
        stream = (async function* () { yield reply; })();
      } catch (error) {
        if (error instanceof RoveAgentUnavailable) {
          console.warn('[agent/chat] roveagent unavailable, fallback to TS agent path:', error.message);
        } else {
          throw error;
        }
      }
    }
    if (!usedRoveAgent) {
      stream = await runAgentTurn({
          messages,
          userMessage: body.message,
          forwardHeaders,
          signal: request.signal,
          context: withAgentAudit({
            tenantId: ctx.tenantId,
            businessId: ctx.businessId,
            userId: ctx.userId,
            role: ctx.role,
            sessionId: activeSessionId,
            turnId: taskId,
            locale,
            timeZone: typeof localeSettings.timezone === 'string'
              ? localeSettings.timezone
              : 'America/New_York',
          }),
        });
    }

    // 包装流：结束后落库 assistant 消息并刷新会话时间（tenant 化）
    const tenantId = ctx.tenantId;
    const scopedContext = ctx;
    async function* wrapped(): AsyncGenerator<string> {
      let full = '';
      for await (const chunk of stream) {
        full += chunk;
        yield chunk;
      }
      const ins = await insertWithScope(scopedContext, 'chat_messages', {
        user_id: ctx.userId,
        session_id: activeSessionId,
        role: 'assistant',
        content: full,
      });
      if (ins.error) throw new Error(ins.error.message);
      const upd = await updateWithScope(scopedContext, 'chat_sessions', activeSessionId, {
        updated_at: new Date().toISOString(),
      }).eq('user_id', ctx.userId);
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
            { tenantId, businessId: ctx.businessId, userId: ctx.userId },
            { agent: 'agent:memory-extract' },
          );
          if (memory && memory.trim()) await addMemory(tenantId, ctx.businessId, memory.trim());
        } catch {
          // 记忆沉淀失败不影响主流程
        }
      }
    }

    const response = sseResponse(wrapped());
    response.headers.set('X-Session-Id', activeSessionId);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

export const POST = protectBusinessMutation(
  { permission: 'agent:use', action: 'agent.chat', entity: 'chat_sessions' },
  runChat,
);
