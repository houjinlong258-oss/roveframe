import { HeaderUtils } from 'coze-coding-dev-sdk';
import { isAIError } from '@/lib/ai/errors';

export function getForwardHeaders(request: Request): Record<string, string> {
  return HeaderUtils.extractForwardHeaders(request.headers as unknown as Headers);
}

export function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

export function jsonError(message: string, status = 500) {
  return Response.json({ error: message }, { status });
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Preserve explicit authorization failures instead of returning an indistinguishable 500. */
export function errorResponse(error: unknown, fallbackStatus = 500): Response {
  const maybeStatus = error instanceof Error && 'status' in error ? error.status : null;
  const status = typeof maybeStatus === 'number' && maybeStatus >= 400 && maybeStatus < 600
    ? maybeStatus
    : fallbackStatus;
  return jsonError(getErrorMessage(error), status);
}

/** 将 AsyncGenerator 文本流包装为 SSE Response（data: {text} 行格式） */
export function sseResponse(stream: AsyncGenerator<string, void, unknown>): Response {
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: chunk })}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (error) {
        // AIError 输出 machine-readable 事件（provider/model/code/requestId），
        // 前端可据此显示真实失败原因而不是“请求完成”。
        const payload = isAIError(error)
          ? { ...error.toEvent(), error: error.message }
          : { error: getErrorMessage(error) };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
        );
      } finally {
        controller.close();
      }
    },
  });
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
