'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { ShieldCheck, Building2, Activity, KeyRound, ScrollText, LogOut, LifeBuoy } from 'lucide-react';

type Tab = 'overview' | 'tenants' | 'usage' | 'providers' | 'audit';

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  subscription: { status: string; current_period_end: string | null; grace_period_end: string | null } | null;
}

const SUB_STATUS_CLS: Record<string, string> = {
  trialing: 'bg-primary/10 text-primary',
  active: 'bg-success/15 text-success',
  past_due: 'bg-warning/15 text-warning',
  grace: 'bg-warning/15 text-warning',
  suspended: 'bg-error/15 text-error',
  cancelled: 'bg-surface-container-high text-on-surface-variant',
};

/** 平台控制台（/admin）。所有数据来自 /api/admin/*，会话失效自动回登录页。 */
export default function AdminDashboardPage() {
  const router = useRouter();
  const [admin, setAdmin] = useState<{ email: string; role: string } | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [overview, setOverview] = useState<Record<string, unknown> | null>(null);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [search, setSearch] = useState('');
  const [providers, setProviders] = useState<Array<Record<string, unknown>>>([]);
  const [usage, setUsage] = useState<Record<string, { calls: number; errors: number; inputTokens: number; outputTokens: number }>>({});
  const [logs, setLogs] = useState<Array<Record<string, unknown>>>([]);
  const [grantTenant, setGrantTenant] = useState('');
  const [grantReason, setGrantReason] = useState('');
  const [tip, setTip] = useState('');

  const authedFetch = useCallback(
    async (url: string, init?: RequestInit) => {
      const res = await fetch(url, init);
      if (res.status === 401) {
        router.push('/admin/login');
        throw new Error('unauthorized');
      }
      return res.json();
    },
    [router],
  );

  useEffect(() => {
    fetch('/api/admin/auth')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.authenticated) router.push('/admin/login');
        else setAdmin(data.admin);
      })
      .catch(() => router.push('/admin/login'));
  }, [router]);

  const loadTab = useCallback(async () => {
    try {
      if (tab === 'overview') setOverview(await authedFetch('/api/admin/overview'));
      if (tab === 'tenants') {
        const data = await authedFetch(`/api/admin/tenants${search ? `?search=${encodeURIComponent(search)}` : ''}`);
        setTenants(data.tenants ?? []);
      }
      if (tab === 'providers') {
        const data = await authedFetch('/api/admin/providers');
        setProviders(data.providers ?? []);
      }
      if (tab === 'usage') {
        const data = await authedFetch('/api/admin/usage');
        setUsage(data.byTenant ?? {});
      }
      if (tab === 'audit') {
        const data = await authedFetch('/api/admin/audit-logs');
        setLogs(data.logs ?? []);
      }
    } catch {
      // 401 已跳转
    }
  }, [tab, search, authedFetch]);

  useEffect(() => {
    if (admin) loadTab();
  }, [admin, loadTab]);

  const tenantAction = async (tenantId: string, action: string, extra: Record<string, unknown> = {}) => {
    await authedFetch(`/api/admin/tenants/${tenantId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    });
    setTip(`${action} done`);
    setTimeout(() => setTip(''), 2000);
    await loadTab();
  };

  const createGrant = async () => {
    if (!grantTenant.trim() || !grantReason.trim()) return;
    await authedFetch('/api/admin/support-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: grantTenant.trim(), reason: grantReason.trim() }),
    });
    setGrantTenant('');
    setGrantReason('');
    setTip('support grant created (read-only, 60min)');
    setTimeout(() => setTip(''), 2500);
  };

  const logout = async () => {
    await fetch('/api/admin/auth', { method: 'DELETE' });
    router.push('/admin/login');
  };

  if (!admin) return null;

  const tabs: Array<{ key: Tab; label: string; icon: typeof Activity }> = [
    { key: 'overview', label: '总览', icon: Activity },
    { key: 'tenants', label: '商户', icon: Building2 },
    { key: 'usage', label: 'AI 用量', icon: KeyRound },
    { key: 'providers', label: 'Provider 健康', icon: ShieldCheck },
    { key: 'audit', label: '审计日志', icon: ScrollText },
  ];

  return (
    <main className="min-h-screen bg-background text-on-surface p-6">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold">RoveFrame Platform Control Plane</h1>
            <p className="text-xs text-on-surface-variant mt-0.5">{admin.email} · {admin.role}</p>
          </div>
          <div className="flex items-center gap-3">
            {tip && <span className="text-xs text-success font-medium">{tip}</span>}
            <button onClick={logout} className="inline-flex items-center gap-1.5 text-xs text-on-surface-variant hover:text-on-surface">
              <LogOut className="w-3.5 h-3.5" /> 退出
            </button>
          </div>
        </div>

        <div className="flex gap-1 mb-6 border-b border-outline/30">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-t-md transition-colors ${
                tab === t.key ? 'bg-surface text-primary border-b-2 border-primary' : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              <t.icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'overview' && overview && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-surface rounded-lg shadow-card p-5">
              <p className="text-xs text-on-surface-variant">商户总数</p>
              <p className="text-2xl font-bold mt-1">{String(overview.tenantCount ?? 0)}</p>
            </div>
            <div className="bg-surface rounded-lg shadow-card p-5">
              <p className="text-xs text-on-surface-variant">14 天内到期</p>
              <p className="text-2xl font-bold mt-1 text-warning">{String(overview.expiringSoon ?? 0)}</p>
            </div>
            <div className="bg-surface rounded-lg shadow-card p-5">
              <p className="text-xs text-on-surface-variant">订阅状态</p>
              <div className="mt-2 space-y-1">
                {Object.entries((overview.subscriptionsByStatus ?? {}) as Record<string, number>).map(([s, n]) => (
                  <p key={s} className="text-xs flex justify-between"><span className={`px-1.5 py-0.5 rounded ${SUB_STATUS_CLS[s] ?? ''}`}>{s}</span><span className="font-semibold">{n}</span></p>
                ))}
              </div>
            </div>
            <div className="bg-surface rounded-lg shadow-card p-5">
              <p className="text-xs text-on-surface-variant">AI 调用（近 500 条）</p>
              <div className="mt-2 space-y-1">
                {Object.entries((overview.aiUsageByProvider ?? {}) as Record<string, { calls: number; errors: number }>).map(([p, u]) => (
                  <p key={p} className="text-xs flex justify-between"><span className="font-mono">{p}</span><span>{u.calls} 次{u.errors ? ` · ${u.errors} 错` : ''}</span></p>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === 'tenants' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索商户名称 / slug…"
                className="bg-surface-container border-none rounded-md px-3 py-2 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <button onClick={loadTab} className="bg-surface-container px-3 py-2 rounded-md text-sm">搜索</button>
            </div>
            <div className="bg-surface rounded-lg shadow-card divide-y divide-outline/20">
              {tenants.map((t) => (
                <div key={t.id} className="p-4 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{t.name} <span className="text-xs font-mono text-on-surface-variant">({t.slug})</span></p>
                    <p className="text-xs text-on-surface-variant mt-0.5">
                      {t.subscription
                        ? `${t.subscription.status} · 到期 ${t.subscription.current_period_end?.slice(0, 10) ?? '—'} · 宽限至 ${t.subscription.grace_period_end?.slice(0, 10) ?? '—'}`
                        : '无订阅'}
                    </p>
                  </div>
                  {t.subscription && (
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${SUB_STATUS_CLS[t.subscription.status] ?? ''}`}>{t.subscription.status}</span>
                      {t.subscription.status === 'suspended' ? (
                        <button onClick={() => tenantAction(t.id, 'resume')} className="text-xs text-success font-medium hover:underline">恢复</button>
                      ) : (
                        <button onClick={() => tenantAction(t.id, 'suspend')} className="text-xs text-error font-medium hover:underline">暂停</button>
                      )}
                      <button onClick={() => tenantAction(t.id, 'extend', { days: 30 })} className="text-xs text-primary font-medium hover:underline">+30 天</button>
                      <button onClick={() => tenantAction(t.id, 'record_offline_renewal', { days: 30 })} className="text-xs text-on-surface-variant font-medium hover:underline">登记线下续费</button>
                    </div>
                  )}
                </div>
              ))}
              {!tenants.length && <p className="p-6 text-sm text-on-surface-variant text-center">暂无商户</p>}
            </div>

            <div className="bg-surface rounded-lg shadow-card p-5">
              <h3 className="text-sm font-semibold flex items-center gap-2 mb-3"><LifeBuoy className="w-4 h-4 text-primary" /> 受控售后排障授权（默认只读，60 分钟）</h3>
              <div className="flex flex-wrap items-center gap-3">
                <input value={grantTenant} onChange={(e) => setGrantTenant(e.target.value)} placeholder="tenant id" className="bg-surface-container border-none rounded-md px-3 py-2 text-xs font-mono w-72 focus:outline-none focus:ring-2 focus:ring-primary/30" />
                <input value={grantReason} onChange={(e) => setGrantReason(e.target.value)} placeholder="排障原因（必填，写入审计）" className="bg-surface-container border-none rounded-md px-3 py-2 text-xs flex-1 min-w-52 focus:outline-none focus:ring-2 focus:ring-primary/30" />
                <button onClick={createGrant} className="bg-primary text-on-primary px-3.5 py-2 rounded-md text-xs font-medium">创建授权</button>
              </div>
            </div>
          </div>
        )}

        {tab === 'usage' && (
          <div className="bg-surface rounded-lg shadow-card divide-y divide-outline/20">
            {Object.entries(usage).map(([tid, u]) => (
              <div key={tid} className="p-4 flex items-center justify-between">
                <span className="text-xs font-mono text-on-surface-variant truncate max-w-72">{tid}</span>
                <span className="text-xs">{u.calls} 次调用 · {u.errors} 错误 · {u.inputTokens + u.outputTokens} tokens</span>
              </div>
            ))}
            {!Object.keys(usage).length && <p className="p-6 text-sm text-on-surface-variant text-center">暂无用量记录</p>}
          </div>
        )}

        {tab === 'providers' && (
          <div className="bg-surface rounded-lg shadow-card divide-y divide-outline/20">
            {providers.map((p, i) => (
              <div key={i} className="p-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-mono">{String(p.provider)}</p>
                  <p className="text-[11px] font-mono text-on-surface-variant truncate max-w-72">{String(p.tenantId)}</p>
                </div>
                <div className="flex items-center gap-2 text-xs shrink-0">
                  <span className={p.isEnabled ? 'text-success' : 'text-on-surface-variant'}>{p.isEnabled ? '启用' : '停用'}</span>
                  <span className={p.lastTestOk === true ? 'text-success' : p.lastTestOk === false ? 'text-error' : 'text-on-surface-variant'}>
                    {p.lastTestOk === true ? '测试通过' : p.lastTestOk === false ? '测试失败' : '未测试'}
                  </span>
                  <span className="text-on-surface-variant">{p.keyConfigured ? 'key 已配置（掩码）' : '无 key'}</span>
                </div>
              </div>
            ))}
            {!providers.length && <p className="p-6 text-sm text-on-surface-variant text-center">暂无 Provider 连接</p>}
          </div>
        )}

        {tab === 'audit' && (
          <div className="bg-surface rounded-lg shadow-card divide-y divide-outline/20">
            {logs.map((log) => (
              <div key={String(log.id)} className="p-3.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium">{String(log.action)}</p>
                  <p className="text-[11px] text-on-surface-variant font-mono truncate">{String(log.target_tenant_id ?? '—')} · {String(log.request_id ?? '')}</p>
                </div>
                <span className="text-[11px] text-on-surface-variant shrink-0">{String(log.created_at ?? '').slice(0, 19).replace('T', ' ')}</span>
              </div>
            ))}
            {!logs.length && <p className="p-6 text-sm text-on-surface-variant text-center">暂无审计记录</p>}
          </div>
        )}
      </div>
    </main>
  );
}
