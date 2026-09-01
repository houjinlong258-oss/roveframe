import { HeaderUtils } from 'coze-coding-dev-sdk';

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
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: getErrorMessage(error) })}\n\n`)
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
