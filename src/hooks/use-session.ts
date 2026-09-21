'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * 客户端 session hook（P0-S2 完整版：Part G）
 *
 * 会话凭据: 服务端 HttpOnly cookie `rf_session`（前端不可读取）
 * 内存状态: { userId, tenantId, businessId, role, email, name }
 *
 * 范围: 仅做 session 状态管理 + 调 /api/auth/{login,signup} 拿 token
 * 路由守卫 / 强制登录跳转 留到 P0-S3 RBAC 做。
 */

export interface Session {
  userId: string;
  tenantId: string;
  businessId: string | null;
  role: string;
  email: string;
  name: string | null;
}

export interface SessionAPI {
  session: Session | null;
  loading: boolean;
  /**
   * 登录。返回**服务端判定的角色**。
   *
   * 为什么要把 role 带出来：登录页有「老板 / 员工」两个入口，但那只是**提示**。
   * 真正算数的是服务端返回的角色 —— 客户端传什么都不该决定权限与落点。
   * 调用方拿它来跳转，避免再请求一次 `/api/auth/me` 才知道自己是谁。
   */
  login: (email: string, password: string) => Promise<{ ok: true; role: string } | { ok: false; error: string }>;
  signup: (
    email: string,
    password: string,
    businessName: string,
    industry: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  logout: () => void;
  /** 同源请求自动携带 HttpOnly 会话 cookie。 */
  authedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export function useSession(): SessionAPI {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetch('/api/auth/me')
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<{
          user_id: string;
          tenant_id: string;
          business_id: string | null;
          role: string;
          email: string;
          name: string | null;
        }>;
      })
      .then((data) => {
        if (!active || !data) return;
        setSession({
          userId: data.user_id,
          tenantId: data.tenant_id,
          businessId: data.business_id,
          role: data.role,
          email: data.email,
          name: data.name,
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const persist = useCallback((next: Session) => {
    setSession(next);
  }, []);

  const login = useCallback(
    async (email: string, password: string): Promise<{ ok: true; role: string } | { ok: false; error: string }> => {
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
          user_id: string;
          tenant_id: string;
          business_id: string | null;
          role: string;
          email: string;
          name: string | null;
        };
        persist({
          userId: data.user_id,
          tenantId: data.tenant_id,
          businessId: data.business_id,
          role: data.role,
          email: data.email,
          name: data.name,
        });
        return { ok: true, role: data.role };
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
          user_id: string;
          tenant_id: string;
          business_id: string | null;
        };
        persist({
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
    void fetch('/api/auth/logout', { method: 'POST' });
    setSession(null);
  }, []);

  const authedFetch = useCallback(
    async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      return fetch(input, { ...init, credentials: 'same-origin' });
    },
    [],
  );

  return { session, loading, login, signup, logout, authedFetch };
}
