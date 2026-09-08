/**
 * P0-8：时区正确性工具。
 * 全链路约定：ISO-UTC 存储 + 按业务配置时区取本地零点切日。
 * 进程时区（服务器 CST）绝不参与业务「今日/昨日」口径。
 */

export const DEFAULT_BUSINESS_TIME_ZONE = 'America/New_York';

/** 计算某 UTC 时刻在指定时区的偏移（分钟，东为正）。 */
export function timeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(map.year, (map.month ?? 1) - 1, map.day ?? 1, (map.hour ?? 0) % 24, map.minute ?? 0, map.second ?? 0);
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/**
 * 业务时区内的自然日区间（如 '2026-09-08' 在 America/New_York 的 UTC 起止时刻）。
 * 以当日正午为锚点探测偏移，规避 DST 边界误差。
 */
export function businessDayRange(
  dateStr: string,
  timeZone: string,
): { start: Date; end: Date } {
  const [year, month, day] = dateStr.split('-').map((part) => Number(part));
  if (!year || !month || !day || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`invalid date string: ${dateStr}`);
  }
  const noonUtc = Date.UTC(year, month - 1, day, 12, 0, 0);
  const offset = timeZoneOffsetMinutes(new Date(noonUtc), timeZone);
  const start = new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - offset * 60_000);
  const end = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0) - offset * 60_000);
  return { start, end };
}

/** 当前时刻在业务时区的本地日期（YYYY-MM-DD）。 */
export function localDateInTimeZone(date: Date, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return dtf.format(date);
}

/** 归一化时区配置（非法值回落默认）。 */
export function resolveBusinessTimeZone(timeZone: unknown): string {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return DEFAULT_BUSINESS_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return DEFAULT_BUSINESS_TIME_ZONE;
  }
}
