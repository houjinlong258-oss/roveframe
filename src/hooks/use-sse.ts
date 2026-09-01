'use client';

import { useRef, useState, useCallback } from 'react';

type StreamOptions = {
  url: string;
  body: Record<string, unknown>;
  onChunk: (text: string) => void;
  onDone?: (headers: Headers) => void;
  onError?: (message: string) => void;
};

/** 消费 data: {text} 行格式 SSE 流的通用 hook，支持中断 */
export function useSSE() {
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const start = useCallback(async ({ url, body, onChunk, onDone, onError }: StreamOptions) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
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
          try {
            const parsed = JSON.parse(payload) as { text?: string; error?: string };
            if (parsed.error) throw new Error(parsed.error);
            if (parsed.text) onChunk(parsed.text);
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }
      onDone?.(resp.headers);
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        onError?.(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setStreaming(false);
    }
  }, []);

  return { streaming, start, stop };
}
