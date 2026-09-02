'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * 客户端 session hook（P0-S2 完整版：Part G）
 *
 * 存储: localStorage('roveframe:session')
 * 内容: { accessToken, userId, tenantId, businessId, role, email, name }
 *
 * 范围: 仅做 session 状态管理 + 调 /api/auth/{login,signup} 拿 token
 * 路由守卫 / 强制登录跳转 留到 P0-S3 RBAC 做。
 */

export interface Session {
  accessToken: string;
  userId: string;
  tenantId: string;
  businessId: string | null;
  role: string;
  email: string;
  name: string | null;
}

const STORAGE_KEY = 'roveframe:session';

export interface SessionAPI {
  session: Session | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  signup: (
    email: string,
    password: string,
    businessName: string,
    industry: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  logout: () => void;
  /** 显式用 token 调 API（其他 hook 内部用） */
  authedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export function useSession(): SessionAPI {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setSession(JSON.parse(stored) as Session);
    } catch {
      // corrupted: 清掉
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
    } finally {
      setLoading(false);
    }
  }, []);

  const persist = useCallback((next: Session) => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* quota? */ }
    setSession(next);
  }, []);

  const login = useCallback(
    async (email: string, password: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          return { ok: false, error: body.error ?? `HTTP ${res.status}` };
        }
        const data = (await res.json()) as {
          access_token: string;
          user_id: string;
          tenant_id: string;
          business_id: string | null;
          role: string;
          email: string;
          name: string | null;
        };
        persist({
          accessToken: data.access_token,
          userId: data.user_id,
          tenantId: data.tenant_id,
          businessId: data.business_id,
          role: data.role,
          email: data.email,
          name: data.name,
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [persist],
  );

  const signup = useCallback(
    async (
      email: string,
      password: string,
      businessName: string,
      industry: string,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        const res = await fetch('/api/auth/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            password,
            business_name: businessName,
            industry,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          return { ok: false, error: body.error ?? `HTTP ${res.status}` };
        }
        const data = (await res.json()) as {
          access_token: string;
          user_id: string;
          tenant_id: string;
          business_id: string | null;
        };
        persist({
          accessToken: data.access_token,
          userId: data.user_id,
          tenantId: data.tenant_id,
          businessId: data.business_id,
          role: 'owner',
          email,
          name: null,
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [persist],
  );

  const logout = useCallback(() => {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
    setSession(null);
  }, []);

  const authedFetch = useCallback(
    async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers);
      if (session) headers.set('Authorization', `Bearer ${session.accessToken}`);
      return fetch(input, { ...init, headers });
    },
    [session],
  );

  return { session, loading, login, signup, logout, authedFetch };
}
