'use client';

import { useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { Sparkles, ArrowRight, ArrowLeft, CircleCheck } from 'lucide-react';

interface Draft {
  businessName: string;
  industry: string;
  location: string | null;
  timezone: string | null;
  currency: string | null;
  language: 'en' | 'zh' | 'es';
  goals: string[];
  existingSoftware: string[];
  posSystem: string;
  openingHours: string | null;
  staffRoles: string[];
  knowledgeSources: string[];
  missingFields: string[];
  parseSource: string;
}

const INDUSTRIES = ['restaurant', 'retail', 'hotel', 'healthcare', 'beauty', 'fitness', 'other'];
const POS_OPTIONS = ['square', 'toast', 'clover', 'shopify', 'lightspeed', 'none', 'unknown'];

const inputCls =
  'w-full bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30';
const labelCls = 'block text-xs font-medium text-on-surface-variant mb-1.5';

/**
 * AI Business Setup Wizard（/onboarding）。
 * 自然语言 → 可编辑预览 → 用户确认后才创建 workspace。
 * 确认前不创建任何外部连接、不发邮件、不做业务写操作。
 * 传统表单注册路径不受影响。
 */
export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<'describe' | 'preview' | 'done'>('describe');
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const parse = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/onboarding/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Parse failed');
        return;
      }
      setDraft(data.draft);
      setStep('preview');
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  const confirm = async () => {
    if (!draft) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/onboarding/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Confirm failed');
        return;
      }
      setStep('done');
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="w-full max-w-lg bg-surface rounded-xl shadow-dialog p-8">
        <div className="flex items-center gap-3 mb-6">
          <span className="w-10 h-10 rounded-md bg-primary/10 text-primary flex items-center justify-center">
            <Sparkles className="w-5 h-5" />
          </span>
          <div>
            <h1 className="text-lg font-bold">AI Business Setup</h1>
            <p className="text-xs text-on-surface-variant">
              {step === 'describe' ? '用一句话描述你的业务' : step === 'preview' ? '确认并调整你的业务信息' : '工作区已就绪'}
            </p>
          </div>
        </div>

        {step === 'describe' && (
          <div className="space-y-4">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              maxLength={2000}
              placeholder='例如："I own a sushi restaurant in New York." / "我在上海经营一家咖啡店，用 Square 收款，想提高回头客。"'
              className={`${inputCls} resize-none`}
            />
            {error && <p className="text-xs text-error font-medium">{error}</p>}
            <button
              onClick={parse}
              disabled={loading || text.trim().length < 4}
              className="w-full bg-primary text-on-primary px-4 py-2.5 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-all inline-flex items-center justify-center gap-2"
            >
              {loading ? '…' : <>解析并预览 <ArrowRight className="w-4 h-4" /></>}
            </button>
            <p className="text-[11px] text-on-surface-variant/70">解析只生成预览草稿，不会创建任何数据；你也可以跳过向导使用传统设置。</p>
          </div>
        )}

        {step === 'preview' && draft && (
          <div className="space-y-4">
            <div>
              <label className={labelCls}>业务名称</label>
              <input value={draft.businessName} onChange={(e) => setDraft({ ...draft, businessName: e.target.value })} className={inputCls} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>行业</label>
                <select value={draft.industry} onChange={(e) => setDraft({ ...draft, industry: e.target.value })} className={inputCls}>
                  {INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>POS 系统</label>
                <select value={draft.posSystem} onChange={(e) => setDraft({ ...draft, posSystem: e.target.value })} className={inputCls}>
                  {POS_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className={labelCls}>地点</label>
                <input value={draft.location ?? ''} onChange={(e) => setDraft({ ...draft, location: e.target.value || null })} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>币种</label>
                <input value={draft.currency ?? ''} maxLength={3} onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() || null })} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>时区</label>
                <input value={draft.timezone ?? ''} onChange={(e) => setDraft({ ...draft, timezone: e.target.value || null })} className={inputCls} />
              </div>
            </div>
            <div>
              <label className={labelCls}>经营目标（逗号分隔）</label>
              <input
                value={draft.goals.join(', ')}
                onChange={(e) => setDraft({ ...draft, goals: e.target.value.split(',').map((g) => g.trim()).filter(Boolean).slice(0, 10) })}
                className={inputCls}
              />
            </div>
            {draft.missingFields.length > 0 && (
              <p className="text-xs text-warning bg-warning/10 rounded-md p-3">
                建议补充：{draft.missingFields.join('、')}
              </p>
            )}
            {error && <p className="text-xs text-error font-medium">{error}</p>}
            <div className="flex justify-between">
              <button onClick={() => setStep('describe')} className="inline-flex items-center gap-1.5 text-sm text-on-surface-variant hover:text-on-surface">
                <ArrowLeft className="w-4 h-4" /> 返回
              </button>
              <button
                onClick={confirm}
                disabled={loading || !draft.businessName.trim()}
                className="bg-primary text-on-primary px-5 py-2.5 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-all"
              >
                {loading ? '…' : '确认并创建工作区'}
              </button>
            </div>
            <p className="text-[11px] text-on-surface-variant/70">点击确认前不会创建任何数据；重复提交不会产生重复工作区。</p>
          </div>
        )}

        {step === 'done' && (
          <div className="text-center space-y-4 py-4">
            <CircleCheck className="w-12 h-12 text-success mx-auto" />
            <h2 className="text-base font-semibold">工作区已创建</h2>
            <p className="text-sm text-on-surface-variant">接下来可以连接你的 POS、配置 AI 服务商，并开始使用 AI COO。</p>
            <button
              onClick={() => router.push('/settings')}
              className="bg-primary text-on-primary px-5 py-2.5 rounded-md text-sm font-medium hover:opacity-90 transition-all"
            >
              前往设置
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
