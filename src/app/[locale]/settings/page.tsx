'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter, usePathname } from '@/i18n/navigation';
import {
  Store, Languages, KeyRound, Inbox, Blocks, SlidersHorizontal, Database, MessageCircle,
  X, Zap, Plus, Mail, Server, ShieldCheck, Factory, Square, ShoppingBag,
  CreditCard, Wallet, Plug, Check, Minus, RefreshCw, Trash2, TriangleAlert, CircleCheck, CircleX,
  Send, Palette, Sun, Moon, Monitor,
} from 'lucide-react';
import { fmtDateTime } from '@/lib/format';
import { saveJson } from '@/lib/fetch-utils';
import { CHANNEL_PRESETS, type ChannelKey } from '@/lib/channels-presets';
import { SMTP_PRESETS } from '@/lib/email/smtp-presets';
import { useTheme, type ThemeMode } from '@/components/theme/theme-provider';

type Group = 'business' | 'locale' | 'appearance' | 'models' | 'mailbox' | 'integrations' | 'channels' | 'ai' | 'data';

interface ProviderConnection {
  maskedKey: string;
  hasKey: boolean;
  baseUrl: string | null;
  defaultModel: string | null;
  isEnabled: boolean;
  lastTestOk: boolean | null;
  lastTestedAt: string | null;
  lastTestError: string | null;
  displayName: string | null;
  timeoutMs: number | null;
  maxRetries: number | null;
  modelsCache: string[] | null;
  modelsUpdatedAt: string | null;
  optInLocal: boolean;
}

interface Provider {
  id: string;
  displayName: string;
  category: string;
  protocol: string;
  authType: string;
  runtime: 'native' | 'openai_compat' | 'declared';
  modelDiscovery: 'models_endpoint' | 'manual';
  keyHint: string;
  defaultBaseUrl: string;
  catalogModels: { id: string }[];
  capabilities: { streaming: boolean; tools: boolean; vision: boolean; embeddings: boolean; reasoning: boolean };
  connection: ProviderConnection | null;
}

interface AIRouteInfo {
  requestId?: string;
  kind?: string;
  provider?: string;
  model?: string;
  usedFallback?: boolean;
  fallbackReason?: string | null;
  error?: string;
}

interface EmailAccount {
  id: string;
  provider: string;
  email: string;
  display_name: string | null;
  auth_type: string;
  smtp_host: string | null;
  is_default: boolean;
  status: string;
}

interface Integration {
  id: string;
  provider: string;
  is_enabled: boolean;
  sync_scope: string[];
  last_sync_at: string | null;
  status: string;
  recordCount: number;
  /**
   * Phase 15：该集成是否具备**真实的**数据同步实现。
   *
   * 由 `/api/integrations` 从 `src/lib/connectors/capabilities.ts` 带出，
   * 与同步路由、状态写入共用同一事实源。
   * 不能只看 `status`：不可同步的 provider 存的是 `connectivity_only`，
   * 而它的意义是"连通性已验证、**数据不会同步**"。
   */
  syncable?: boolean;
  /** 不可同步时给用户的说明（英文兜底，UI 可覆盖） */
  capabilityNotice?: string | null;
}

const PROVIDER_INITIALS: Record<string, string> = {
  claude: 'C', anthropic: 'C', openai: 'O', gemini: 'G', deepseek: 'D', doubao: '豆',
  kimi: 'K', moonshot: 'K', moonshot_cn: 'K', qwen: '通', glm: '智', grok: 'X', xai: 'X', custom: '',
};

const CHANNEL_LABELS: Record<ChannelKey, string> = {
  telegram: 'Telegram', whatsapp: 'WhatsApp', slack: 'Slack', discord: 'Discord',
  mattermost: 'Mattermost', matrix: 'Matrix', feishu: 'Feishu', wecom: 'WeCom', dingtalk: 'DingTalk',
  signal: 'Signal', bluebubbles: 'BlueBubbles (iMessage)', weixin: 'WeChat', qqbot: 'QQ Bot',
};

const INT_FIELDS: Record<string, { key: string; secret?: boolean; placeholder?: string }[]> = {
  square: [
    { key: 'accessToken', secret: true, placeholder: 'EAAA...' },
    { key: 'locationId', placeholder: 'L... (comma-separated, max 10)' },
    { key: 'signatureKey', secret: true, placeholder: 'Square webhook signature key' },
    { key: 'webhookUrl', placeholder: 'https://app.example.com/api/webhooks/square?...' },
  ],
  shopify: [
    { key: 'shopDomain', placeholder: 'your-store.myshopify.com' },
    { key: 'accessToken', secret: true, placeholder: 'shpat_...' },
  ],
  stripe: [
    { key: 'secretKey', secret: true, placeholder: 'sk_live_...' },
    { key: 'webhookSecret', secret: true, placeholder: 'whsec_...' },
  ],
  paypal: [
    { key: 'clientId', placeholder: 'Client ID' },
    { key: 'clientSecret', secret: true, placeholder: 'Client Secret' },
  ],
};

const ERP_SCOPES = ['inventory', 'suppliers', 'costs', 'finance'] as const;

const inputCls =
  'w-full bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors';
const selectCls =
  'w-full bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors';
const labelCls = 'block text-xs font-medium text-on-surface-variant mb-1.5';
const primaryBtn =
  'bg-primary text-on-primary px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-60';
const ghostBtn =
  'bg-surface-container text-on-surface border-none px-4 py-2 rounded-md text-sm font-medium hover:bg-surface-container-high active:scale-[0.98] transition-all';

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} className="shrink-0">
      <span className={`block w-9 h-5 rounded-full relative transition-colors ${on ? 'bg-primary' : 'bg-surface-container-highest'}`}>
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${on ? 'right-0.5' : 'left-0.5'}`} />
      </span>
    </button>
  );
}

function StatusBadge({ connected, connectedText, disconnectedText }: { connected: boolean; connectedText: string; disconnectedText: string }) {
  return connected ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-xs font-medium bg-success/15 text-success">
      <span className="w-1.5 h-1.5 rounded-full bg-success" />
      {connectedText}
    </span>
  ) : (
    <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium bg-surface-container-high text-on-surface-variant">
      {disconnectedText}
    </span>
  );
}

export default function SettingsPage() {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  const [group, setGroup] = useState<Group>('models');
  const { mode: themeMode, resolved: themeResolved, setMode: setThemeMode } = useTheme();
  const [savedTip, setSavedTip] = useState('');
  const [saveError, setSaveError] = useState('');

  // 设置主数据
  const [settings, setSettings] = useState<{ business: Record<string, string>; locale: Record<string, string>; ai_prefs: Record<string, unknown>; model_assign: Record<string, string> } | null>(null);
  // 模型
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerSearch, setProviderSearch] = useState('');
  const [routeInfo, setRouteInfo] = useState<Record<string, AIRouteInfo>>({});
  const [modelModal, setModelModal] = useState<Provider | null>(null);
  const [modelForm, setModelForm] = useState({ apiKey: '', baseUrl: '', defaultModel: '', displayName: '', timeoutMs: '', maxRetries: '', optInLocal: false });
  const [modelTest, setModelTest] = useState<{ state: 'idle' | 'testing' | 'ok' | 'fail'; error?: string; models?: string[] | null }>({ state: 'idle' });
  const [modelSaving, setModelSaving] = useState(false);
  const [assign, setAssign] = useState<Record<string, string>>({ agent: 'auto', content: 'auto', rag: 'auto', light: 'auto' });
  // 邮箱
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [mailModal, setMailModal] = useState(false);
  const [mailType, setMailType] = useState<'gmail' | 'outlook' | 'smtp'>('smtp');
  const [mailForm, setMailForm] = useState({ email: '', displayName: '', smtpHost: '', smtpPort: String(SMTP_PRESETS.outlook.port), imapHost: '', imapPort: '993', pass: '' });
  const [mailSaving, setMailSaving] = useState(false);
  // 集成
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [erpModal, setErpModal] = useState(false);
  const [erpForm, setErpForm] = useState({ url: '', apiKey: '', apiSecret: '', scopes: ['inventory', 'suppliers', 'costs'] as string[] });
  const [erpTest, setErpTest] = useState<{ state: 'idle' | 'testing' | 'ok' | 'fail'; error?: string }>({ state: 'idle' });
  const [intModal, setIntModal] = useState<string | null>(null);
  const [intForm, setIntForm] = useState<Record<string, string>>({});
  const [intTest, setIntTest] = useState<{ state: 'idle' | 'testing' | 'ok' | 'fail'; error?: string }>({ state: 'idle' });
  // 社交通讯
  const [channels, setChannels] = useState<string[]>([]);
  const [chModal, setChModal] = useState<ChannelKey | null>(null);
  const [chForm, setChForm] = useState<Record<string, string>>({});
  const [chTest, setChTest] = useState<{ state: 'idle' | 'testing' | 'ok' | 'fail'; error?: string }>({ state: 'idle' });
  const [chSending, setChSending] = useState(false);
  const [chSendTip, setChSendTip] = useState('');
  // 数据
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [wipeModal, setWipeModal] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [wipeError, setWipeError] = useState('');

  const flashSaved = () => {
    setSavedTip(t('saved'));
    setSaveError('');
    setTimeout(() => setSavedTip(''), 2000);
  };

  // P0-7：保存失败必须显式提示，禁止静默「已保存」误报
  const flashSaveError = (error: unknown) => {
    const message = error instanceof Error && error.message ? error.message : '';
    setSaveError(message || t('saveFail'));
    setSavedTip('');
    setTimeout(() => setSaveError(''), 4000);
  };

  const safeFetchJson = useCallback(async (url: string) => {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const text = await res.text();
      if (!text || !text.trim()) return null;
      return JSON.parse(text);
    } catch {
      return null;
    }
  }, []);

  const loadSettings = useCallback(async () => {
    const data = await safeFetchJson('/api/settings');
    if (!data) return;
    setSettings(data);
    setAssign({ agent: 'auto', content: 'auto', rag: 'auto', light: 'auto', ...(data.model_assign ?? {}) });
  }, [safeFetchJson]);

  const loadProviders = useCallback(async () => {
    const data = await safeFetchJson('/api/settings/models');
    setProviders(data?.connections ?? []);
  }, [safeFetchJson]);

  const loadRouteInfo = useCallback(async () => {
    const data = await safeFetchJson('/api/settings/models/route-info');
    setRouteInfo(data?.routes ?? {});
  }, [safeFetchJson]);

  const loadAccounts = useCallback(async () => {
    const data = await safeFetchJson('/api/settings/email-accounts');
    setAccounts(data?.accounts ?? []);
  }, [safeFetchJson]);

  const loadIntegrations = useCallback(async () => {
    const data = await safeFetchJson('/api/integrations');
    setIntegrations(data?.integrations ?? []);
  }, [safeFetchJson]);

  const loadChannels = useCallback(async () => {
    const data = await safeFetchJson('/api/channels');
    setChannels(data?.channels ?? []);
  }, [safeFetchJson]);

  const loadCounts = useCallback(async () => {
    const data = await safeFetchJson('/api/settings/overview');
    setCounts(data?.counts ?? {});
  }, [safeFetchJson]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (group === 'models') {
      loadProviders();
      loadRouteInfo();
    }
    if (group === 'mailbox') loadAccounts();
    if (group === 'integrations') loadIntegrations();
    if (group === 'channels') loadChannels();
    if (group === 'data') loadCounts();
  }, [group, loadProviders, loadRouteInfo, loadAccounts, loadIntegrations, loadChannels, loadCounts]);

  const saveSection = async (key: string, value: unknown) => {
    try {
      await saveJson('/api/settings', {
        method: 'PUT',
        body: { [key]: value },
      });
      flashSaved();
    } catch (error) {
      flashSaveError(error);
    }
  };

  // 模型配置
  const openModelModal = (p: Provider) => {
    setModelModal(p);
    const conn = p.connection;
    setModelForm({
      apiKey: '',
      baseUrl: conn?.baseUrl ?? p.defaultBaseUrl ?? '',
      defaultModel: conn?.defaultModel ?? p.catalogModels[0]?.id ?? '',
      displayName: conn?.displayName ?? '',
      timeoutMs: conn?.timeoutMs != null ? String(conn.timeoutMs) : '',
      maxRetries: conn?.maxRetries != null ? String(conn.maxRetries) : '',
      optInLocal: conn?.optInLocal ?? p.category === 'local',
    });
    setModelTest({ state: 'idle' });
  };

  const testModel = async () => {
    if (!modelModal) return;
    setModelTest({ state: 'testing' });
    try {
      const res = await fetch('/api/settings/models/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: modelModal.id,
          // apiKey 缺省时服务端使用已保存密钥重新测试，不重发旧密钥
          apiKey: modelForm.apiKey || undefined,
          baseUrl: modelForm.baseUrl,
          model: modelForm.defaultModel,
        }),
      });
      const data = await res.json().catch(() => null);
      setModelTest(data?.ok ? { state: 'ok', models: data.models ?? null } : { state: 'fail', error: data?.error ?? 'Test request failed' });
    } catch {
      setModelTest({ state: 'fail', error: 'Network error' });
    }
  };

  const saveModel = async () => {
    if (!modelModal) return;
    setModelSaving(true);
    try {
      await saveJson('/api/settings/models', {
        method: 'POST',
        body: {
          provider: modelModal.id,
          apiKey: modelForm.apiKey || undefined,
          baseUrl: modelForm.baseUrl,
          defaultModel: modelForm.defaultModel,
          displayName: modelForm.displayName || undefined,
          timeoutMs: modelForm.timeoutMs ? Number(modelForm.timeoutMs) : undefined,
          maxRetries: modelForm.maxRetries ? Number(modelForm.maxRetries) : undefined,
          optInLocal: modelForm.optInLocal,
        },
      });
      setModelModal(null);
      await loadProviders();
      await loadRouteInfo();
      flashSaved();
    } catch (error) {
      flashSaveError(error);
    } finally {
      setModelSaving(false);
    }
  };

  const removeModel = async (provider: string) => {
    try {
      await saveJson(`/api/settings/models?provider=${provider}`, { method: 'DELETE' });
      setModelModal(null);
      await loadProviders();
      await loadRouteInfo();
    } catch (error) {
      flashSaveError(error);
    }
  };

  // 邮箱
  const saveMailbox = async () => {
    setMailSaving(true);
    try {
      await saveJson('/api/settings/email-accounts', {
        method: 'POST',
        body: {
          provider: mailType === 'smtp' ? 'smtp' : mailType,
          email: mailForm.email,
          displayName: mailForm.displayName || null,
          smtpHost: mailForm.smtpHost || (mailType === 'gmail' ? 'smtp.gmail.com' : mailType === 'outlook' ? 'smtp.office365.com' : null),
          // Phase 16 任务 4：端口不再统一默认 465。Office 365 **不接受** implicit TLS
          // 的 465，只接受 587 + STARTTLS —— 原先的 465 会让 Outlook 账号永远发不出去。
          // 具体端口由 smtpHost 对应的服务商决定（见 lib/email/eligibility 的 SMTP_PRESETS）。
          smtpPort: Number(mailForm.smtpPort) || SMTP_PRESETS.outlook.port,
          imapHost: mailForm.imapHost || (mailType === 'gmail' ? 'imap.gmail.com' : mailType === 'outlook' ? 'outlook.office365.com' : null),
          imapPort: Number(mailForm.imapPort) || 993,
          smtpPass: mailForm.pass,
          isDefault: accounts.length === 0,
        },
      });
      setMailModal(false);
      setMailForm({ email: '', displayName: '', smtpHost: '', smtpPort: String(SMTP_PRESETS.outlook.port), imapHost: '', imapPort: '993', pass: '' });
      await loadAccounts();
      flashSaved();
    } catch (error) {
      flashSaveError(error);
    } finally {
      setMailSaving(false);
    }
  };

  const deleteMailbox = async (id: string) => {
    try {
      await saveJson(`/api/settings/email-accounts?id=${id}`, { method: 'DELETE' });
      await loadAccounts();
    } catch (error) {
      flashSaveError(error);
    }
  };

  // 集成
  const saveIntegration = async (provider: string, config: Record<string, unknown>, syncScope: string[]) => {
    try {
      await saveJson('/api/integrations', {
        method: 'POST',
        body: { provider, config, syncScope },
      });
      setErpModal(false);
      setIntModal(null);
      await loadIntegrations();
      flashSaved();
    } catch (error) {
      flashSaveError(error);
    }
  };

  const disconnectIntegration = async (provider: string) => {
    try {
      await saveJson(`/api/integrations?provider=${provider}`, { method: 'DELETE' });
      await loadIntegrations();
    } catch (error) {
      flashSaveError(error);
    }
  };

  const testIntegration = async (provider: string, config: Record<string, unknown>, setter: typeof setErpTest) => {
    setter({ state: 'testing' });
    try {
      const res = await fetch('/api/integrations/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, config }),
      });
      const data = await res.json().catch(() => null);
      setter(data?.ok ? { state: 'ok' } : { state: 'fail', error: data?.error ?? 'Test failed' });
    } catch {
      setter({ state: 'fail', error: 'Network error' });
    }
  };

  // 社交通讯
  const saveChannel = async (provider: string, config: Record<string, string>) => {
    try {
      await saveJson('/api/channels', {
        method: 'POST',
        body: { provider, config },
      });
      setChModal(null);
      await loadChannels();
      flashSaved();
    } catch (error) {
      flashSaveError(error);
    }
  };

  const disconnectChannel = async (provider: string) => {
    try {
      await saveJson(`/api/channels?provider=${provider}`, { method: 'DELETE' });
      await loadChannels();
    } catch (error) {
      flashSaveError(error);
    }
  };

  const testChannel = async (provider: string, config: Record<string, unknown>) => {
    setChTest({ state: 'testing' });
    try {
      const res = await fetch('/api/channels/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, config }),
      });
      const data = await res.json().catch(() => null);
      setChTest(data?.ok ? { state: 'ok' } : { state: 'fail', error: data?.error ?? 'Test failed' });
    } catch {
      setChTest({ state: 'fail', error: 'Network error' });
    }
  };

  const sendBriefing = async (provider?: string) => {
    setChSending(true);
    setChSendTip('');
    try {
      const res = await fetch('/api/channels/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(provider ? { provider, text: t('testMessage') } : {}),
      });
      const data = await res.json().catch(() => null);
      setChSendTip(data?.ok ? t('briefingSent', { count: data.sent?.length ?? 0 }) : (data?.error ?? t('sendFail')));
    } catch {
      setChSendTip(t('sendFail'));
    } finally {
      setChSending(false);
    }
  };

  const wipeData = async () => {
    setWiping(true);
    try {
      // P0-6：两步清空 —— 先取服务端一次性确认令牌，再带令牌执行 DELETE；
      // 失败不误报成功。
      const tokenRes = await fetch('/api/settings/wipe');
      if (!tokenRes.ok) {
        setWipeError(t('wipeFail'));
        return;
      }
      const tokenData = await tokenRes.json().catch(() => null);
      const token = tokenData?.token;
      if (typeof token !== 'string' || !token) {
        setWipeError(t('wipeFail'));
        return;
      }
      const res = await fetch('/api/settings/wipe', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setWipeError(data?.error ?? t('wipeFail'));
        return;
      }
      setWipeModal(false);
      await loadCounts();
    } catch {
      setWipeError(t('wipeFail'));
    } finally {
      setWiping(false);
    }
  };

  // Phase 15：已配置 ≠ 可用。
  // 此前只看 `status === 'connected'`，而 connectIntegration 对**任何** provider
  // 都写 'connected' —— 于是 ERPNext 填完地址就显示"已连接"，
  // 尽管它的同步端点根本没有实现（数据永远不会到达）。
  // 现在"已配置"与"数据真的会同步"分开表达：`erpConfigured` 控制是否展示配置面板，
  // `erp`（要求 syncable）控制是否声称数据在同步。
  const isConfigured = (i: Integration) => i.status === 'connected' || i.status === 'connectivity_only';
  const erpConfigured = integrations.find((i) => i.provider === 'erpnext' && isConfigured(i));
  const erp = erpConfigured && erpConfigured.syncable ? erpConfigured : undefined;
  const getInt = (p: string) => integrations.find((i) => i.provider === p && isConfigured(i));

  const groups: { key: Group; icon: typeof Store; label: string }[] = [
    { key: 'business', icon: Store, label: t('groupBusiness') },
    { key: 'locale', icon: Languages, label: t('groupLocale') },
    { key: 'appearance', icon: Palette, label: t('groupAppearance') },
    { key: 'models', icon: KeyRound, label: t('groupModels') },
    { key: 'mailbox', icon: Inbox, label: t('groupMailbox') },
    { key: 'integrations', icon: Blocks, label: t('groupIntegrations') },
    { key: 'channels', icon: MessageCircle, label: t('groupChannels') },
    { key: 'ai', icon: SlidersHorizontal, label: t('groupAi') },
    { key: 'data', icon: Database, label: t('groupData') },
  ];

  const biz = settings?.business ?? {};
  const loc = settings?.locale ?? {};
  const aiPrefs = (settings?.ai_prefs ?? {}) as Record<string, unknown>;
  const enabledProviders = providers.filter((p) => p.connection?.isEnabled);

  const assignOptions = (cap: string) => (
    <>
      <option value="auto">{t('autoMode')}</option>
      <option value="platform">{t('builtin')}</option>
      {enabledProviders.map((p) => (
        <option key={p.id} value={`${p.id}:${p.connection?.defaultModel ?? ''}`}>
          {p.displayName}{p.connection?.defaultModel ? ` · ${p.connection.defaultModel}` : ''}
        </option>
      ))}
      {!enabledProviders.length && cap === 'agent' && <option disabled>—</option>}
    </>
  );

  const filteredProviders = providers.filter((p) => {
    const q = providerSearch.trim().toLowerCase();
    if (!q) return true;
    return p.displayName.toLowerCase().includes(q) || p.id.includes(q) || p.protocol.includes(q) || p.category.includes(q);
  });

  return (
    <main className="flex-1 min-w-0 overflow-y-auto bg-background p-6">
      <div className="mb-6 flex items-center justify-between max-w-4xl">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-on-surface-variant mt-1">{t('subtitle')}</p>
        </div>
        {savedTip && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success bg-success/10 px-3 py-1.5 rounded-md">
            <CircleCheck className="w-3.5 h-3.5" />
            {savedTip}
          </span>
        )}
        {saveError && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-error bg-error/10 px-3 py-1.5 rounded-md">
            <CircleX className="w-3.5 h-3.5" />
            {saveError}
          </span>
        )}
      </div>

      <div className="grid grid-cols-[11rem_1fr] gap-6 items-start max-w-4xl">
        {/* 左侧分组菜单 */}
        <div className="space-y-0.5">
          {groups.map((g) => (
            <button
              key={g.key}
              onClick={() => setGroup(g.key)}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                group === g.key
                  ? 'bg-primary/10 text-primary'
                  : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
              }`}
            >
              <g.icon className="w-4 h-4" />
              {g.label}
            </button>
          ))}
        </div>

        {/* 右侧设置面板 */}
        <div className="space-y-4">
          {/* 业务信息 */}
          {group === 'business' && (
            <div className="bg-surface rounded-lg shadow-card p-6">
              <h2 className="text-base font-semibold mb-1">{t('groupBusiness')}</h2>
              <p className="text-xs text-on-surface-variant mb-5">{t('businessNote')}</p>
              <div className="space-y-4">
                <div>
                  <label className={labelCls}>{t('businessName')}</label>
                  <input type="text" value={biz.name ?? ''} onChange={(e) => setSettings((s) => s && { ...s, business: { ...s.business, name: e.target.value } })} className={inputCls} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls}>{t('industry')}</label>
                    <select value={biz.industry ?? 'restaurant'} onChange={(e) => setSettings((s) => s && { ...s, business: { ...s.business, industry: e.target.value } })} className={selectCls}>
                      <option value="restaurant">{t('industries.restaurant')}</option>
                      <option value="fastfood">{t('industries.fastfood')}</option>
                      <option value="cafe">{t('industries.cafe')}</option>
                      <option value="retail">{t('industries.retail')}</option>
                      <option value="service">{t('industries.service')}</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>{t('size')}</label>
                    <select value={biz.size ?? '10-30'} onChange={(e) => setSettings((s) => s && { ...s, business: { ...s.business, size: e.target.value } })} className={selectCls}>
                      <option value="1-10">{t('sizes.s1')}</option>
                      <option value="10-30">{t('sizes.s2')}</option>
                      <option value="30-100">{t('sizes.s3')}</option>
                      <option value="chain">{t('sizes.chain')}</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className={labelCls}>{t('hours')}</label>
                  <input type="text" value={biz.hours ?? ''} onChange={(e) => setSettings((s) => s && { ...s, business: { ...s.business, hours: e.target.value } })} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>{t('intro')}</label>
                  <textarea rows={3} value={biz.intro ?? ''} onChange={(e) => setSettings((s) => s && { ...s, business: { ...s.business, intro: e.target.value } })} className={`${inputCls} resize-none`} />
                </div>
                <div className="flex justify-end">
                  <button onClick={() => saveSection('business', biz)} className={primaryBtn}>{tc('save')}</button>
                </div>
              </div>
            </div>
          )}

          {/* 语言与地区 */}
          {group === 'locale' && (
            <div className="bg-surface rounded-lg shadow-card p-6">
              <h2 className="text-base font-semibold mb-1">{t('groupLocale')}</h2>
              <p className="text-xs text-on-surface-variant mb-5">{t('localeNote')}</p>
              <div className="space-y-5">
                <div>
                  <label className={`${labelCls} mb-2`}>{t('language')}</label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['en', 'zh', 'es'] as const).map((l) => (
                      <button
                        key={l}
                        onClick={() => {
                          saveSection('locale', { ...loc, language: l });
                          if (l !== locale) router.replace(pathname, { locale: l });
                        }}
                        className={`rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${
                          locale === l ? 'bg-primary/10 text-primary' : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
                        }`}
                      >
                        {t(`languages.${l}`)}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-on-surface-variant/70 mt-1.5">{t('languageNote')}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls}>{t('currency')}</label>
                    <select value={loc.currency ?? 'USD'} onChange={(e) => setSettings((s) => s && { ...s, locale: { ...s.locale, currency: e.target.value } })} className={selectCls}>
                      <option value="USD">USD — US Dollar ($)</option>
                      <option value="EUR">EUR — Euro (€)</option>
                      <option value="GBP">GBP — British Pound (£)</option>
                      <option value="CNY">CNY — Chinese Yuan (¥)</option>
                      <option value="JPY">JPY — Japanese Yen (JP¥)</option>
                      <option value="AUD">AUD — Australian Dollar (A$)</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>{t('timezone')}</label>
                    <select value={loc.timezone ?? 'America/New_York'} onChange={(e) => setSettings((s) => s && { ...s, locale: { ...s.locale, timezone: e.target.value } })} className={selectCls}>
                      <option value="America/Los_Angeles">UTC-8 Pacific (Los Angeles)</option>
                      <option value="America/New_York">UTC-5 Eastern (New York)</option>
                      <option value="Europe/London">UTC+0 London</option>
                      <option value="Europe/Berlin">UTC+1 Berlin / Paris</option>
                      <option value="Asia/Shanghai">UTC+8 Beijing / Singapore</option>
                      <option value="Asia/Tokyo">UTC+9 Tokyo</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className={labelCls}>{t('aiReplyLang')}</label>
                  <select value={loc.ai_reply_language ?? 'follow_customer'} onChange={(e) => setSettings((s) => s && { ...s, locale: { ...s.locale, ai_reply_language: e.target.value } })} className={selectCls}>
                    <option value="follow_customer">{t('followCustomer')}</option>
                    <option value="ui_language">{t('fixedUi')}</option>
                    <option value="english">{t('fixedEnglish')}</option>
                  </select>
                  <p className="text-xs text-on-surface-variant/70 mt-1.5">{t('aiReplyLangNote')}</p>
                </div>
                <div className="flex justify-end">
                  <button onClick={() => saveSection('locale', loc)} className={primaryBtn}>{t('saveLocale')}</button>
                </div>
              </div>
            </div>
          )}

          {/* 外观：Day / Night / System（本地时间自动切换，手动优先） */}
          {group === 'appearance' && (
            <div className="bg-surface rounded-lg shadow-card p-6">
              <h2 className="text-base font-semibold mb-1">{t('groupAppearance')}</h2>
              <p className="text-xs text-on-surface-variant mb-5">{t('appearanceNote')}</p>
              <div className="grid grid-cols-3 gap-3">
                {([
                  { value: 'light', label: t('themeLight'), desc: t('themeLightDesc'), icon: Sun },
                  { value: 'dark', label: t('themeDark'), desc: t('themeDarkDesc'), icon: Moon },
                  { value: 'system', label: t('themeSystem'), desc: t('themeSystemDesc'), icon: Monitor },
                ] as { value: ThemeMode; label: string; desc: string; icon: typeof Sun }[]).map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setThemeMode(opt.value)}
                    aria-pressed={themeMode === opt.value}
                    className={`rounded-xl p-4 text-left border transition-all ${
                      themeMode === opt.value
                        ? 'border-primary bg-primary/10 shadow-card'
                        : 'border-outline bg-surface-container/60 hover:border-primary/40'
                    }`}
                  >
                    <opt.icon className={`w-5 h-5 mb-2.5 ${themeMode === opt.value ? 'text-primary' : 'text-on-surface-variant'}`} />
                    <div className="text-sm font-semibold">{opt.label}</div>
                    <div className="text-xs text-on-surface-variant mt-1 leading-relaxed">{opt.desc}</div>
                  </button>
                ))}
              </div>
              <p className="text-xs text-on-surface-variant/70 mt-4">
                {t('appearanceNow')}: {themeResolved === 'dark' ? t('themeDark') : t('themeLight')}
              </p>
            </div>
          )}

          {/* AI 模型接入：Provider Connections + Model Routing 两区 */}
          {group === 'models' && (
            <>
              <div className="bg-surface rounded-lg shadow-card p-6">
                <div className="flex items-center justify-between mb-1">
                  <h2 className="text-base font-semibold">{t('groupModels')} · Provider Connections</h2>
                  <input
                    type="search"
                    value={providerSearch}
                    onChange={(e) => setProviderSearch(e.target.value)}
                    placeholder={t('searchProvider')}
                    className="bg-surface-container border-none rounded-md px-3 py-1.5 text-xs text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30 w-48"
                  />
                </div>
                <p className="text-xs text-on-surface-variant mb-5">{t('modelsNote')}</p>
                <div className="grid grid-cols-2 gap-3">
                  {filteredProviders.map((p) => {
                    const conn = p.connection;
                    const enabled = conn?.isEnabled ?? false;
                    const models = conn?.modelsCache ?? p.catalogModels.map((m) => m.id);
                    return (
                      <div key={p.id} className={`rounded-md bg-surface-container/60 p-4 ${p.id === 'custom' ? 'col-span-2' : ''}`}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2.5">
                            <span className={`w-9 h-9 rounded-md flex items-center justify-center text-sm font-bold ${enabled ? 'bg-primary/10 text-primary' : 'bg-surface-container-high text-on-surface'}`}>
                              {PROVIDER_INITIALS[p.id] || <Plug className="w-4 h-4" />}
                            </span>
                            <div>
                              <p className="text-sm font-semibold">{conn?.displayName || p.displayName}</p>
                              <p className="text-xs text-on-surface-variant">
                                {models.slice(0, 2).join(' · ') || t('customModels')}
                              </p>
                            </div>
                          </div>
                          <StatusBadge connected={enabled} connectedText={tc('connected')} disconnectedText={tc('notConfigured')} />
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap mt-1">
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant font-mono">{p.protocol}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant font-mono">{p.authType}</span>
                          {p.runtime === 'declared' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning font-medium">{t('adapterPending')}</span>
                          )}
                          {conn?.lastTestOk === true && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/15 text-success font-medium">{t('testOk')}</span>
                          )}
                          {conn?.lastTestOk === false && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-error/15 text-error font-medium" title={conn.lastTestError ?? ''}>
                              {t('testFailedBadge')}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center justify-between mt-3">
                          <span className={`text-xs font-mono ${enabled ? 'text-on-surface-variant' : 'text-on-surface-variant/60'}`}>
                            {enabled ? conn?.maskedKey || '—' : t('noApiKey')}
                          </span>
                          <button onClick={() => openModelModal(p)} className="text-xs font-medium text-primary hover:underline">
                            {enabled ? tc('manage') : tc('configure')}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 模型分配（Model Routing） */}
              <div className="bg-surface rounded-lg shadow-card p-6">
                <h2 className="text-base font-semibold mb-1">{t('modelAssign')} · Model Routing</h2>
                <p className="text-xs text-on-surface-variant mb-5">{t('modelAssignNote')}</p>
                <div className="space-y-4">
                  {(['agent', 'content', 'rag', 'light'] as const).map((cap) => {
                    const route = routeInfo[cap];
                    return (
                      <div key={cap} className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{t(`cap.${cap}`)}</p>
                          <p className="text-xs text-on-surface-variant mt-0.5">{t(`capNote.${cap}`)}</p>
                          {route && (
                            <p className="text-[11px] font-mono mt-1 truncate text-on-surface-variant/80">
                              {route.error
                                ? `⚠ ${route.error}`
                                : `→ ${route.provider ?? '?'} / ${route.model ?? '?'}${route.usedFallback ? ` (${t('fallbackActive')}: ${route.fallbackReason ?? ''})` : ''}`}
                            </p>
                          )}
                        </div>
                        <select
                          value={assign[cap] ?? 'auto'}
                          onChange={(e) => setAssign({ ...assign, [cap]: e.target.value })}
                          className="bg-surface-container border-none rounded-md px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors w-60 shrink-0"
                        >
                          {assignOptions(cap)}
                        </select>
                      </div>
                    );
                  })}
                  <div className="rounded-md bg-primary-container/50 border border-primary/10 p-3.5 flex items-start gap-2.5">
                    <Zap className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                    <p className="text-xs text-on-surface-variant leading-relaxed">{t('autoModeNote')}</p>
                  </div>
                  <div className="flex justify-end">
                    <button onClick={async () => { await saveSection('model_assign', assign); await loadRouteInfo(); }} className={primaryBtn}>{t('saveAssign')}</button>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* 邮箱接入 */}
          {group === 'mailbox' && (
            <>
              <div className="bg-surface rounded-lg shadow-card p-6">
                <div className="flex items-start justify-between mb-1">
                  <h2 className="text-base font-semibold">{t('groupMailbox')}</h2>
                  <button onClick={() => setMailModal(true)} className="bg-primary text-on-primary px-3.5 py-2 rounded-md text-xs font-medium hover:opacity-90 active:scale-[0.98] transition-all flex items-center gap-1.5">
                    <Plus className="w-3.5 h-3.5" />
                    {t('addMailbox')}
                  </button>
                </div>
                <p className="text-xs text-on-surface-variant mb-5">{t('mailboxNote')}</p>
                <div className="space-y-3">
                  {accounts.map((acc) => (
                    <div key={acc.id} className="rounded-lg bg-surface-container/40 p-4 flex items-center gap-4">
                      <div className="w-10 h-10 rounded-md bg-error/10 flex items-center justify-center shrink-0">
                        <Mail className="w-5 h-5 text-error" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold">{acc.email}</p>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/10 text-success font-medium">{tc('connected')}</span>
                          {acc.is_default && <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">{t('defaultAccount')}</span>}
                        </div>
                        <p className="text-xs text-on-surface-variant mt-0.5">
                          {acc.provider === 'smtp' ? `${acc.smtp_host ?? 'SMTP'} · ${t('passwordAuth')}` : `${acc.provider} · OAuth`}
                          {acc.display_name ? ` · ${acc.display_name}` : ''}
                        </p>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button onClick={() => deleteMailbox(acc.id)} className="text-xs text-on-surface-variant hover:text-error px-2.5 py-1.5 rounded-md hover:bg-surface-container transition-colors">
                          {tc('delete')}
                        </button>
                      </div>
                    </div>
                  ))}
                  {accounts.length === 0 && (
                    <p className="text-sm text-on-surface-variant text-center py-4">{tc('noData')}</p>
                  )}
                  {/* 未接入提示卡 */}
                  {!accounts.some((a) => a.provider === 'gmail') && (
                    <div className="rounded-lg bg-surface-container/40 p-4 flex items-center gap-4">
                      <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                        <Mail className="w-5 h-5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-on-surface-variant">Gmail / Google Workspace</p>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-container-highest text-on-surface-variant font-medium">{tc('notConfigured')}</span>
                        </div>
                        <p className="text-xs text-on-surface-variant mt-0.5">{t('gmailNote')}</p>
                      </div>
                      <button onClick={() => { setMailType('gmail'); setMailModal(true); }} className="shrink-0 text-xs font-medium text-primary px-3 py-1.5 rounded-md bg-primary/10 hover:bg-primary/20 transition-colors">
                        {t('connect')}
                      </button>
                    </div>
                  )}
                  {!accounts.some((a) => a.provider === 'outlook') && (
                    <div className="rounded-lg bg-surface-container/40 p-4 flex items-center gap-4">
                      <div className="w-10 h-10 rounded-md bg-warning/10 flex items-center justify-center shrink-0">
                        <Server className="w-5 h-5 text-warning" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-on-surface-variant">Outlook / Microsoft 365</p>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-container-highest text-on-surface-variant font-medium">{tc('notConfigured')}</span>
                        </div>
                        <p className="text-xs text-on-surface-variant mt-0.5">{t('outlookNote')}</p>
                      </div>
                      <button onClick={() => { setMailType('outlook'); setMailModal(true); }} className="shrink-0 text-xs font-medium text-primary px-3 py-1.5 rounded-md bg-primary/10 hover:bg-primary/20 transition-colors">
                        {t('connect')}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* 发送与自动化 */}
              <div className="bg-surface rounded-lg shadow-card p-6">
                <h3 className="text-sm font-semibold mb-1">{t('automation')}</h3>
                <p className="text-xs text-on-surface-variant mb-5">{t('automationNote')}</p>
                <div className="space-y-5">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls}>{t('dailyLimit')}</label>
                      <select value={(aiPrefs.daily_limit as string) ?? '100'} onChange={(e) => setSettings((s) => s && { ...s, ai_prefs: { ...s.ai_prefs, daily_limit: e.target.value } })} className={selectCls}>
                        <option value="50">50 / {t('perDay')}</option>
                        <option value="100">100 / {t('perDay')}</option>
                        <option value="200">200 / {t('perDay')}</option>
                        <option value="unlimited">{t('unlimited')}</option>
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>{t('sendInterval')}</label>
                      <select value={(aiPrefs.send_interval as string) ?? '60'} onChange={(e) => setSettings((s) => s && { ...s, ai_prefs: { ...s.ai_prefs, send_interval: e.target.value } })} className={selectCls}>
                        <option value="30">{t('intervalSec', { sec: 30 })}</option>
                        <option value="60">{t('intervalSec', { sec: 60 })}</option>
                        <option value="120">{t('intervalSec', { sec: 120 })}</option>
                      </select>
                    </div>
                  </div>
                  <div className="flex items-center justify-between py-1">
                    <div>
                      <p className="text-sm font-medium">{t('autoReply')}</p>
                      <p className="text-xs text-on-surface-variant mt-0.5">{t('autoReplyNote')}</p>
                    </div>
                    <Toggle on={Boolean(aiPrefs.auto_email_reply)} onChange={(v) => setSettings((s) => s && { ...s, ai_prefs: { ...s.ai_prefs, auto_email_reply: v } })} />
                  </div>
                  <div className="flex items-center justify-between py-1">
                    <div>
                      <p className="text-sm font-medium">{t('alertEmails')}</p>
                      <p className="text-xs text-on-surface-variant mt-0.5">{t('alertEmailsNote')}</p>
                    </div>
                    <Toggle on={aiPrefs.alert_emails !== false} onChange={(v) => setSettings((s) => s && { ...s, ai_prefs: { ...s.ai_prefs, alert_emails: v } })} />
                  </div>
                  <div className="flex items-center justify-between py-1">
                    <div>
                      <p className="text-sm font-medium">{t('briefingEmails')}</p>
                      <p className="text-xs text-on-surface-variant mt-0.5">{t('briefingEmailsNote')}</p>
                    </div>
                    <Toggle on={aiPrefs.briefing_emails !== false} onChange={(v) => setSettings((s) => s && { ...s, ai_prefs: { ...s.ai_prefs, briefing_emails: v } })} />
                  </div>
                  <div>
                    <label className={labelCls}>{t('signature')}</label>
                    <textarea rows={3} value={(aiPrefs.signature as string) ?? ''} onChange={(e) => setSettings((s) => s && { ...s, ai_prefs: { ...s.ai_prefs, signature: e.target.value } })} className={`${inputCls} resize-none`} />
                    <p className="text-xs text-on-surface-variant mt-1.5">{t('signatureNote')}</p>
                  </div>
                  <div className="flex justify-end">
                    <button onClick={() => saveSection('ai_prefs', aiPrefs)} className={primaryBtn}>{tc('save')}</button>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* 系统集成 */}
          {group === 'integrations' && (
            <div className="bg-surface rounded-lg shadow-card p-6">
              <h2 className="text-base font-semibold mb-1">{t('groupIntegrations')}</h2>
              <p className="text-xs text-on-surface-variant mb-5">{t('integrationsNote')}</p>

              {/* ERPNext */}
              <div className="rounded-md bg-surface-container/60 p-5 mb-3">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <span className="w-10 h-10 rounded-md bg-primary/10 text-primary flex items-center justify-center">
                      <Factory className="w-5 h-5" />
                    </span>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold">ERPNext</p>
                        {/* Phase 15：不可同步时不得显示 "Connected"。
                            徽章文案由 syncable 决定，与后端能力表同一事实源。 */}
                        <StatusBadge
                          connected={Boolean(erp)}
                          connectedText={tc('connected')}
                          disconnectedText={erpConfigured ? t('connectivityOnly') : tc('notConfigured')}
                        />
                      </div>
                      <p className="text-xs text-on-surface-variant mt-0.5">{t('erpNote')}</p>
                    </div>
                  </div>
                  <button onClick={() => setErpModal(true)} className="text-sm text-primary font-medium hover:underline">
                    {erpConfigured ? tc('manage') : tc('configure')}
                  </button>
                </div>
                {/* 已配置但不可同步：明确说明数据不会从此系统同步过来。
                    库存在这种情况下显示的是本地数据 —— 不能让老板以为是 ERP 的库存。 */}
                {erpConfigured && !erp && (
                  <p className="text-xs rounded-md bg-surface-container-high text-on-surface-variant p-3 mb-4">
                    {t('erpConnectivityOnlyNotice')}
                  </p>
                )}
                {erp && (
                  <>
                    <div className="grid grid-cols-4 gap-3 mb-4">
                      <div className="rounded-md bg-surface p-3">
                        <p className="text-xs text-on-surface-variant">{t('erpItems')}</p>
                        <p className="text-sm font-bold mt-0.5">{t('itemCount', { count: erp.recordCount })}</p>
                      </div>
                      <div className="rounded-md bg-surface p-3">
                        <p className="text-xs text-on-surface-variant">{t('syncScope')}</p>
                        <p className="text-sm font-bold mt-0.5">{erp.sync_scope.length}</p>
                      </div>
                      <div className="rounded-md bg-surface p-3 col-span-2">
                        <p className="text-xs text-on-surface-variant">{t('lastSync')}</p>
                        <p className="text-sm font-bold mt-0.5">{erp.last_sync_at ? fmtDateTime(erp.last_sync_at, locale) : '—'}</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 mb-4">
                      {ERP_SCOPES.map((scope) => (
                        <span key={scope} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface text-xs ${erp.sync_scope.includes(scope) ? '' : 'text-on-surface-variant'}`}>
                          {erp.sync_scope.includes(scope) ? <Check className="w-3 h-3 text-success" /> : <Minus className="w-3 h-3" />}
                          {t(`erpScopes.${scope}`)}
                        </span>
                      ))}
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-on-surface-variant inline-flex items-center gap-1.5">
                        <ShieldCheck className="w-3.5 h-3.5 text-success" />
                        {t('keyEncrypted')}
                      </p>
                      <button onClick={() => disconnectIntegration('erpnext')} className="text-sm text-error font-medium hover:underline">
                        {t('disconnect')}
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* 业务系统 */}
              <p className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide mt-6 mb-3">{t('bizSystems')}</p>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-5">
                {(['square', 'shopify'] as const).map((pid) => {
                  const conn = getInt(pid);
                  return (
                    <div key={pid} className="rounded-md bg-surface-container/60 p-5">
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <span className={`w-10 h-10 rounded-md flex items-center justify-center ${pid === 'square' ? 'bg-on-surface/10 text-on-surface' : 'bg-[#95BF47]/15 text-[#5E8E3E]'}`}>
                            {pid === 'square' ? <Square className="w-5 h-5" /> : <ShoppingBag className="w-5 h-5" />}
                          </span>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-semibold">{pid === 'square' ? 'Square POS' : 'Shopify'}</p>
                              <StatusBadge connected={Boolean(conn)} connectedText={tc('connected')} disconnectedText={tc('notConfigured')} />
                            </div>
                            <p className="text-xs text-on-surface-variant mt-0.5">{t(`${pid}Note`)}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          {pid === 'square' && (
                            <button
                              onClick={() => { window.location.href = '/api/integrations/square/oauth/start'; }}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-on-surface text-white text-xs font-medium hover:opacity-90"
                            >
                              <Square className="w-3 h-3" /> {t('connectWithSquare')}
                            </button>
                          )}
                          <button onClick={() => { setIntModal(pid); setIntForm({}); setIntTest({ state: 'idle' }); }} className="text-sm text-primary font-medium hover:underline">
                            {conn ? tc('manage') : tc('configure')}
                          </button>
                        </div>
                      </div>
                      {conn ? (
                        <div className="flex flex-wrap gap-2">
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface text-xs">
                            <Check className="w-3 h-3 text-success" />
                            {t('syncedOrders', { count: conn.recordCount })}
                          </span>
                          <button onClick={() => disconnectIntegration(pid)} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface text-xs text-error">
                            {t('disconnect')}
                          </button>
                        </div>
                      ) : (
                        <p className="text-xs text-on-surface-variant">{t(`${pid}Hint`)}</p>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* 支付渠道 */}
              <p className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide mb-3">{t('payments')}</p>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-5">
                {(['stripe', 'paypal'] as const).map((pid) => {
                  const conn = getInt(pid);
                  return (
                    <div key={pid} className="rounded-md bg-surface-container/60 p-5">
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <span className={`w-10 h-10 rounded-md flex items-center justify-center ${pid === 'stripe' ? 'bg-[#635BFF]/10 text-[#635BFF]' : 'bg-[#003087]/10 text-[#003087]'}`}>
                            {pid === 'stripe' ? <CreditCard className="w-5 h-5" /> : <Wallet className="w-5 h-5" />}
                          </span>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-semibold">{pid === 'stripe' ? 'Stripe' : 'PayPal'}</p>
                              <StatusBadge connected={Boolean(conn)} connectedText={tc('connected')} disconnectedText={tc('notConfigured')} />
                            </div>
                            <p className="text-xs text-on-surface-variant mt-0.5">{t(`${pid}Note`)}</p>
                          </div>
                        </div>
                        <button onClick={() => { setIntModal(pid); setIntForm({}); setIntTest({ state: 'idle' }); }} className="text-sm text-primary font-medium hover:underline">
                          {conn ? tc('manage') : tc('configure')}
                        </button>
                      </div>
                      {conn ? (
                        <div className="flex flex-wrap gap-2">
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface text-xs">
                            <Check className="w-3 h-3 text-success" />
                            {t('paymentsActive')}
                          </span>
                          <button onClick={() => disconnectIntegration(pid)} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface text-xs text-error">
                            {t('disconnect')}
                          </button>
                        </div>
                      ) : (
                        <p className="text-xs text-on-surface-variant">{t(`${pid}Hint`)}</p>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="rounded-md border border-dashed border-outline-variant/40 p-5 text-center">
                <p className="text-sm text-on-surface-variant">{t('comingSoon')}</p>
                <p className="text-xs text-on-surface-variant/70 mt-1">{t('comingSoonNote')}</p>
              </div>
            </div>
          )}

          {/* 社交通讯 */}
          {group === 'channels' && (
            <div className="bg-surface rounded-lg shadow-card p-6">
              <h2 className="text-base font-semibold mb-1">{t('groupChannels')}</h2>
              <p className="text-xs text-on-surface-variant mb-5">{t('channelsNote')}</p>

              <div className="rounded-md bg-surface-container/60 p-5 mb-6">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="w-10 h-10 rounded-md bg-primary/10 text-primary flex items-center justify-center">
                      <Send className="w-5 h-5" />
                    </span>
                    <div>
                      <p className="text-sm font-semibold">{t('pushBriefing')}</p>
                      <p className="text-xs text-on-surface-variant mt-0.5">{t('pushBriefingNote')}</p>
                    </div>
                  </div>
                  <button onClick={() => sendBriefing()} disabled={chSending || channels.length === 0} className={`${primaryBtn} shrink-0`}>
                    {chSending ? tc('loading') : t('pushNow')}
                  </button>
                </div>
                {chSendTip && <p className="text-xs text-on-surface-variant mt-3">{chSendTip}</p>}
              </div>

              <div className="rounded-md bg-surface-container/60 p-5 mb-6">
                <div className="flex items-center gap-3 mb-4">
                  <span className="w-10 h-10 rounded-md bg-primary/10 text-primary flex items-center justify-center">
                    <RefreshCw className="w-5 h-5" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold">{t('autoPush')}</p>
                    <p className="text-xs text-on-surface-variant mt-0.5">{t('autoPushNote')}</p>
                  </div>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div>
                    <label className={labelCls}>{t('briefingTime')}</label>
                    <input
                      type="time"
                      value={(aiPrefs.channel_briefing_time as string) ?? '08:00'}
                      onChange={(e) => setSettings((s) => s && { ...s, ai_prefs: { ...s.ai_prefs, channel_briefing_time: e.target.value } })}
                      className={inputCls}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">{t('anomalyPush')}</p>
                      <p className="text-xs text-on-surface-variant">{t('anomalyPushNote')}</p>
                    </div>
                    <Toggle on={aiPrefs.channel_anomaly_push !== false} onChange={(v) => setSettings((s) => s && { ...s, ai_prefs: { ...s.ai_prefs, channel_anomaly_push: v } })} />
                  </div>
                </div>
                <div className="mt-4 flex justify-end">
                  <button onClick={() => saveSection('ai_prefs', aiPrefs)} className={primaryBtn}>{tc('save')}</button>
                </div>
              </div>

              <p className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide mb-3">{t('channels')}</p>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {CHANNEL_PRESETS.map((preset) => {
                  const connected = channels.includes(preset.key);
                  return (
                    <div key={preset.key} className="rounded-md bg-surface-container/60 p-5">
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <span className="w-10 h-10 rounded-md bg-on-surface/10 text-on-surface flex items-center justify-center">
                            <MessageCircle className="w-5 h-5" />
                          </span>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-semibold">{CHANNEL_LABELS[preset.key]}</p>
                              <StatusBadge connected={connected} connectedText={tc('connected')} disconnectedText={preset.ready ? tc('notConfigured') : t('soon')} />
                            </div>
                            <p className="text-xs text-on-surface-variant mt-0.5">{t(`channelNote.${preset.key}`)}</p>
                          </div>
                        </div>
                        {preset.ready ? (
                          <button onClick={() => { setChModal(preset.key); setChForm({}); setChTest({ state: 'idle' }); }} className="text-sm text-primary font-medium hover:underline shrink-0">
                            {connected ? tc('manage') : tc('configure')}
                          </button>
                        ) : (
                          <span className="text-xs text-on-surface-variant/60 shrink-0">{t('soon')}</span>
                        )}
                      </div>
                      {connected ? (
                        <div className="flex flex-wrap gap-2">
                          <button onClick={() => sendBriefing(preset.key)} disabled={chSending} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface text-xs hover:bg-surface-container-high transition-colors disabled:opacity-60">
                            <Send className="w-3 h-3" />
                            {t('sendTest')}
                          </button>
                          <button onClick={() => disconnectChannel(preset.key)} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface text-xs text-error">
                            {t('disconnect')}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* AI 偏好 */}
          {group === 'ai' && (
            <div className="bg-surface rounded-lg shadow-card p-6">
              <h2 className="text-base font-semibold mb-1">{t('groupAi')}</h2>
              <p className="text-xs text-on-surface-variant mb-5">{t('aiNote')}</p>
              <div className="space-y-5">
                <div>
                  <label className={`${labelCls} mb-2`}>{t('aiStyle')}</label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['concise', 'professional', 'warm'] as const).map((style) => (
                      <button
                        key={style}
                        onClick={() => setSettings((s) => s && { ...s, ai_prefs: { ...s.ai_prefs, style } })}
                        className={`rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${
                          (aiPrefs.style ?? 'professional') === style ? 'bg-primary/10 text-primary' : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
                        }`}
                      >
                        {t(`styles.${style}`)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between py-1">
                  <div>
                    <p className="text-sm font-medium">{t('autoReviewReply')}</p>
                    <p className="text-xs text-on-surface-variant mt-0.5">{t('autoReviewReplyNote')}</p>
                  </div>
                  <Toggle on={aiPrefs.auto_review_reply !== false} onChange={(v) => setSettings((s) => s && { ...s, ai_prefs: { ...s.ai_prefs, auto_review_reply: v } })} />
                </div>
                <div className="flex items-center justify-between py-1">
                  <div>
                    <p className="text-sm font-medium">{t('churnAlert')}</p>
                    <p className="text-xs text-on-surface-variant mt-0.5">{t('churnAlertNote')}</p>
                  </div>
                  <Toggle on={aiPrefs.churn_alert !== false} onChange={(v) => setSettings((s) => s && { ...s, ai_prefs: { ...s.ai_prefs, churn_alert: v } })} />
                </div>
                <div className="flex items-center justify-between py-1">
                  <div>
                    <p className="text-sm font-medium">{t('dailyBriefing')}</p>
                    <p className="text-xs text-on-surface-variant mt-0.5">{t('dailyBriefingNote')}</p>
                  </div>
                  <Toggle on={Boolean(aiPrefs.daily_briefing)} onChange={(v) => setSettings((s) => s && { ...s, ai_prefs: { ...s.ai_prefs, daily_briefing: v } })} />
                </div>
                <div className="flex justify-end">
                  <button onClick={() => saveSection('ai_prefs', aiPrefs)} className={primaryBtn}>{tc('save')}</button>
                </div>
              </div>
            </div>
          )}

          {/* 数据管理 */}
          {group === 'data' && (
            <div className="bg-surface rounded-lg shadow-card p-6">
              <h2 className="text-base font-semibold mb-1">{t('groupData')}</h2>
              <p className="text-xs text-on-surface-variant mb-5">{t('dataNote')}</p>
              <div className="grid grid-cols-4 gap-3 mb-6">
                {(['products', 'orders', 'customers', 'reviews', 'emails', 'knowledge_docs', 'marketing_contents', 'reservations'] as const).map((tb) => (
                  <div key={tb} className="rounded-md bg-surface-container/60 p-3 text-center">
                    <div className="text-base font-bold">{counts[tb] ?? '—'}</div>
                    <div className="text-xs text-on-surface-variant mt-0.5">{t(`dataTables.${tb}`)}</div>
                  </div>
                ))}
              </div>
              <div className="rounded-md bg-error/5 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-error">{t('wipeData')}</p>
                    <p className="text-xs text-on-surface-variant mt-0.5">{t('wipeWarning')}</p>
                  </div>
                  <button onClick={() => setWipeModal(true)} className="shrink-0 ml-4 bg-error text-on-primary px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all inline-flex items-center gap-2">
                    <Trash2 className="w-3.5 h-3.5" />
                    {t('wipeButton')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 模型配置弹窗 */}
      {modelModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={() => setModelModal(null)}>
          <div className="bg-surface rounded-xl shadow-dialog max-w-md w-full p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-base font-semibold">{t('configProvider', { provider: modelModal.displayName })}</h3>
                <p className="text-[11px] text-on-surface-variant font-mono mt-0.5">
                  {modelModal.protocol} · {modelModal.authType}
                  {modelModal.runtime === 'declared' ? ` · ${t('adapterPending')}` : ''}
                </p>
              </div>
              <button onClick={() => setModelModal(null)} className="w-8 h-8 rounded-md hover:bg-surface-container flex items-center justify-center text-on-surface-variant transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className={labelCls}>{t('displayNameLabel')}</label>
                <input
                  type="text"
                  value={modelForm.displayName}
                  onChange={(e) => setModelForm({ ...modelForm, displayName: e.target.value })}
                  placeholder={modelModal.displayName}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>{t('apiKey')}</label>
                <input
                  type="password"
                  value={modelForm.apiKey}
                  onChange={(e) => setModelForm({ ...modelForm, apiKey: e.target.value })}
                  placeholder={modelModal.connection?.maskedKey || modelModal.keyHint}
                  className={`${inputCls} font-mono`}
                />
                <p className="text-xs text-on-surface-variant/70 mt-1.5">
                  {modelModal.connection?.hasKey ? t('keyKeepExisting') : t('keyEncrypted')}
                </p>
              </div>
              <div>
                <label className={labelCls}>{t('baseUrl')}</label>
                <input type="text" value={modelForm.baseUrl} onChange={(e) => setModelForm({ ...modelForm, baseUrl: e.target.value })} className={`${inputCls} font-mono`} />
              </div>
              <div>
                <label className={labelCls}>{t('defaultModel')}</label>
                {(() => {
                  const modelOptions = Array.from(new Set([
                    ...(modelModal.connection?.modelsCache ?? []),
                    ...modelModal.catalogModels.map((m) => m.id),
                  ]));
                  return modelOptions.length > 0 ? (
                    <select value={modelForm.defaultModel} onChange={(e) => setModelForm({ ...modelForm, defaultModel: e.target.value })} className={selectCls}>
                      {modelOptions.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  ) : (
                    <input type="text" value={modelForm.defaultModel} onChange={(e) => setModelForm({ ...modelForm, defaultModel: e.target.value })} placeholder="model-name" className={`${inputCls} font-mono`} />
                  );
                })()}
                {modelModal.modelDiscovery === 'manual' && (
                  <p className="text-xs text-on-surface-variant/70 mt-1.5">{t('manualModelNote')}</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>{t('timeoutMs')}</label>
                  <input type="number" min={1000} max={300000} value={modelForm.timeoutMs} onChange={(e) => setModelForm({ ...modelForm, timeoutMs: e.target.value })} placeholder="60000" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>{t('maxRetries')}</label>
                  <input type="number" min={0} max={5} value={modelForm.maxRetries} onChange={(e) => setModelForm({ ...modelForm, maxRetries: e.target.value })} placeholder="2" className={inputCls} />
                </div>
              </div>
              {(modelModal.category === 'local' || modelModal.id === 'custom') && (
                <label className="flex items-center gap-2.5 text-xs text-on-surface-variant">
                  <input
                    type="checkbox"
                    checked={modelForm.optInLocal}
                    onChange={(e) => setModelForm({ ...modelForm, optInLocal: e.target.checked })}
                    className="accent-primary"
                  />
                  {t('optInLocal')}
                </label>
              )}
              <div className="flex flex-wrap gap-1.5">
                {(Object.entries(modelModal.capabilities) as [string, boolean][]).filter(([, v]) => v).map(([k]) => (
                  <span key={k} className="text-[10px] px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant font-mono">{k}</span>
                ))}
              </div>
              {modelTest.state === 'ok' && (
                <div className="rounded-md bg-success/10 p-3 flex items-center gap-2">
                  <CircleCheck className="w-4 h-4 text-success shrink-0" />
                  <span className="text-xs text-success font-medium">
                    {t('testOk')}{modelTest.models?.length ? ` · ${modelTest.models.length} models` : ''}
                  </span>
                </div>
              )}
              {modelTest.state === 'fail' && (
                <div className="rounded-md bg-error/10 p-3 flex items-center gap-2">
                  <CircleX className="w-4 h-4 text-error shrink-0" />
                  <span className="text-xs text-error font-medium">{t('testFail', { error: modelTest.error ?? '' })}</span>
                </div>
              )}
            </div>
            <div className="flex items-center justify-between mt-6">
              <button onClick={testModel} disabled={modelTest.state === 'testing' || (!modelForm.apiKey && !modelModal.connection?.hasKey)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium bg-surface-container text-on-surface hover:bg-surface-container-high active:scale-[0.98] transition-all disabled:opacity-60">
                <Zap className="w-3.5 h-3.5" />
                {modelTest.state === 'testing' ? tc('loading') : tc('testConnection')}
              </button>
              <div className="flex gap-3">
                {modelModal.connection?.isEnabled && (
                  <button onClick={() => removeModel(modelModal.id)} className="text-sm text-error font-medium hover:underline px-2">
                    {t('disconnect')}
                  </button>
                )}
                <button onClick={() => setModelModal(null)} className={ghostBtn}>{tc('cancel')}</button>
                <button onClick={saveModel} disabled={modelSaving || (!modelForm.apiKey && !modelModal.connection?.hasKey)} className={primaryBtn}>
                  {modelSaving ? tc('loading') : tc('save')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 添加邮箱弹窗 */}
      {mailModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={() => setMailModal(false)}>
          <div className="bg-surface rounded-xl shadow-dialog max-w-md w-full p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-base font-semibold">{t('addMailbox')}</h3>
              <button onClick={() => setMailModal(false)} className="w-8 h-8 rounded-md hover:bg-surface-container flex items-center justify-center text-on-surface-variant transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2 mb-5">
              {(['gmail', 'outlook', 'smtp'] as const).map((tp) => (
                <button
                  key={tp}
                  onClick={() => setMailType(tp)}
                  className={`rounded-md px-3 py-2.5 text-xs font-medium transition-colors ${
                    mailType === tp ? 'bg-primary/10 text-primary' : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  {tp === 'gmail' ? 'Gmail / Workspace' : tp === 'outlook' ? 'Outlook / 365' : t('customSmtp')}
                </button>
              ))}
            </div>
            <div className="space-y-4">
              {mailType !== 'smtp' && (
                <div className="rounded-md bg-surface-container/60 p-4 text-center">
                  <ShieldCheck className="w-8 h-8 text-success mx-auto mb-2" />
                  <p className="text-sm font-medium mb-1">{t('appPasswordTitle')}</p>
                  <p className="text-xs text-on-surface-variant leading-relaxed">{t('appPasswordNote')}</p>
                </div>
              )}
              <div>
                <label className={labelCls}>{t('emailAddress')}</label>
                <input type="email" value={mailForm.email} onChange={(e) => setMailForm({ ...mailForm, email: e.target.value })} placeholder="you@company.com" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>{t('displayName')}</label>
                <input type="text" value={mailForm.displayName} onChange={(e) => setMailForm({ ...mailForm, displayName: e.target.value })} className={inputCls} />
              </div>
              {mailType === 'smtp' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls}>{t('smtpHost')}</label>
                    <input type="text" value={mailForm.smtpHost} onChange={(e) => setMailForm({ ...mailForm, smtpHost: e.target.value })} placeholder="smtp.exmail.qq.com" className={`${inputCls} font-mono`} />
                  </div>
                  <div>
                    <label className={labelCls}>{t('port')}</label>
                    <input type="text" value={mailForm.smtpPort} onChange={(e) => setMailForm({ ...mailForm, smtpPort: e.target.value })} className={`${inputCls} font-mono`} />
                  </div>
                  <div>
                    <label className={labelCls}>{t('imapHost')}</label>
                    <input type="text" value={mailForm.imapHost} onChange={(e) => setMailForm({ ...mailForm, imapHost: e.target.value })} placeholder="imap.exmail.qq.com" className={`${inputCls} font-mono`} />
                  </div>
                  <div>
                    <label className={labelCls}>{t('port')}</label>
                    <input type="text" value={mailForm.imapPort} onChange={(e) => setMailForm({ ...mailForm, imapPort: e.target.value })} className={`${inputCls} font-mono`} />
                  </div>
                </div>
              )}
              <div>
                <label className={labelCls}>{t('password')}</label>
                <input type="password" value={mailForm.pass} onChange={(e) => setMailForm({ ...mailForm, pass: e.target.value })} placeholder={t('passwordHint')} className={`${inputCls} font-mono`} />
                <p className="text-xs text-on-surface-variant/70 mt-1.5">{t('credentialsEncrypted')}</p>
              </div>
              <div className="flex justify-end gap-3">
                <button onClick={() => setMailModal(false)} className={ghostBtn}>{tc('cancel')}</button>
                <button onClick={saveMailbox} disabled={mailSaving || !mailForm.email || !mailForm.pass} className={primaryBtn}>
                  {mailSaving ? tc('loading') : tc('save')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ERPNext 配置弹窗 */}
      {erpModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={() => setErpModal(false)}>
          <div className="bg-surface rounded-xl shadow-dialog max-w-md w-full p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-base font-semibold">{t('configErp')}</h3>
              <button onClick={() => setErpModal(false)} className="w-8 h-8 rounded-md hover:bg-surface-container flex items-center justify-center text-on-surface-variant transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className={labelCls}>{t('erpUrl')}</label>
                <input type="text" value={erpForm.url} onChange={(e) => setErpForm({ ...erpForm, url: e.target.value })} placeholder="https://erp.yourcompany.com" className={`${inputCls} font-mono`} />
                <p className="text-xs text-on-surface-variant/70 mt-1.5">{t('erpUrlNote')}</p>
              </div>
              <div>
                <label className={labelCls}>{t('apiKey')}</label>
                <input type="password" value={erpForm.apiKey} onChange={(e) => setErpForm({ ...erpForm, apiKey: e.target.value })} className={`${inputCls} font-mono`} />
              </div>
              <div>
                <label className={labelCls}>{t('apiSecret')}</label>
                <input type="password" value={erpForm.apiSecret} onChange={(e) => setErpForm({ ...erpForm, apiSecret: e.target.value })} className={`${inputCls} font-mono`} />
                <p className="text-xs text-on-surface-variant/70 mt-1.5">{t('erpSecretNote')}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-on-surface-variant mb-2">{t('syncScope')}</p>
                <div className="space-y-2">
                  {ERP_SCOPES.map((scope) => (
                    <label key={scope} className="flex items-center justify-between rounded-md bg-surface-container/60 px-3 py-2.5 cursor-pointer">
                      <span className="text-sm">{t(`erpScopes.${scope}`)}</span>
                      <input
                        type="checkbox"
                        checked={erpForm.scopes.includes(scope)}
                        onChange={(e) =>
                          setErpForm({
                            ...erpForm,
                            scopes: e.target.checked ? [...erpForm.scopes, scope] : erpForm.scopes.filter((s) => s !== scope),
                          })
                        }
                        className="w-4 h-4 accent-primary"
                      />
                    </label>
                  ))}
                </div>
              </div>
              {erpTest.state === 'ok' && (
                <div className="rounded-md bg-success/10 p-3 flex items-center gap-2">
                  <CircleCheck className="w-4 h-4 text-success shrink-0" />
                  <span className="text-xs text-success font-medium">{t('testOk')}</span>
                </div>
              )}
              {erpTest.state === 'fail' && (
                <div className="rounded-md bg-error/10 p-3 flex items-center gap-2">
                  <CircleX className="w-4 h-4 text-error shrink-0" />
                  <span className="text-xs text-error font-medium">{t('testFail', { error: erpTest.error ?? '' })}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <button
                  onClick={() => testIntegration('erpnext', { url: erpForm.url, apiKey: erpForm.apiKey, apiSecret: erpForm.apiSecret }, setErpTest)}
                  disabled={erpTest.state === 'testing' || !erpForm.url || !erpForm.apiKey || !erpForm.apiSecret}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium bg-surface-container text-on-surface hover:bg-surface-container-high active:scale-[0.98] transition-all disabled:opacity-60"
                >
                  <Zap className="w-3.5 h-3.5" />
                  {erpTest.state === 'testing' ? tc('loading') : tc('testConnection')}
                </button>
                <button
                  onClick={() => saveIntegration('erpnext', { url: erpForm.url, apiKey: erpForm.apiKey, apiSecret: erpForm.apiSecret }, erpForm.scopes)}
                  disabled={!erpForm.url || !erpForm.apiKey || !erpForm.apiSecret}
                  className={primaryBtn}
                >
                  {tc('save')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 通用集成配置弹窗 */}
      {intModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-on-surface/40 backdrop-blur-sm" onClick={() => setIntModal(null)} />
          <div className="bg-surface rounded-xl shadow-dialog max-w-lg w-full p-6 relative max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <Plug className="w-5 h-5 text-primary" />
                {t('configIntegration', { name: intModal === 'square' ? 'Square POS' : intModal === 'shopify' ? 'Shopify' : intModal === 'stripe' ? 'Stripe' : 'PayPal' })}
              </h3>
              <button onClick={() => setIntModal(null)} className="p-1.5 rounded-md hover:bg-surface-container transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-4 mb-4">
              {(INT_FIELDS[intModal] ?? []).map((field) => (
                <div key={field.key}>
                  <label className={labelCls}>{t(`intFields.${intModal}.${field.key}`)}</label>
                  <input
                    type={field.secret ? 'password' : 'text'}
                    value={intForm[field.key] ?? ''}
                    onChange={(e) => setIntForm({ ...intForm, [field.key]: e.target.value })}
                    placeholder={field.placeholder}
                    className={`${inputCls} font-mono`}
                  />
                </div>
              ))}
            </div>
            {intTest.state === 'ok' && (
              <div className="mb-4 rounded-md bg-success/10 p-3 flex items-center gap-2">
                <CircleCheck className="w-4 h-4 text-success shrink-0" />
                <span className="text-xs text-success font-medium">{t('testOk')}</span>
              </div>
            )}
            {intTest.state === 'fail' && (
              <div className="mb-4 rounded-md bg-error/10 p-3 flex items-center gap-2">
                <CircleX className="w-4 h-4 text-error shrink-0" />
                <span className="text-xs text-error font-medium">{t('testFail', { error: intTest.error ?? '' })}</span>
              </div>
            )}
            <div className="rounded-md bg-surface-container/60 px-4 py-3 mb-5">
              <p className="text-xs text-on-surface-variant">{t(`intTips.${intModal}`)}</p>
            </div>
            <div className="flex items-center justify-between">
              <button
                onClick={() => testIntegration(intModal, intForm, setIntTest)}
                disabled={intTest.state === 'testing'}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium bg-surface-container text-on-surface hover:bg-surface-container-high active:scale-[0.98] transition-all disabled:opacity-60"
              >
                <Zap className="w-3.5 h-3.5" />
                {intTest.state === 'testing' ? tc('loading') : tc('testConnection')}
              </button>
              <button onClick={() => saveIntegration(intModal, intForm, [])} className={primaryBtn}>{tc('save')}</button>
            </div>
          </div>
        </div>
      )}

      {/* 社交通讯连接弹窗 */}
      {chModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-on-surface/40 backdrop-blur-sm" onClick={() => setChModal(null)} />
          <div className="bg-surface rounded-xl shadow-dialog max-w-lg w-full p-6 relative max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <Plug className="w-5 h-5 text-primary" />
                {t('configChannel', { name: CHANNEL_LABELS[chModal] })}
              </h3>
              <button onClick={() => setChModal(null)} className="p-1.5 rounded-md hover:bg-surface-container transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-4 mb-4">
              {(CHANNEL_PRESETS.find((c) => c.key === chModal)?.fields ?? []).map((field) => (
                <div key={field.key}>
                  <label className={labelCls}>{t(`channelFields.${field.key}`)}</label>
                  <input
                    type={field.secret ? 'password' : 'text'}
                    value={chForm[field.key] ?? ''}
                    onChange={(e) => setChForm({ ...chForm, [field.key]: e.target.value })}
                    placeholder={field.placeholder}
                    className={`${inputCls} font-mono`}
                  />
                </div>
              ))}
            </div>
            {chTest.state === 'ok' && (
              <div className="mb-4 rounded-md bg-success/10 p-3 flex items-center gap-2">
                <CircleCheck className="w-4 h-4 text-success shrink-0" />
                <span className="text-xs text-success font-medium">{t('testOk')}</span>
              </div>
            )}
            {chTest.state === 'fail' && (
              <div className="mb-4 rounded-md bg-error/10 p-3 flex items-center gap-2">
                <CircleX className="w-4 h-4 text-error shrink-0" />
                <span className="text-xs text-error font-medium">{t('testFail', { error: chTest.error ?? '' })}</span>
              </div>
            )}
            <div className="rounded-md bg-surface-container/60 px-4 py-3 mb-5">
              <p className="text-xs text-on-surface-variant">{t(`channelTip.${chModal}`)}</p>
            </div>
            <div className="flex items-center justify-between">
              <button onClick={() => testChannel(chModal, chForm)} disabled={chTest.state === 'testing'} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium bg-surface-container text-on-surface hover:bg-surface-container-high active:scale-[0.98] transition-all disabled:opacity-60">
                <Zap className="w-3.5 h-3.5" />
                {chTest.state === 'testing' ? tc('loading') : tc('testConnection')}
              </button>
              <button onClick={() => saveChannel(chModal, chForm)} className={primaryBtn}>{tc('save')}</button>
            </div>
          </div>
        </div>
      )}

      {/* 清空数据确认弹窗 */}
      {wipeModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={() => setWipeModal(false)}>
          <div className="bg-surface rounded-xl shadow-dialog max-w-sm w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-3">
              <span className="w-9 h-9 rounded-md bg-error/15 text-error flex items-center justify-center shrink-0">
                <TriangleAlert className="w-4 h-4" />
              </span>
              <h3 className="text-base font-semibold">{t('wipeConfirmTitle')}</h3>
            </div>
            <p className="text-sm text-on-surface-variant leading-relaxed">{t('wipeConfirm')}</p>
            {wipeError && (
              <p className="text-sm text-error mt-3">{wipeError}</p>
            )}
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setWipeModal(false)} className={ghostBtn}>{tc('cancel')}</button>
              <button onClick={wipeData} disabled={wiping} className="bg-error text-on-primary px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-60">
                {wiping ? tc('loading') : t('wipeConfirmButton')}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
