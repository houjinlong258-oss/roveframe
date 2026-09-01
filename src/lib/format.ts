export function fmtCurrency(amount: number | string, currency = 'USD'): string {
  const n = typeof amount === 'string' ? Number(amount) : amount;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
  }).format(n);
}

export function fmtDateTime(iso: string, locale = 'en'): string {
  const loc = locale === 'zh' ? 'zh-CN' : locale === 'es' ? 'es-ES' : 'en-US';
  return new Date(iso).toLocaleString(loc, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtDate(iso: string, locale = 'en'): string {
  const loc = locale === 'zh' ? 'zh-CN' : locale === 'es' ? 'es-ES' : 'en-US';
  return new Date(iso).toLocaleDateString(loc, { month: 'short', day: 'numeric' });
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
