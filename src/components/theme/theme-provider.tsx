'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'roveframe-theme';
const DAY_START = 6; // 06:00
const DAY_END = 18; // 18:00

type ThemeContextValue = {
  /** 用户选择的模式：手动 light/dark 优先于 system 自动 */
  mode: ThemeMode;
  /** 实际生效的主题 */
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'system',
  resolved: 'light',
  setMode: () => {},
});

/**
 * System 模式按浏览器本地时区判定：
 * 06:00–18:00 → Day（Light）；18:00–06:00 → Night（Dark）。
 * 手动选择优先于自动模式，偏好持久化在 localStorage。
 */
export function resolveSystemTheme(date: Date = new Date()): ResolvedTheme {
  const hour = date.getHours();
  return hour >= DAY_START && hour < DAY_END ? 'light' : 'dark';
}

function readStoredMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(resolved: ResolvedTheme, animate: boolean) {
  // 顾客端 H5 点餐商城（/store）保持品牌固定样式，不随主题切换
  if (typeof window !== 'undefined' && /\/store(\/|$)/.test(window.location.pathname)) return;
  const root = document.documentElement;
  if (animate) {
    root.classList.add('theme-anim');
    window.setTimeout(() => root.classList.remove('theme-anim'), 520);
  }
  root.classList.toggle('dark', resolved === 'dark');
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [resolved, setResolved] = useState<ResolvedTheme>('light');
  const mountedRef = useRef(false);

  // 挂载后读取手动偏好（无偏好回落 System 自动）
  useEffect(() => {
    const stored = readStoredMode();
    const next = stored === 'system' ? resolveSystemTheme() : stored;
    setModeState(stored);
    setResolved(next);
    applyTheme(next, false);
    mountedRef.current = true;
  }, []);

  // System 模式：跨昼/夜边界时自动切换（每分钟校准一次本地时间）
  useEffect(() => {
    if (mode !== 'system') return;
    const timer = window.setInterval(() => {
      const next = resolveSystemTheme();
      setResolved((prev) => {
        if (prev !== next) {
          applyTheme(next, true);
          return next;
        }
        return prev;
      });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 隐私模式等场景下 localStorage 不可用，静默降级为会话内偏好
    }
    const applied = next === 'system' ? resolveSystemTheme() : next;
    setResolved(applied);
    applyTheme(applied, mountedRef.current);
  }, []);

  return (
    <ThemeContext.Provider value={{ mode, resolved, setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
