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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function safeFetchJson<T = any>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) {
      redirectToLoginOn401(res.status);
      return null;
    }
    const text = await res.text();
    if (!text || !text.trim()) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
