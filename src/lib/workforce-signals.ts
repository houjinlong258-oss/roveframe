/**
 * Phase 18 —— 员工关怀信号（**纯函数**，无任何 DB 访问）
 *
 * ## 为什么必须是纯函数
 *
 * 这些信号会驱动"今天该关心谁"的待办。它的正确性无法靠肉眼看生产数据来验证
 * （边界是"第 5 天不触发、第 6 天触发"这种），只能靠构造输入直接断言。
 * 因此计算与取数彻底分开：本文件只吃 `SignalInput`，吐 `Signal[]`，
 * 排班/考勤/员工档案由调用方（`/api/team/care/signals`）查好传进来。
 *
 * ## 硬规则：这些信号只是**建议**，不得有任何惩罚性计算
 *
 * 本模块**刻意不产生**任何可以自动扣薪、自动记过、自动排班惩罚的信号。
 * 具体地：
 *   · 迟到 / 早退 / 缺勤本身**不是**信号。考勤异常一律是"请与本人确认"，
 *     而不是"扣钱"。`missing_punch` 的措辞必须是"确认一下"，不是"旷工"。
 *   · overtime / long_shift 只表达"该关注休息了"，**不参与任何薪资计算** ——
 *     工时统计与薪资结算是两件事，混在一起就会在真实门店里变成
 *     "系统自动少发工资"。
 *   · `suggested_by` 落库固定为 'agent'，且必须由人 accept / dismiss 才推进，
 *     没有"自动执行"分支。
 * 这是产品约束，不是实现细节。任何新增信号都必须先过这一条。
 *
 * ## signalKey 的确定性
 *
 * 每个信号都带一个**确定性**的 `signalKey`，对应 `staff_care_tasks` 上的
 * 部分唯一索引 `(tenant_id, business_id, signal_key)`。去重发生在数据库：
 * 同一天重复计算、多实例并发计算，都只会留下一条待办。
 * 因此 key 里必须包含"期间"（年份 / ISO 周 / 具体日期），否则同一件事
 * 在第一次提出之后永远无法再次提出。
 */

export interface SignalInput {
  staffId: string;
  staffName: string;
  /** 'YYYY-MM-DD' */
  birthday: string | null;
  /** 'YYYY-MM-DD' */
  hiredAt: string | null;
  shifts: { starts_at: string; ends_at: string }[];
  attendance: { clock_in_at: string; clock_out_at: string | null }[];
  /** 'YYYY-MM-DD'，按**业务时区**算出的今天。禁止用进程时区推导。 */
  today: string;
  /**
   * 业务时区相对 UTC 的偏移（分钟，东为正；如 America/New_York 为 -300）。
   *
   * 为什么把它做成入参而不是在模块里读时区：本模块必须保持纯净（可单测、
   * 无 IO）。跨时区的换算只发生在**一处** —— 把 timestamptz 映射到"业务时区的
   * 哪一天"。缺省 0 表示按 UTC 切日。
   *
   * 不用 `new Date(iso).toISOString().slice(0,10)` 做日切的原因：门店在 UTC-5 时，
   * 当地 20:00 已是次日 UTC —— "今天上没上班""这是哪天打的卡"会整体错一天，
   * 而且只在傍晚之后错，极难复现。
   */
  tzOffsetMinutes?: number;
}

export interface Signal {
  signalKey: string;
  kind: string;
  staffId: string;
  title: string;
  detail: string;
  dueAt: string | null;
}

/** 六种信号。字符串同时是 `staff_care_tasks.kind` 的取值白名单。 */
export const SIGNAL_KINDS = [
  'birthday',
  'rest',
  'overtime',
  'long_shift',
  'anniversary',
  'missing_punch',
] as const;

export type SignalKind = (typeof SIGNAL_KINDS)[number];

/**
 * 阈值必须是入参而不是常量：不同门店的"连续上班几天算该休息"不一样，
 * 而且写死之后没法测边界（第 5 天 vs 第 6 天）。
 */
export interface Thresholds {
  /** 生日提前几天提醒 */
  birthdayLookaheadDays: number;
  /** 连续上班满几天提示安排休息 */
  restStreakDays: number;
  /** 单周工时关注线（小时），**仅用于关怀提示** */
  weeklyOvertimeHours: number;
  /** 单班次时长关注线（小时） */
  longShiftHours: number;
  /** 值得庆祝的入职周年 */
  anniversaryYears: number[];
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  birthdayLookaheadDays: 7,
  // 6 天是仓库既有口径（连续工作 6 天且无休息日才提示）；
  // 5 天不提示 —— 否则双休制的门店每周都会收到噪音，信号很快会被无视。
  restStreakDays: 6,
  weeklyOvertimeHours: 48,
  longShiftHours: 10,
  anniversaryYears: [1, 3, 5],
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

interface Ymd { y: number; m: number; d: number }

/** 取 'YYYY-MM-DD' 的年月日；不合法返回 null（脏数据不该让整轮计算失败）。 */
function parseYmd(value: string | null | undefined): Ymd | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

/** 'YYYY-MM-DD' → UTC 零点时间戳（纯日历运算的锚点，与任何时区无关）。 */
function dayIndex(ymd: string): number {
  const p = parseYmd(ymd);
  if (!p) return Number.NaN;
  return Date.UTC(p.y, p.m - 1, p.d) / DAY_MS;
}

/** 纯日历加天数，返回 'YYYY-MM-DD'。 */
function addDays(ymd: string, days: number): string {
  const p = parseYmd(ymd);
  if (!p) return ymd;
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** ISO-8601 周键，形如 '2026-W37'。 */
function isoWeekKey(ymd: string): string {
  const p = parseYmd(ymd);
  if (!p) return '';
  // 规范算法：把日期移到本周四，该周四所在的年份即 ISO 周所属年份。
  const thursday = new Date(Date.UTC(p.y, p.m - 1, p.d));
  const dow = thursday.getUTCDay() === 0 ? 7 : thursday.getUTCDay();
  thursday.setUTCDate(thursday.getUTCDate() + (4 - dow));
  const isoYear = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(isoYear, 0, 1)) / (7 * DAY_MS)) + 1;
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** ISO 周的周一（'YYYY-MM-DD'）。 */
function isoWeekMonday(ymd: string): string {
  const p = parseYmd(ymd);
  if (!p) return ymd;
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d));
  const dow = dt.getUTCDay() === 0 ? 7 : dt.getUTCDay();
  return addDays(ymd, -(dow - 1));
}

/** 某年某月的天数（含闰年）。 */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * 某个员工本次生日应落在哪一天。
 *
 * 2 月 29 日出生的人在平年没有生日 —— 落到 3 月 1 日。
 * 不显式处理的话 `Date.UTC(y, 1, 29)` 会自己滚到 3 月 1 日：
 * 结果一样，但语义变成"隐式溢出"，将来改代码的人不会知道这是有意的。
 */
function birthdayOn(birthday: { m: number; d: number }, year: number): string {
  if (birthday.m === 2 && birthday.d === 29 && daysInMonth(year, 2) < 29) {
    return `${year}-03-01`;
  }
  return `${year}-${String(birthday.m).padStart(2, '0')}-${String(birthday.d).padStart(2, '0')}`;
}

/**
 * 计算全部信号。
 *
 * 输出顺序固定为 `SIGNAL_KINDS` 的次序（生日 → 休息 → 超时 → 长班 → 周年 → 缺卡），
 * 同一种内按输入顺序。**不额外排序**：落库靠唯一索引去重，展示侧自己排；
 * 在这里做 locale 相关的字符串排序只会让"同输入在不同机器上顺序不同"。
 */
export function computeSignals(input: SignalInput, thresholds: Thresholds = DEFAULT_THRESHOLDS): Signal[] {
  const signals: Signal[] = [];
  const t = thresholds;
  const today = parseYmd(input.today);
  if (!today) {
    // today 不合法时**不猜**：宁可这一轮不出信号，也不能把"今天"当成随机日期。
    return [];
  }
  const todayIdx = dayIndex(input.today);
  const offsetMinutes = typeof input.tzOffsetMinutes === 'number' ? input.tzOffsetMinutes : 0;

  /** timestamptz → 业务时区下的 'YYYY-MM-DD'（跨时区换算的**唯一**一处）。 */
  const localYmd = (iso: string): string => {
    const parsed = Date.parse(iso);
    if (Number.isNaN(parsed)) return '';
    const shifted = new Date(parsed + offsetMinutes * 60_000);
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
  };

  // ---------- 1) birthday：生日在接下来 N 天内 ----------
  const birthday = parseYmd(input.birthday);
  if (birthday) {
    const thisYear = birthdayOn(birthday, today.y);
    let diff = dayIndex(thisYear) - todayIdx;
    // 跨年回绕：今年的生日已过，则看明年的。
    if (diff < 0) diff = dayIndex(birthdayOn(birthday, today.y + 1)) - todayIdx;
    if (diff >= 0 && diff <= t.birthdayLookaheadDays) {
      signals.push({
        signalKey: `birthday:${input.staffId}:${today.y}`,
        kind: 'birthday',
        staffId: input.staffId,
        title: `${input.staffName} 的生日快到了`,
        detail: diff === 0
          ? `今天是 ${input.staffName} 的生日（${thisYear}）。`
          : `距离 ${input.staffName} 的生日还有 ${diff} 天（${thisYear}）。`,
        dueAt: `${thisYear}T00:00:00.000Z`,
      });
    }
  }

  // ---------- 出勤口径：按人-日聚合的信号都基于"有打卡记录的日历日" ----------
  const workedDayIdx = new Set<number>();
  const workedDays: number[] = [];
  for (const record of input.attendance) {
    const idx = dayIndex(localYmd(record.clock_in_at));
    if (Number.isNaN(idx) || workedDayIdx.has(idx)) continue;
    workedDayIdx.add(idx);
    workedDays.push(idx);
  }
  workedDays.sort((a, b) => a - b);

  // ---------- 2) rest：连续上班 N 天且中间没有休息日 ----------
  //
  // 键是**每一个被这段连续上班覆盖的 ISO 周**各一条，而不是"最长那段的一周"。
  // 两个原因：
  //   · 一段 10 天的连续上班会横跨两个 ISO 周，只报一周等于漏掉一半；
  //   · 连续上班期间（第 6 天起）每天重算都必须仍然命中同一条待办 ——
  //     若键跟着"当前最长段"漂移，待办会凭空消失又出现（人已经点掉的那条
  //     会换一个键重新出现）。按周分桶则期间稳定，去重由唯一索引承担。
  // 阈值是"连续"的：只有长度 >= restStreakDays 的段才参与。
  let runStart = 0;
  const streakWeeks = new Set<string>();
  for (let i = 0; i < workedDays.length; i += 1) {
    if (i > 0 && workedDays[i] !== workedDays[i - 1] + 1) runStart = i;
    const runLength = i - runStart + 1;
    // 段还没到阈值就已结束 → 不可能再达标，跳过。
    const isRunOver = i === workedDays.length - 1 || workedDays[i + 1] !== workedDays[i] + 1;
    if (isRunOver && runLength >= t.restStreakDays) {
      for (let j = runStart; j <= i; j += 1) {
        streakWeeks.add(isoWeekKey(new Date(workedDays[j] * DAY_MS).toISOString().slice(0, 10)));
      }
    }
  }
  for (const week of Array.from(streakWeeks).sort()) {
    signals.push({
      signalKey: `rest:${input.staffId}:${week}`,
      kind: 'rest',
      staffId: input.staffId,
      title: `${input.staffName} 已连续上班 ${t.restStreakDays} 天以上`,
      detail: `最近有连续 ${t.restStreakDays} 天以上出勤、中间没有休息日。建议确认排班并安排休息。`,
      dueAt: `${input.today}T00:00:00.000Z`,
    });
  }
  // 未达到阈值时**保持信号种类存在但内容为空**不是选项：rest 信号的意义就是"该休息了"。
  // 上面循环对 5 天连续（< 6）不会产生任何条目，这正是边界要求。

  // ---------- 3) overtime：本 ISO 周累计工时超过关注线 ----------
  const thisWeekMonday = parseYmd(isoWeekMonday(input.today))!;
  const weekStart = Date.UTC(thisWeekMonday.y, thisWeekMonday.m - 1, thisWeekMonday.d) - offsetMinutes * 60_000;
  const weekEnd = weekStart + 7 * DAY_MS;
  let weekMs = 0;
  for (const record of input.attendance) {
    if (!record.clock_out_at) continue;
    const from = Date.parse(record.clock_in_at);
    const to = Date.parse(record.clock_out_at);
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from) continue;
    // 夹到本周区间：跨周的班次若整段计入，会被两周**各算一次**，两边工时都虚高。
    // 夹取之后每个班次恰好贡献它落在本周的那部分。
    const overlap = Math.min(to, weekEnd) - Math.max(from, weekStart);
    if (overlap > 0) weekMs += overlap;
  }
  const weekHours = weekMs / HOUR_MS;
  if (weekHours > t.weeklyOvertimeHours) {
    signals.push({
      signalKey: `overtime:${input.staffId}:${isoWeekKey(input.today)}`,
      kind: 'overtime',
      staffId: input.staffId,
      title: `${input.staffName} 本周工时偏高（${weekHours.toFixed(1)} 小时）`,
      detail: `本周已记录 ${weekHours.toFixed(1)} 小时，超过 ${t.weeklyOvertimeHours} 小时的关注线。请确认排班与休息情况。此提示不用于薪资计算。`,
      dueAt: null,
    });
  }

  // ---------- 4) long_shift：单个班次超过关注线 ----------
  for (const record of input.attendance) {
    if (!record.clock_out_at) continue;
    const from = Date.parse(record.clock_in_at);
    const to = Date.parse(record.clock_out_at);
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from) continue;
    const hours = (to - from) / HOUR_MS;
    if (hours <= t.longShiftHours) continue;
    // key 用打卡的开始时刻：同一天两个超长班次（早班 + 晚班）是两个独立事实，
    // 用日期做 key 会把它们压成一条，第二班就永远不会被提出来。
    signals.push({
      signalKey: `long_shift:${input.staffId}:${record.clock_in_at}`,
      kind: 'long_shift',
      staffId: input.staffId,
      title: `${input.staffName} 有一个超长班次（${hours.toFixed(1)} 小时）`,
      detail: `${localYmd(record.clock_in_at)} 这一个班次记录了 ${hours.toFixed(1)} 小时，超过 ${t.longShiftHours} 小时。建议确认本人状态与排班安排。`,
      dueAt: null,
    });
  }

  // ---------- 5) anniversary：入职满 1 / 3 / 5 年 ----------
  const hired = parseYmd(input.hiredAt);
  if (hired && hired.m === today.m && hired.d === today.d) {
    const years = today.y - hired.y;
    if (t.anniversaryYears.includes(years)) {
      signals.push({
        signalKey: `anniversary:${input.staffId}:${today.y}`,
        kind: 'anniversary',
        staffId: input.staffId,
        title: `${input.staffName} 入职 ${years} 周年`,
        detail: `${input.staffName} 于 ${input.hiredAt} 入职，今天是第 ${years} 周年。`,
        dueAt: `${input.today}T00:00:00.000Z`,
      });
    }
  }

  // ---------- 6) missing_punch：过去某天有班次但没有任何打卡记录 ----------
  //
  // 措辞刻意是"请确认"，不是"缺勤/旷工"。漏打卡的常见原因是当班人用了别人的
  // 设备、忘记点、或店里当时网络断了 —— 直接定性会把关怀工具变成指控，
  // 而这类信号一旦被当成指控，员工就会开始伪造打卡。
  for (const shift of input.shifts) {
    const startsDay = localYmd(shift.starts_at);
    if (!startsDay) continue;
    const idx = dayIndex(startsDay);
    if (Number.isNaN(idx) || idx >= todayIdx) continue; // 只回看已经过去的日历日
    if (workedDayIdx.has(idx)) continue;
    signals.push({
      signalKey: `missing_punch:${input.staffId}:${startsDay}`,
      kind: 'missing_punch',
      staffId: input.staffId,
      title: `${input.staffName} ${startsDay} 有排班但没有打卡记录`,
      detail: `${startsDay} 排了一个班次（${shift.starts_at} ~ ${shift.ends_at}），但当天没有任何打卡记录。请与本人确认是漏打卡还是排班有变；确认后可补卡。`,
      dueAt: `${input.today}T00:00:00.000Z`,
    });
  }

  return signals;
}
