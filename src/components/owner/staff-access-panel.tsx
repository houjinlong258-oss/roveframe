'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';

/**
 * 老板端「员工端开放哪些功能」（DOM 之外的说明见 src/lib/staff-access.ts）。
 *
 * ## 这里为什么只有三个开关
 *
 * 可开关的只有"商家真正有选择权"的三个面：外卖派单 / 确认预订 / 关怀转介。
 * 员工**本人数据**的接口（我的档案、我的打卡与考勤、我的排班、我的数据导出、
 * 我的隐私开关）**不在**这里，也不该在 —— 那是员工的隐私与数据权利
 * （GDPR 第 15/20 条一类），把它做成开关等于让老板一键关掉员工查看自己
 * 工时与导出自己数据的通道。界面上因此写着一行说明，避免老板去找那个开关。
 *
 * ## 文案不走 messages/*.json
 *
 * 与同目录其它 PWA 组件（delivery-tracker / OwnerPortal）一致：这些字符串是
 * 组件内部的，仓库的三语文案由另一位同事在维护，本次改动不往 messages 里加键
 * （加了会与他的改动撞车，且这个页面本身就是中文界面）。
 */

/** 与 src/lib/staff-access.ts 的 StaffFeature 一一对应；这里是 UI 的展示层。 */
type StaffFeature = 'delivery' | 'reservations' | 'care';

type StaffAccess = Record<StaffFeature, boolean>;

interface FeatureMeta {
  key: StaffFeature;
  label: string;
  description: string;
}

/** 顺序即界面顺序。默认值不写在这里 —— 默认值只有一处（src/lib/staff-access.ts）。 */
const FEATURES: readonly FeatureMeta[] = [
  {
    key: 'delivery',
    label: '外卖派单',
    description: '员工端「待接单 / 我的配送」：认领订单、标记已取餐与已送达。不做外卖的店可以关掉。',
  },
  {
    key: 'reservations',
    label: '确认预订',
    description: '员工端「今日预订」：确认、标记到店、取消。关掉后员工端不再显示这一面。',
  },
  {
    key: 'care',
    label: '员工关怀转介',
    description: '员工端的心理支持资源清单（只做转介，不收集任何健康信息）。默认关闭，由本店主动开启。',
  },
];

/** 一行说明：哪些接口不受这些开关影响。 */
const ALWAYS_AVAILABLE_NOTE =
  '员工本人的档案、打卡与考勤、排班、数据导出与隐私开关不受这里影响，始终可用。';

export const StaffAccessPanel: React.FC = () => {
  const [access, setAccess] = useState<StaffAccess | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/team/staff-access', { credentials: 'include' });
      if (!res.ok) {
        // 401/403 分开说：前者是没登录，后者是登录了但不是老板/店长。
        setError(
          res.status === 403
            ? '只有老板或店长可以配置员工端功能。'
            : '读取失败，请刷新页面重试。',
        );
        setAccess(null);
        return;
      }
      const data = (await res.json()) as { staff_access?: Partial<StaffAccess> };
      // 服务端一定返回三个键（缺键已补成默认值），这里仍做一次形态收敛：
      // 一次 200 但形状不对的响应不该让界面渲染出 undefined 的开关。
      const incoming = data.staff_access ?? {};
      setAccess({
        delivery: incoming.delivery === true,
        reservations: incoming.reservations === true,
        care: incoming.care === true,
      });
    } catch {
      setError('网络错误，读取失败。');
      setAccess(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (key: StaffFeature) => {
    setSavedAt(false);
    setAccess((current) => (current ? { ...current, [key]: !current[key] } : current));
  };

  const save = async () => {
    if (!access) return;
    setSaving(true);
    setError(null);
    setSavedAt(false);
    try {
      const res = await fetch('/api/team/staff-access', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // 三个键都发：它们共同构成这一份设置，逐个发会让"没点的那个"落回默认值。
        body: JSON.stringify(access),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? '保存失败，请重试。');
        return;
      }
      const data = (await res.json()) as { staff_access?: Partial<StaffAccess> };
      const next = data.staff_access;
      if (next) {
        // 回显服务端**真正存下**的值，而不是本地那份：否则"保存成功"只是界面
        // 自己说的话，服务端写了什么无从核对。
        setAccess({
          delivery: next.delivery === true,
          reservations: next.reservations === true,
          care: next.care === true,
        });
      }
      setSavedAt(true);
    } catch {
      setError('网络错误，保存失败。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      id="staff-access-panel"
      className="bg-slate-900 text-slate-100 border-b border-slate-800"
      aria-labelledby="staff-access-heading"
    >
      <div className="max-w-6xl mx-auto px-4 py-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-teal-600/20 border border-teal-600/40 flex items-center justify-center text-teal-300 shrink-0">
            <ShieldCheck className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h2 id="staff-access-heading" className="font-bold text-sm tracking-tight">
              员工端功能开放
            </h2>
            <p className="text-[11px] text-slate-400 mt-1">
              权限矩阵决定「这个角色能做什么」，这里只决定「本店愿意开放哪些」。
              {ALWAYS_AVAILABLE_NOTE}
            </p>
          </div>
        </div>

        {loading && (
          <div className="mt-4 flex items-center gap-2 text-xs text-slate-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>正在读取当前设置…</span>
          </div>
        )}

        {!loading && access && (
          <div className="mt-4 space-y-2">
            {FEATURES.map((feature) => {
              const on = access[feature.key];
              return (
                <div
                  key={feature.key}
                  className="flex items-start justify-between gap-4 bg-slate-800/60 border border-slate-700/70 rounded-2xl px-3.5 py-3"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-white">{feature.label}</div>
                    <p className="text-[11px] text-slate-400 mt-0.5">{feature.description}</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={feature.label}
                    id={`staff-access-${feature.key}`}
                    onClick={() => toggle(feature.key)}
                    disabled={saving}
                    className={`relative w-11 h-6 rounded-full transition shrink-0 mt-0.5 disabled:opacity-50 ${
                      on ? 'bg-teal-600' : 'bg-slate-600'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
                        on ? 'left-[22px]' : 'left-0.5'
                      }`}
                    />
                    <span className="sr-only">{on ? '已开启' : '已关闭'}</span>
                  </button>
                </div>
              );
            })}

            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                id="staff-access-save"
                onClick={() => void save()}
                disabled={saving}
                className="px-3.5 py-2 rounded-xl bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white text-xs font-semibold inline-flex items-center gap-2 transition"
              >
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>保存</span>
              </button>
              {savedAt && <span className="text-[11px] text-teal-300">已保存</span>}
            </div>
          </div>
        )}

        {!loading && error && (
          <p className="mt-4 text-[11px] text-rose-300" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
};
