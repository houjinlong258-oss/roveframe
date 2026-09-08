'use client';

import { useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { ShieldCheck } from 'lucide-react';

/**
 * 平台所有者登录入口（/admin/login）。
 * 与商户登录完全分离：独立 cookie 命名空间（rf_admin_session），
 * 商户账号在此无效。
 */
export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        setError(res.status === 401 ? 'Invalid credentials' : 'Login failed');
        return;
      }
      router.push('/admin');
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-background flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm bg-surface rounded-xl shadow-dialog p-8 space-y-5">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-md bg-primary/10 text-primary flex items-center justify-center">
            <ShieldCheck className="w-5 h-5" />
          </span>
          <div>
            <h1 className="text-lg font-bold">RoveFrame Platform</h1>
            <p className="text-xs text-on-surface-variant">SaaS Control Plane — 平台所有者专用</p>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-on-surface-variant mb-1.5">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-on-surface-variant mb-1.5">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="w-full bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        {error && <p className="text-xs text-error font-medium">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-primary text-on-primary px-4 py-2.5 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-all"
        >
          {loading ? '…' : 'Sign in'}
        </button>
        <p className="text-[11px] text-on-surface-variant/70 leading-relaxed">
          商户账号无法登录此后台。所有操作都会写入平台审计日志。
        </p>
      </form>
    </main>
  );
}
