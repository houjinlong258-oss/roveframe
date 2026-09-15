'use client';

import { useRef, useState, useCallback } from 'react';
import type { AgentSseEvent } from '@/lib/agent/stream-events';

type StreamOptions = {
  url: string;
  body: Record<string, unknown>;
  /** 每个有类型的事件都会回调一次（status / provider / delta / artifact / notice / error / done） */
  onEvent?: (event: AgentSseEvent) => void;
  /** 兼容回调：只关心文本增量时使用 */
  onChunk?: (text: string) => void;
  onDone?: (headers: Headers) => void;
  onError?: (message: string) => void;
};

/**
 * 已知事件类型白名单。
 *
 * 修复（Step 2）：原白名单缺 `approval` 与 `runtime_status`，
 * 而 `AgentSseEvent` 已定义两者、页面也已有 `approval` 分支（page.tsx:402）——
 * 结果是服务端推的审批卡片与 Runtime 状态被**静默丢弃**。这里补齐。
 *
 * 注意：新增事件类型时必须同步这里，否则 `:96` 的 `continue` 会把它吃掉。
 *
 * 导出供契约测试使用（`tests/roveagent-stream-contract.test.ts` 会把它与
 * Python 侧 `roveagent/api/stream_wire.py` 的事件名逐一比对，防止两侧漂移）。
 */
export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'status',
  'provider',
  'delta',
  'artifact',
  'notice',
  'error',
  'done',
  'approval',
  'runtime_status',
]);

/**
 * 空闲超时：与 Runtime 侧流超时（600s）对齐。
 * 没有它时，一个卡住的流会让 `for(;;) await reader.read()` 永久挂起，
 * 页面停留在「Thinking…」且没有任何恢复路径。
 */
const STREAM_IDLE_TIMEOUT_MS = 600_000;

/**
 * 消费 Agent SSE 流的通用 hook（Agent Workspace 2.0 协议）。
 *
 * 向后兼容：旧的 `data: {text}` 行仍会被当成 delta 事件派发。
 * 未知事件类型直接忽略 —— 服务端加字段不应该把前端打崩。
 */
export function useSSE() {
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const start = useCallback(
    async ({ url, body, onEvent, onChunk, onDone, onError }: StreamOptions) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming(true);

      let timedOut = false;
      const idleTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, STREAM_IDLE_TIMEOUT_MS);

      // 错误事件不再中断读取：见下方 error 分支的注释。
      let streamError: string | null = null;
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) {
          const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
          throw new Error(err.error ?? `HTTP ${resp.status}`);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') continue;
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(payload) as Record<string, unknown>;
            } catch {
              continue; // 忽略不完整的 SSE 片段
            }
            // 旧格式 / 新格式统一：带 error 字段即为错误事件
            const errorText = typeof parsed.error === 'string' ? parsed.error : null;
            if (errorText) {
              // 上报但**继续消费**。
              // 服务端在 error 之后仍会推送 artifact 与 done（chat/route.ts 的
              // runtime_stream_failed 分支就是「先报错、再继续交付已生成的产物」）。
              // 原实现直接 throw 退出读循环，后果有二：
              //   ① 已成功生成的文件被静默丢弃；
              //   ② onDone 不执行 → X-Session-Id 永不采纳 → 每次失败的首轮都泄漏一个会话。
              streamError = errorText;
              onEvent?.({ ...(parsed as unknown as AgentSseEvent), type: 'error', error: errorText });
              continue;
            }
            const hasType = typeof parsed.type === 'string';
            const type = hasType ? (parsed.type as string) : 'delta';
            if (!KNOWN_EVENT_TYPES.has(type)) continue;
            const event = (hasType
              ? parsed
              : { type: 'delta', text: typeof parsed.text === 'string' ? parsed.text : '' }
            ) as unknown as AgentSseEvent;
            onEvent?.(event);
            if (event.type === 'delta' && event.text) onChunk?.(event.text);
          }
        }
        // onDone 先于 onError：即便本轮出过错，也必须让调用方拿到响应头
        // （X-Session-Id / X-Retrieval-Status），否则后续消息会另开会话。
        onDone?.(resp.headers);
        if (streamError) onError?.(streamError);
      } catch (error) {
        if (timedOut) {
          onError?.(`stream idle timeout after ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s`);
        } else if ((error as Error).name !== 'AbortError') {
          onError?.(error instanceof Error ? error.message : String(error));
        }
      } finally {
        clearTimeout(idleTimer);
        setStreaming(false);
      }
    },
    [],
  );

  return { streaming, start, stop };
}
