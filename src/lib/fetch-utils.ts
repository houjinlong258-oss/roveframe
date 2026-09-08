/**
 * P0-7：统一保存类请求封装 —— 失败必须显式抛错，禁止调用方静默忽略
 * HTTP 错误后继续弹「已保存」。
 */

export class SaveError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'SaveError';
    this.status = status;
  }
}

async function errorMessageFromResponse(response: Response, fallback: string): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return fallback;
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
      if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
    } catch {
      // 非 JSON 响应体：截断后作为错误信息
      return text.slice(0, 200) || fallback;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

export interface SaveJsonOptions {
  method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * 保存类请求：非 2xx 抛 SaveError（携带服务端错误文案），网络失败抛 SaveError。
 * 成功返回解析后的 JSON（空响应体返回 null）。
 */
export async function saveJson(url: string, options: SaveJsonOptions = {}): Promise<unknown> {
  const method = options.method ?? 'POST';
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new SaveError(
      error instanceof Error ? error.message : 'network request failed',
      0,
    );
  }

  if (!response.ok) {
    const message = await errorMessageFromResponse(response, `request failed (${response.status})`);
    throw new SaveError(message, response.status);
  }

  const text = await response.text();
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
