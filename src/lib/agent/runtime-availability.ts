/**
 * Runtime 状态体验收尾（Step 3.1）—— 纯逻辑层。
 *
 * 为什么单独一个模块：本文件**不 import 任何东西**，
 * 因此既能被客户端组件使用，也能被单元测试直接导入。
 *
 * 与之相对，`@/lib/roveagent/client.ts` 通过 `signature.ts` 依赖
 * `node:crypto`，**不能**被 `'use client'` 组件引入 —— 这也是「重新连接」
 * 必须走一条 Next.js API 路由而不是在浏览器里直接打 Runtime 的原因。
 */

export type RuntimeMode = 'roveagent' | 'fallback' | 'unavailable';

/** 状态条的种类。`none` = 什么都不显示。 */
export type RuntimeBannerKind = 'none' | 'warning' | 'error';

export interface RuntimeStatusLike {
  mode: RuntimeMode;
  detail?: string;
}

/**
 * 任务 2：把 runtime 模式映射为展示种类。
 *
 * 规则（严格按验收标准）：
 * - `roveagent`   → **隐藏**（正常路径不该有视觉噪音）
 * - `fallback`    → 警告
 * - `unavailable` → 错误
 */
export function bannerKindFor(mode: RuntimeMode | undefined | null): RuntimeBannerKind {
  if (!mode || mode === 'roveagent') return 'none';
  if (mode === 'fallback') return 'warning';
  return 'error';
}

/** 是否需要展示状态条。 */
export function shouldShowBanner(mode: RuntimeMode | undefined | null): boolean {
  return bannerKindFor(mode) !== 'none';
}

/** 仅 `unavailable` 才提供「重新连接 / 基础模式」恢复入口。 */
export function isRecoverable(mode: RuntimeMode | undefined | null): boolean {
  return mode === 'unavailable';
}

/* -------------------------------------------------------------------------- */
/* 任务 1：基础模式（chat-only）                                                */
/* -------------------------------------------------------------------------- */

export type RequestClass = 'chat' | 'tool_execution';

/**
 * 基础模式能否发送这条消息。
 *
 * 「基础模式」= 只走普通聊天。用户已确认接受降级，因此 **chat 允许发送**；
 * 但 `tool_execution` 必须继续被拒绝 —— 这是硬约束：
 * 基础模式**禁止**任何工具执行的后备方案（TS 兜底路径没有文件/终端工具，
 * 放行等于假装做过）。
 *
 * 注意：这是**客户端预检**，用于即时反馈；真正的权威判定在服务端
 * `/api/agent/chat` 的分类逻辑。两道防线是「与」关系。
 */
export function canSendInBasicMode(requestClass: RequestClass): boolean {
  return requestClass === 'chat';
}

/* -------------------------------------------------------------------------- */
/* 任务 1：重新连接（/api/health 结果）                                          */
/* -------------------------------------------------------------------------- */

/** Next.js 代理路由返回的形状（不含任何凭据）。 */
export interface RuntimeHealthReport {
  /** Runtime 当前是否可达（HTTP 200） */
  ok: boolean;
  /**
   * 展示用的 Runtime 模式：
   * - `ok: true` → `roveagent`（恢复）
   * - `ok: false` → `unavailable`（保持错误）
   */
  mode: RuntimeMode;
  /** 人类可读原因（未配置 / 401 / 超时 / 5xx） */
  detail: string;
  /** 探测耗时（毫秒）；未探测时为 null */
  latencyMs: number | null;
}

/** 健康探测成功 → 恢复为正常模式。 */
export function runtimeModeAfterProbe(ok: boolean): RuntimeMode {
  return ok ? 'roveagent' : 'unavailable';
}

/** 探测失败时的原因文案（保留既有 detail，避免把原因丢掉）。 */
export function detailAfterProbe(
  report: Pick<RuntimeHealthReport, 'ok' | 'detail'>,
  previousDetail?: string,
): string {
  if (report.ok) return '';
  return report.detail || previousDetail || 'runtime unreachable';
}

/**
 * 应用一次重新连接的结果（reducer，纯函数便于测试）。
 *
 * 契约（严格按验收标准）：
 * - 成功 → `mode` 变为 `roveagent`（恢复）
 * - 失败 → **保持错误**（`mode` 仍为 `unavailable`，原因保留）
 */
export function applyProbeResult(
  current: RuntimeStatusLike,
  report: Pick<RuntimeHealthReport, 'ok' | 'detail'>,
): RuntimeStatusLike {
  if (report.ok) {
    return { mode: 'roveagent', detail: '' };
  }
  return {
    mode: 'unavailable',
    detail: detailAfterProbe(report, current.detail),
  };
}

/* -------------------------------------------------------------------------- */
/* 任务 2：整体展示决策                                                          */
/* -------------------------------------------------------------------------- */

export interface RuntimePresentation {
  kind: RuntimeBannerKind;
  /** 是否展示（= kind !== 'none'） */
  visible: boolean;
  /** 是否提供恢复按钮组 */
  recoverable: boolean;
  /** 原因（去空白；可能为空串） */
  detail: string;
}

/**
 * 一次算清「这条消息要不要显示 Runtime 状态条、显示成什么」。
 * 组件保持哑（thin），逻辑全在这里，便于单测覆盖 4 项验收。
 */
export function presentRuntime(status: RuntimeStatusLike | undefined | null): RuntimePresentation {
  const mode = status?.mode;
  const kind = bannerKindFor(mode);
  return {
    kind,
    visible: kind !== 'none',
    recoverable: isRecoverable(mode),
    detail: (status?.detail ?? '').trim(),
  };
}
