import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 401 时跳转登录页（仅浏览器端；/auth 与 /store 页面除外） */
export function redirectToLoginOn401(status: number): void {
  if (status !== 401 || typeof window === 'undefined') return;
  const path = window.location.pathname;
  if (/\/auth(\/|$)/.test(path) || /\/store(\/|$)/.test(path)) return;
  const localeMatch = /^\/(en|zh|es)(\/|$)/.exec(path);
  const locale = localeMatch?.[1] ?? 'en';
  const next = encodeURIComponent(path + window.location.search);
  window.location.href = `/${locale}/auth/login?next=${next}`;
}

/**
 * 判断这次失败是否属于"预期内的拒绝"（只留 debug 日志，不打 error）。
 *
 * ## 为什么（Phase 18 浏览器实测发现）
 *
 * 未登录访问受保护页面时，页面里的 `safeFetchJson` 会先拿到 401、打一条
 * `console.error`，然后才跳登录页。实测 `/en/customers`、`/en/marketing`、
 * `/en/reviews` 三个页面因此各留下 1 条 error，而**功能完全正常**（守卫确实
 * 把用户送到了登录页）。
 *
 * 危害不是"日志难看"，是**真实的 error 信号被稀释**：
 * 一个每次未登录访问都会出现的 error，会让人对 console error 脱敏，
 * 于是真正的失败（接口 500、hydration 崩）也被当成"老样子"。
 * 浏览器端验证脚本的判定也建立在这个信号上，不修它就只能靠人眼看。
 *
 * 401 仍然**留痕**（debug 级），因为"这个页面为什么没拿到数据"依然需要可追溯。
 */
function isExpectedDenial(status: number): boolean {
  return status === 401;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function safeFetchJson<T = any>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) {
      const label = `[safeFetchJson] ${init?.method ?? 'GET'} ${url} → ${res.status}`;
      if (isExpectedDenial(res.status)) {
        // 预期内的拒绝：会话不存在（或已过期）。跳转由下面负责，日志降级为 debug。
        console.debug(`${label}（未认证，跳转登录页）`);
      } else {
        // P0-7：真正的失败至少留痕，避免调用方「骨架屏永转/空态假死」时无任何诊断
        console.error(label);
      }
      redirectToLoginOn401(res.status);
      return null;
    }
    const text = await res.text();
    if (!text || !text.trim()) return null;
    return JSON.parse(text) as T;
  } catch (error) {
    console.error(`[safeFetchJson] ${init?.method ?? 'GET'} ${url} failed:`, error);
    return null;
  }
}
