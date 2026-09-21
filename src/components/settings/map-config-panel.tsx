'use client';

import React, { useCallback, useEffect, useState } from 'react';

/**
 * 设置页 · 地图服务商配置（自包含组件）。
 *
 * ## 为什么单独一个组件而不是写进 settings/page.tsx 里
 *
 * 那个文件近 2000 行、且正由另一位同事改动。这里做成自包含的一块：
 *   · 只依赖 `/api/settings/map` 一个接口；
 *   · 文案不走 messages/*.json（与同目录其它 PWA 组件一致）—— 三语文案文件
 *     由别人维护，本次不往里面加键，也就不会与他的改动冲突；
 *   · 挂载点只有一行 `<MapConfigPanel />`（在"系统集成"分组里）。
 *
 * ## 关于 key 的三件事（界面上必须说清楚）
 *
 *   1. key 是**只写不回显**的：读接口只回 `key_state`，因此这个输入框永远是空的；
 *      旁边用"已配置 / 未配置"表示服务端有没有存过。
 *   2. 留空提交 = **不改动**已存的 key；想清除请用"清除密钥"按钮（它会显式传空串）。
 *      这个区分很重要：把"没填"当成"清空"会让老板一保存就丢掉 key，而症状是
 *      顾客端地图突然不显示（那时谁也想不起来是这次保存干的）。
 *   3. **浏览器端地图 key 一定会被访问者看到**（开发者工具里就能读到）。这是客户端
 *      地图的固有限制，不是本项目的缺陷。所以这里不假装能藏住它，而是明确提示：
 *      去厂商后台配 referrer / 域名白名单与用量上限 —— 那是唯一有效的限制手段。
 */

const inputCls =
  'w-full bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors';
const selectCls =
  'w-full bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors';
const labelCls = 'block text-xs font-medium text-on-surface-variant mb-1.5';
const primaryBtn =
  'bg-primary text-on-primary px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-60';
const ghostBtn =
  'bg-surface-container text-on-surface border-none px-4 py-2 rounded-md text-sm font-medium hover:bg-surface-container-high active:scale-[0.98] transition-all disabled:opacity-60';

interface ProviderCatalogEntry {
  id: string;
  label: string;
  mode: 'sdk' | 'tiles';
  default_base_url: string;
  key_param: string;
  key_hint: string;
  attribution: string;
  key_verifiable_server_side: boolean;
  coordinate_note: string;
}

interface MapState {
  provider: string | null;
  base_url: string;
  style: string;
  enabled: boolean;
  attribution: string;
  key_state: 'unset' | 'set' | 'unreadable';
  configured: boolean;
}

interface MapResponse {
  map?: MapState;
  providers?: ProviderCatalogEntry[];
  key_visibility_note?: string;
}

interface TestResult {
  ok: boolean;
  status: number | null;
  checked: 'tile' | 'script';
  key_verified: boolean;
  target: string;
  detail: string;
}

/** 只认识这三句：没有它就不知道该说"还没配"还是"配坏了"。 */
function keyStateLabel(state: MapState['key_state']): string {
  switch (state) {
    case 'set': return '已配置密钥';
    case 'unreadable': return '密钥无法解密';
    default: return '未配置密钥';
  }
}

export const MapConfigPanel: React.FC = () => {
  const [providers, setProviders] = useState<ProviderCatalogEntry[]>([]);
  const [state, setState] = useState<MapState | null>(null);
  const [provider, setProvider] = useState<string>('');
  const [baseUrl, setBaseUrl] = useState<string>('');
  const [style, setStyle] = useState<string>('');
  const [enabled, setEnabled] = useState<boolean>(false);
  // 输入框永远是空的：key 只写不回显（见文件头）。
  const [apiKey, setApiKey] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [test, setTest] = useState<TestResult | null>(null);
  const [note, setNote] = useState<string>('');

  const applyResponse = useCallback((data: MapResponse) => {
    setProviders(data.providers ?? []);
    setState(data.map ?? null);
    setNote(data.key_visibility_note ?? '');
    const map = data.map;
    setProvider(map?.provider ?? '');
    setBaseUrl(map?.base_url ?? '');
    setStyle(map?.style ?? '');
    setEnabled(Boolean(map?.enabled));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/settings/map', { credentials: 'include' });
      if (!res.ok) {
        setError(res.status === 403 ? '当前账号没有配置地图的权限。' : '读取地图配置失败。');
        return;
      }
      applyResponse((await res.json()) as MapResponse);
    } catch {
      setError('网络错误，读取地图配置失败。');
    } finally {
      setLoading(false);
    }
  }, [applyResponse]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = providers.find((entry) => entry.id === provider) ?? null;

  const save = async (clearKey: boolean) => {
    if (!provider) {
      setError('请先选择地图服务商。');
      return;
    }
    setSaving(true);
    setError('');
    setMessage('');
    setTest(null);
    try {
      const payload: Record<string, unknown> = {
        provider,
        base_url: baseUrl,
        style,
        enabled,
      };
      // 留空 = 不动已存的 key；清除则显式传空串（两者的语义差别见文件头）。
      if (clearKey) payload.api_key = '';
      else if (apiKey.trim()) payload.api_key = apiKey.trim();

      const res = await fetch('/api/settings/map', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!res.ok) {
        setError(data.error ?? '保存失败。');
        return;
      }
      setApiKey('');
      setMessage(clearKey ? '已保存并清除密钥。' : '已保存。');
      await load();
    } catch {
      setError('网络错误，保存失败。');
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setError('');
    setMessage('');
    setTest(null);
    try {
      const res = await fetch('/api/settings/map', { method: 'POST', credentials: 'include' });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        result?: TestResult;
      };
      if (!res.ok) {
        setError(data.error ?? '测试失败。');
        return;
      }
      setTest(data.result ?? null);
    } catch {
      setError('网络错误，测试失败。');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="rounded-md bg-surface-container/60 p-5 mb-3" id="map-config-panel">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-md bg-primary/10 text-primary flex items-center justify-center text-lg">
            🗺
          </span>
          <div>
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold">配送地图</p>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-container-highest text-on-surface-variant font-medium">
                {state?.configured ? keyStateLabel(state.key_state) : '未配置'}
              </span>
            </div>
            <p className="text-xs text-on-surface-variant mt-0.5">
              顾客端「配送状态」里的地图。两种模式由服务商决定：SDK 模式运行期加载厂商 JS，瓦片模式直接取瓦片图片。
            </p>
          </div>
        </div>
      </div>

      {loading && <p className="text-sm text-on-surface-variant">正在读取…</p>}

      {!loading && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls} htmlFor="map-provider">服务商</label>
              <select
                id="map-provider"
                value={provider}
                onChange={(event) => {
                  setProvider(event.target.value);
                  setTest(null);
                  setMessage('');
                }}
                className={selectCls}
              >
                <option value="">未配置</option>
                {providers.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}（{entry.mode === 'sdk' ? 'SDK' : '瓦片'}）
                  </option>
                ))}
              </select>
              {selected?.coordinate_note && (
                <p className="text-[11px] text-warning mt-1.5">{selected.coordinate_note}</p>
              )}
            </div>

            <div>
              <label className={labelCls} htmlFor="map-api-key">
                API key{state?.key_state === 'set' ? '（留空表示不修改）' : ''}
              </label>
              <input
                id="map-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={selected?.key_hint ?? '选择服务商后填写'}
                className={inputCls}
              />
              {/* key 只写不回显：这里只显示状态，不显示任何片段。 */}
              <p className="text-[11px] text-on-surface-variant mt-1.5">
                当前状态：{state ? keyStateLabel(state.key_state) : '未配置'}。
                {state?.key_state === 'unreadable' &&
                  '（服务端存着密钥但解不开，通常是 ENCRYPTION_SECRET 被轮换过。重新填一次即可。）'}
              </p>
            </div>
          </div>

          <div>
            <label className={labelCls} htmlFor="map-base-url">接口地址（留空用服务商默认值）</label>
            <input
              id="map-base-url"
              type="text"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={selected?.default_base_url || 'https://.../{z}/{x}/{y}.png'}
              className={inputCls}
            />
            <p className="text-[11px] text-on-surface-variant mt-1.5">
              {selected?.mode === 'tiles'
                ? '瓦片模板必须含 {z} {x} {y}；key 会作为查询参数拼在后面（天地图是 tk，MapTiler 是 key）。'
                : `厂商 JS 地址。默认 ${selected?.default_base_url || '—'}，key 以 ${selected?.key_param ?? 'key'} 参数拼接。`}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls} htmlFor="map-style">样式 / style id（可选）</label>
              <input
                id="map-style"
                type="text"
                value={style}
                onChange={(event) => setStyle(event.target.value)}
                placeholder={provider === 'mapbox' ? 'mapbox://styles/mapbox/streets-v12' : ''}
                className={inputCls}
              />
            </div>
            <div className="flex items-end">
              <button
                type="button"
                onClick={() => setEnabled((current) => !current)}
                className="inline-flex items-center gap-2 text-sm text-on-surface"
                id="map-enabled-toggle"
              >
                <span className={`block w-9 h-5 rounded-full relative transition-colors ${enabled ? 'bg-primary' : 'bg-surface-container-highest'}`}>
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${enabled ? 'right-0.5' : 'left-0.5'}`} />
                </span>
                <span>{enabled ? '顾客端显示地图' : '已关闭（顾客端不显示地图）'}</span>
              </button>
            </div>
          </div>

          {/* key 的可见性：这条提示必须在输入框附近，不能只写在文档里。 */}
          <p className="text-[11px] rounded-md bg-surface-container-high text-on-surface-variant p-3">
            {note ||
              '浏览器端地图 key 一定会被访问者看到（开发者工具即可读取），这是客户端地图的固有限制。'
              + '请到地图厂商后台配置 referrer / 域名白名单与用量上限。'}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void save(false)} disabled={saving} className={primaryBtn} id="map-save">
              {saving ? '保存中…' : '保存'}
            </button>
            <button type="button" onClick={() => void save(true)} disabled={saving || state?.key_state !== 'set'} className={ghostBtn}>
              清除密钥
            </button>
            <button
              type="button"
              onClick={() => void runTest()}
              disabled={testing || !state?.configured}
              className={ghostBtn}
              id="map-test"
            >
              {testing ? '测试中…' : '测试连接'}
            </button>
            {message && <span className="text-xs text-primary">{message}</span>}
          </div>

          {/* 测试结论原样展示：验了什么、打的哪个地址、key 有没有真的验过。 */}
          {test && (
            <div className={`text-xs rounded-md p-3 ${test.ok ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>
              <div className="font-medium">
                {test.ok ? '连接成功' : '连接失败'}
                {test.checked === 'tile' ? '（瓦片）' : '（厂商脚本）'}
                {!test.key_verified && test.ok && '：注意，本次没有验证 key 本身'}
              </div>
              <div className="mt-1 break-all opacity-90">{test.detail}</div>
              <div className="mt-1 break-all opacity-70">地址：{test.target}</div>
            </div>
          )}

          {error && <p className="text-xs text-error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
};
