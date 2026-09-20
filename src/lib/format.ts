function localeTag(locale: string): string {
  return locale === 'zh' ? 'zh-CN' : locale === 'es' ? 'es-ES' : 'en-US';
}

// P0-8：币种与 locale 显式参数化 —— 海外市场不再恒显 USD/$。
//
// Phase 18：加了两道防护，因为三端 PWA 会在数据到位前就渲染：
//   · `currency` 可能是 `''`（settings.locale.currency 未配置时不是 null 而是空串），
//     默认参数只对 `undefined` 生效，`''` 会让 Intl 抛 RangeError 直接崩渲染；
//   · `amount` 可能是 null/undefined/NaN。
// 两者都是纯防护：输入合法时输出与改动前逐字节一致。
export function fmtCurrency(amount: number | string | null | undefined, currency = 'USD', locale = 'en'): string {
  const parsed = typeof amount === 'string' ? Number(amount) : amount;
  const n = Number.isFinite(parsed) ? (parsed as number) : 0;
  const code = currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : 'USD';
  try {
    return new Intl.NumberFormat(localeTag(locale), {
      style: 'currency',
      currency: code,
      minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    }).format(n);
  } catch {
    return `${code} ${n.toFixed(2)}`;
  }
}

export function fmtDateTime(iso: string | null | undefined, locale = 'en'): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(localeTag(locale), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Phase 18：把分钟数渲染成"7 小时 12 分"这类时长。三端 PWA 的考勤与班次在用。
 *
 * 与其它格式化函数的差别要留意：**默认 locale 是 zh**。
 * 这是原型里的既有约定，跟着改会让英文界面出现中文时长。
 * 因此调用方必须显式传 locale —— 三端组件都传了。
 */
export function fmtDuration(minutes: number | null | undefined, locale = 'zh'): string {
  if (minutes == null || !Number.isFinite(minutes)) return '';
  const total = Math.max(0, Math.round(minutes));
  const hrs = Math.floor(total / 60);
  const mins = total % 60;

  if (locale === 'zh') {
    if (hrs > 0 && mins > 0) return `${hrs}小时${mins}分`;
    if (hrs > 0) return `${hrs}小时`;
    return `${mins}分钟`;
  }
  if (locale === 'es') {
    if (hrs > 0 && mins > 0) return `${hrs} h ${mins} min`;
    if (hrs > 0) return `${hrs} h`;
    return `${mins} min`;
  }
  if (hrs > 0 && mins > 0) return `${hrs}h ${mins}m`;
  if (hrs > 0) return `${hrs} hrs`;
  return `${mins} mins`;
}

/** 把"开始/结束"两个时间点算成分钟数；仍在进行中返回 null。 */
export function minutesBetween(startIso: string, endIso: string | null | undefined): number | null {
  if (!endIso) return null;
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.round((end - start) / 60000));
}

export function fmtDate(iso: string, locale = 'en'): string {
  return new Date(iso).toLocaleDateString(localeTag(locale), { month: 'short', day: 'numeric' });
}

export function timeAgo(iso: string, locale = 'en'): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  const r = locale === 'zh'
    ? { m: '分钟前', h: '小时前', d: '天前', now: '刚刚' }
    : locale === 'es'
      ? { m: 'min', h: 'h', d: 'd', now: 'ahora' }
      : { m: 'm ago', h: 'h ago', d: 'd ago', now: 'just now' };
  if (mins < 1) return r.now;
  if (mins < 60) return locale === 'zh' ? `${mins} ${r.m}` : `${mins}${r.m}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return locale === 'zh' ? `${hours} ${r.h}` : `${hours}${r.h}`;
  const days = Math.floor(hours / 24);
  return locale === 'zh' ? `${days} ${r.d}` : `${days}${r.d}`;
}

export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return email;
  return `${user.slice(0, 2)}***@${domain}`;
}

/** 文件体积显示（Artifact 卡片 / 文件中心共用） */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}
