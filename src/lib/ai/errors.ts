/**
 * 结构化 AI 错误：每一次外部模型调用失败都必须能回答
 * provider / model / 错误类别 / request id / 是否可重试，
 * 并且 message 中绝不包含 API Key 或第三方秘密。
 */

export type AIErrorCode =
  | 'no_provider' // 没有任何可用配置
  | 'invalid_config' // 配置存在但不可用（缺 key、base URL 非法）
  | 'ssrf_blocked' // 自定义 base URL 未通过 SSRF 校验
  | 'provider_timeout'
  | 'provider_rate_limited' // 429
  | 'provider_unavailable' // 5xx / 网络错误
  | 'provider_error' // 4xx 或 provider 返回的业务错误
  | 'stream_error'; // SSE 中途失败或 provider error event

export interface AIErrorDetails {
  code: AIErrorCode;
  provider?: string;
  model?: string;
  status?: number;
  requestId: string;
  retryable: boolean;
}

/** 脱敏：移除疑似密钥/令牌，截断长度 */
export function sanitizeProviderMessage(raw: string, max = 300): string {
  let text = raw;
  // 常见密钥形态：sk-xxx / Bearer xxx / xox / AIza / 长 base64/hex
  text = text.replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-****');
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer ****');
  text = text.replace(/AIza[A-Za-z0-9_-]{10,}/g, 'AIza****');
  text = text.replace(/xox[baprs]-[A-Za-z0-9-]{6,}/g, 'xox****');
  text = text.replace(/[A-Fa-f0-9]{32,}/g, (m) => `${m.slice(0, 4)}****`);
  if (text.length > max) text = `${text.slice(0, max)}…`;
  return text;
}

export class AIError extends Error {
  readonly code: AIErrorCode;
  readonly provider?: string;
  readonly model?: string;
  readonly status?: number;
  readonly requestId: string;
  readonly retryable: boolean;

  constructor(details: AIErrorDetails, message: string) {
    super(sanitizeProviderMessage(message));
    this.name = 'AIError';
    this.code = details.code;
    this.provider = details.provider;
    this.model = details.model;
    this.status = details.status;
    this.requestId = details.requestId;
    this.retryable = details.retryable;
  }

  /** 序列化为 machine-readable 事件（SSE / API 响应用） */
  toEvent() {
    return {
      type: 'ai_error' as const,
      code: this.code,
      provider: this.provider ?? null,
      model: this.model ?? null,
      status: this.status ?? null,
      requestId: this.requestId,
      retryable: this.retryable,
      message: this.message,
    };
  }
}

export function classifyHTTPError(status: number): { code: AIErrorCode; retryable: boolean } {
  if (status === 429) return { code: 'provider_rate_limited', retryable: true };
  if (status >= 500) return { code: 'provider_unavailable', retryable: true };
  if (status === 408) return { code: 'provider_timeout', retryable: true };
  return { code: 'provider_error', retryable: false };
}

export function isAIError(err: unknown): err is AIError {
  return err instanceof AIError;
}
