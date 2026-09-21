'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Clock,
  CheckCircle2,
  AlertCircle,
  Bike,
  CalendarCheck,
  CalendarDays,
  Phone,
  HeartHandshake,
  LogOut,
  RefreshCw,
  Navigation,
  ExternalLink,
  Sparkles,
  Download,
} from 'lucide-react';
import {
  Locale,
  StaffMeResponse,
  StaffAttendanceRecord,
  StaffShift,
  StaffDeliveriesResponse,
  StaffReservationItem,
  CareResource,
  StaffDeliveryItem,
  CustomerOrderSummary,
} from '@/types';
import { staffApi } from '@/lib/api';
import { fmtCurrency, fmtDateTime, fmtDuration } from '@/lib/format';
import { getTranslations } from '@/lib/i18n';
import { StaffShell, StaffTab } from './StaffShell';
import { TierInstallPrompt } from '@/components/pwa/tier-install-prompt';
import { PushSubscribe } from '@/components/pwa/PushSubscribe';
import { DeliveryTrackerMap } from '@/components/delivery/delivery-tracker';
import { fadeClass, popClass, usePresence } from '@/components/pwa/presence';

/**
 * 员工端 PWA（Phase 18，`/{locale}/staff`）。
 *
 * 与原型（_pwa-review/src/components/staff/StaffPwa.tsx，1047 行）的差异清单。
 * 每一处都不是美化，是"接真实数据"必须改的：
 *
 *   1. **假登录页整体移除。** 原型 `isAuthenticated` 初值就是 `true`，
 *      `handleLogin` 里写着 `// Simulate login` —— 它不调任何接口，只是把本地
 *      布尔值翻成 true，预填的账号是一组演示邮箱。真实身份来自商家会话
 *      cookie，由服务端解析（`/api/staff/me`）。真正需要给员工看的只有
 *      **409 `staff_not_linked`**（"账号没关联员工档案"），现在由
 *      `notLinkedNotice` 面板直接呈现，并给出重试入口。
 *   2. **`Promise.all` 换成 `Promise.allSettled`。** 原型把 6 个请求塞进同一个
 *      `Promise.all` + 一个空 `catch`，任意一个失败（或后端根本还没上线的
 *      kitchen photos）会让整页数据一起消失，而且**什么都不提示**。
 *      现在逐项失败逐项提示（`loadFailures`），成功的分区照常渲染。
 *   3. **后厨巡检与上传入口整体移除。** 原型在这里挂了
 *      `KitchenPhotoUploadModal` 与 `KitchenInspectionModal`：前者的"上传"是
 *      4 个写死的 Unsplash 图库 URL，并让上传者自己写 `verified: true`。
 *      理由见 `./KitchenPhotoUploadModal.tsx` 的文件头。
 *   4. **写死的演示数据全部去掉**：占位的员工姓名/岗位、`10月28日 · 星期一`、
 *      天气 `18°C`、入职日期回落值。日期与问候语改为挂载后按本地时间计算
 *      （服务端算会与客户端不一致，那是 hydration 报错）。
 *   5. **「个人数据安全导出」卡片当时被移除过**（`staffApi.exportStaffData()` 在
 *      当时的 `src/lib/api.ts` 里不存在，留一个点了没反应的按钮比没有更糟）。
 *      现在后端 `GET /api/staff/export` 与 `staffApi.exportStaffData()` 都已落地，
 *      卡片按原样接回（见 §5.7 数据权利）。
 *   6. **静默 `catch {}` 全部去掉**：轮询、预约改状态、隐私开关、导出、登出，
 *      每一处失败都在 UI 上看得见。
 *
 * ## 已知缺口：部分文案没有 i18n 键（本次修不了）
 *
 * 原型的员工端界面是**中文单语**的：只有导航、按钮、状态标签等少数文案走了
 * `getTranslations`（`t.staff.*`），其余（"实时考勤状态"、"今日尚未打卡"、
 * "近期出勤记录（只读）"…）都是写死的中文。`src/lib/i18n.ts` 里没有对应键，
 * 而该文件在本次任务的禁改清单里。结果：`/en/staff` 与 `/es/staff` 会把这些
 * 中文原样渲染出来（已实测确认）。要三语化需要先往 `i18n.ts` 补键。
 *
 * 本轮新增的导出卡片按同一条口径处理：按钮文案复用**已存在的**
 * `t.staff.export_my_data`（三语都有），说明句与"正在导出…"没有对应键，
 * 就用短中文原样写在这里 —— 不往禁改的 `i18n.ts` 里加键，也不拿一个
 * 语义不符的键硬套。
 */

/** `PwaApiError` / 任意异常 → 一条能显示的消息（错误对象上有 `error` 字段）。 */
function describeError(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'error' in err) {
    const message = (err as { error?: unknown }).error;
    if (typeof message === 'string' && message) return message;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

/** 异常对象上的后端错误码（`PwaApiError.code`）。 */
function errorCode(err: unknown): string | null {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  return null;
}

/**
 * `/api/staff/me` 的返回形状。
 *
 * 订正（本轮）：此前这里写着"接口比 `StaffMeResponse` 少 position / photo_url /
 * preferences，所以只能带收窄地读、拿不到就当没有"。那三条**服务端缺口**已经补上
 * （见 src/app/api/staff/me/route.ts），所以下面不再为它们做收窄读取：
 *   · `staff.position` 是真实岗位（`staff.position` 列，空则回落旧列 `staff.role`）；
 *   · `staff.photo_url` 可以为 null（库里就是可空的，不是接口漏了）；
 *   · `preferences.personal_data_opt_in` 现在真的会回，**刷新后不再丢**。
 * 旧的 `staff.employee_role`（恒为 null）已被 `position` 取代 —— 读一个永远为
 * null 的字段，会让"岗位没显示出来"看起来像 UI 的问题。
 */
function readEmployeeRole(me: StaffMeResponse | null): string | null {
  if (!me) return null;
  // 兼容旧形状：若某个部署实例还在回 employee_role，收窄后回落到它。
  const staff = me.staff as StaffMeResponse['staff'] & { employee_role?: unknown };
  const position = typeof staff.position === 'string' && staff.position ? staff.position : null;
  if (position) return position;
  return typeof staff.employee_role === 'string' && staff.employee_role ? staff.employee_role : null;
}

/** 入职日期同理：接口不返回时就不显示这一行（原型回落成写死的日期）。 */
function readHiredAt(me: StaffMeResponse | null): string | null {
  const value = me?.staff.hired_at;
  return typeof value === 'string' && value ? value : null;
}

/**
 * 隐私开关默认**关闭**（Frontend Spec §5.7「默认关闭，由员工本人开启」）。
 *
 * 这个默认值现在只是"`/api/staff/me` 还没回来之前"的初值：接口已按
 * `settings.wellbeing.staff_prefs[staffId].personal_data_opt_in` 回真实的开关状态，
 * 加载成功后会被 `setPrivacyOptIn` 覆盖。
 *
 * 之所以仍然 fail-closed：接口读失败时（401/409/500）页面拿不到任何偏好，
 * 此时显示"关闭"是安全的 —— 它绝不会把**关闭**误显示成**开启**。
 * 反过来那种误显示（把开启显示成关闭）曾经是真实 bug，本轮已修。
 */
function readPersonalDataOptIn(me: StaffMeResponse | null): boolean {
  const preferences = (me as StaffMeResponse & { preferences?: { personal_data_opt_in?: unknown } } | null)
    ?.preferences;
  return preferences?.personal_data_opt_in === true;
}

/** format.ts 的 localeTag 没有导出，这是同一套映射（三端 PWA 只有这三种 locale）。 */
function localeTag(locale: Locale): string {
  return locale === 'zh' ? 'zh-CN' : locale === 'es' ? 'es-ES' : 'en-US';
}

/**
 * `StaffDeliveryItem` → 配送追踪弹窗要的 `CustomerOrderSummary`。
 *
 * 只搬运两边都真实存在的字段：
 *   · `rider` / `coordinates` 虽然类型上有，但 `src/lib/api.ts` 的 `toDeliveryItem`
 *     明确不返回它们（注释里写着"原型里它们是写死的演示数据"），这里也不编。
 *   · `items` **不编造**。原型用 `[{ name: items_summary, qty: 1, price: total }]`
 *     造了一条"数量 1、单价等于总额"的假明细。`items_summary` 已经在卡片上
 *     如实展示，塞进明细区只会让员工以为那是分项。追踪弹窗会显示
 *     "订单记录里没有餐品明细"—— 那是真相。
 */
function toTrackableOrder(item: StaffDeliveryItem): CustomerOrderSummary {
  const riderStatus = item.rider_status ?? 'unclaimed';
  return {
    id: item.id,
    // `StaffDeliveryItem.id` 来自 `delivery_orders.id`（见 src/lib/delivery.ts 的
    // toDeliveryItem / DELIVERY_SELECT），因此它就是追踪接口要的 delivery id。
    // 显式写出来而不是让追踪组件回落到 `id`：两者的语义不同，靠"恰好相等"
    // 工作的地方，将来一旦把订单 id 放进这个字段就会静默 404。
    delivery_id: item.id,
    order_no: item.order_no,
    channel: 'delivery',
    // 只做状态名的翻译，不改语义：没有骑手就不是"配送中"。
    status:
      riderStatus === 'delivered'
        ? 'completed'
        : riderStatus === 'unclaimed'
          ? 'pending'
          : 'on_the_way',
    total: item.total,
    created_at: item.created_at,
    promised_at: item.promised_at,
    recipient_name: item.recipient_name,
    recipient_phone: item.recipient_phone,
    address_line: item.address_line,
    rider_status: riderStatus,
  };
}

interface StaffPwaProps {
  locale: Locale;
  initialTab?: StaffTab;
  /**
   * 原型还有一个 `onSwitchToOwner` 回调（App.tsx 传了
   * `() => setAppView('owner')`），但 `StaffPwa` 从头到尾**没有渲染任何**
   * 触发它的控件 —— 那是一个死参数。本仓库里员工端与老板端是两个独立路由
   * （`/{locale}/staff` 与 `/{locale}/team`），不存在组件内的视图切换，
   * 所以这里不再保留这个 prop。
   */
}

interface LoadFailure {
  label: string;
  message: string;
}

export const StaffPwa: React.FC<StaffPwaProps> = ({ locale, initialTab = 'today' }) => {
  const t = getTranslations(locale);

  // Tab State
  const [tab, setTab] = useState<StaffTab>(initialTab);

  // Data States
  const [staffMe, setStaffMe] = useState<StaffMeResponse | null>(null);
  const [attendanceLogs, setAttendanceLogs] = useState<StaffAttendanceRecord[]>([]);
  const [shifts, setShifts] = useState<StaffShift[]>([]);
  const [deliveries, setDeliveries] = useState<StaffDeliveriesResponse>({ pending: [], mine: [] });
  const [reservations, setReservations] = useState<StaffReservationItem[]>([]);
  const [careResources, setCareResources] = useState<CareResource[]>([]);
  const [viewingDeliveryMapItem, setViewingDeliveryMapItem] = useState<StaffDeliveryItem | null>(null);

  // 员工本人隐私开关的本地投影（服务端确认后才翻转）
  const [privacyOptIn, setPrivacyOptIn] = useState<boolean>(false);

  // 失败可见性：启动加载逐项、轮询、预约、隐私、登出各自一条
  const [loadFailures, setLoadFailures] = useState<LoadFailure[]>([]);
  const [notLinkedNotice, setNotLinkedNotice] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [reservationFeedback, setReservationFeedback] = useState<string | null>(null);
  const [privacyError, setPrivacyError] = useState<string | null>(null);
  // 数据导出：进行中与失败各有独立状态（失败必须看得见，不写 catch {}）
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState<boolean>(false);

  // Action & Feedback
  const [isClocking, setIsClocking] = useState<boolean>(false);
  const [clockFeedback, setClockFeedback] = useState<string | null>(null);
  const [deliveryFeedback, setDeliveryFeedback] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  /**
   * 日期与问候语。**必须在挂载后计算**：服务端渲染时算一次、浏览器再算一次，
   * 跨过午夜/跨时区就会得到两个不同的字符串，React 直接报 hydration 不一致。
   */
  const [clock, setClock] = useState<{ date: string; greeting: string } | null>(null);

  const activeClock = attendanceLogs.find((log) => log.clock_out_at === null);

  // Load All Staff Data
  const loadStaffData = useCallback(async () => {
    const tr = getTranslations(locale);
    // 逐项结算，而不是共用一个 Promise.all：一个接口挂掉不该让其他分区一起空白。
    const [meR, attR, shiftR, delR, resR, careR] = await Promise.allSettled([
      staffApi.getStaffMe(),
      staffApi.getAttendanceRecords(),
      staffApi.getShifts(),
      staffApi.getDeliveries(),
      staffApi.getReservations(),
      staffApi.getCareResources(),
    ]);

    const failures: LoadFailure[] = [];

    if (meR.status === 'fulfilled') {
      setStaffMe(meR.value);
      setPrivacyOptIn(readPersonalDataOptIn(meR.value));
      setNotLinkedNotice(null);
    } else if (errorCode(meR.reason) === 'staff_not_linked') {
      // 账号没关联员工档案：这是"店长建了账号忘了建档案"的症状，不是故障。
      setNotLinkedNotice(describeError(meR.reason, tr.staff.not_linked_error));
    } else {
      failures.push({ label: tr.staff.staff_profile, message: describeError(meR.reason, '加载失败') });
    }

    if (attR.status === 'fulfilled') {
      setAttendanceLogs(attR.value);
    } else {
      failures.push({ label: tr.staff.nav_clock, message: describeError(attR.reason, '加载失败') });
    }

    if (shiftR.status === 'fulfilled') {
      setShifts(shiftR.value);
    } else {
      failures.push({ label: tr.staff.nav_shifts, message: describeError(shiftR.reason, '加载失败') });
    }

    if (delR.status === 'fulfilled') {
      setDeliveries(delR.value);
    } else {
      failures.push({ label: tr.staff.nav_deliveries, message: describeError(delR.reason, '加载失败') });
    }

    if (resR.status === 'fulfilled') {
      setReservations(resR.value);
    } else {
      failures.push({ label: tr.staff.nav_reservations, message: describeError(resR.reason, '加载失败') });
    }

    if (careR.status === 'fulfilled') {
      setCareResources(careR.value);
    } else {
      failures.push({ label: tr.staff.care_resources, message: describeError(careR.reason, '加载失败') });
    }

    setLoadFailures(failures);
  }, [locale]);

  useEffect(() => {
    void loadStaffData();
  }, [loadStaffData]);

  // 本地日期与问候语（挂载后一次）
  useEffect(() => {
    const now = new Date();
    const hour = now.getHours();
    setClock({
      date: now.toLocaleDateString(localeTag(locale), {
        month: 'long',
        day: 'numeric',
        weekday: 'long',
      }),
      greeting: hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好',
    });
  }, [locale]);

  /**
   * 外卖派单轮询（§5.5 的 15 秒）。
   *
   * 与原型唯一的差别：失败**不能**静默。原型这里是空 `catch`，
   * 后果是网络断了以后"待接单 (0)"看起来像"真的没有新单"。
   */
  useEffect(() => {
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const delData = await staffApi.getDeliveries();
        if (cancelled) return;
        setDeliveries(delData);
        setPollError(null);
      } catch (err: unknown) {
        if (cancelled) return;
        setPollError(describeError(err, '自动刷新失败'));
      }
    }, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Clock in / out single button (§5.3 direction server-determined)
  const handleClockAction = async () => {
    if (isClocking) return;
    setIsClocking(true);
    setClockFeedback(null);
    try {
      const res = await staffApi.recordAttendance();
      const updatedLogs = await staffApi.getAttendanceRecords();
      setAttendanceLogs(updatedLogs);

      if (res.action === 'clock_in') {
        const timeStr = new Date(res.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        setClockFeedback(`已签到 ${timeStr}`);
      } else {
        const durStr = fmtDuration(res.worked_minutes, locale);
        setClockFeedback(`已签退，本次工时 ${durStr}`);
      }
    } catch (err: unknown) {
      setClockFeedback(`打卡异常: ${describeError(err, '系统错误')}`);
    } finally {
      setIsClocking(false);
    }
  };

  // Claim delivery order with atomic 409 handling (§5.5)
  const handleClaimDelivery = async (deliveryId: string) => {
    setDeliveryFeedback(null);
    try {
      await staffApi.claimDelivery(deliveryId);
      const updated = await staffApi.getDeliveries();
      setDeliveries(updated);
      setDeliveryFeedback('接单成功！请尽快前往出餐台取餐并开始配送。');
    } catch (err: unknown) {
      if (errorCode(err) === 'already_claimed') {
        // §5.5: UI 必须把该卡片从"待接单"移除并提示"已被其他同事接走"，不要显示成普通错误
        setDeliveries((prev) => ({
          ...prev,
          pending: prev.pending.filter((d) => d.id !== deliveryId),
        }));
        setDeliveryFeedback(t.staff.claimed_by_other);
      } else {
        setDeliveryFeedback(describeError(err, '接单失败'));
      }
    }
  };

  // Delivery status transition
  const handleDeliveryStatusAdvance = async (deliveryId: string, nextStatus: 'picked_up' | 'delivered') => {
    setDeliveryFeedback(null);
    try {
      await staffApi.updateDeliveryStatus(deliveryId, nextStatus);
      const updated = await staffApi.getDeliveries();
      setDeliveries(updated);
      setDeliveryFeedback(nextStatus === 'picked_up' ? '已标记取餐，请注意路上骑行安全！' : '订单已送达完成，干得漂亮！');
    } catch (err: unknown) {
      setDeliveryFeedback(describeError(err, '状态更新失败'));
    }
  };

  // Reservation actions
  const handleReservationAction = async (id: string, action: 'confirmed' | 'arrived' | 'cancelled') => {
    setReservationFeedback(null);
    try {
      await staffApi.updateReservationStatus(id, action);
      setReservations(await staffApi.getReservations());
    } catch (err: unknown) {
      // 原型这里是一个空 catch：改状态失败时界面毫无变化，店员会以为已经改好了。
      setReservationFeedback(describeError(err, '预约状态更新失败'));
    }
  };

  // Privacy switch toggle (§5.7)
  const handlePrivacyToggle = async (checked: boolean) => {
    setPrivacyError(null);
    try {
      await staffApi.setStaffPreference(checked);
      // 服务端确认后才翻转开关：失败时开关保持原样（fail-closed），
      // 而不是先翻过去再回滚 —— 那中间有一段时间显示的是错的。
      setPrivacyOptIn(checked);
    } catch (err: unknown) {
      setPrivacyError(describeError(err, '隐私开关保存失败'));
    }
  };

  /**
   * 导出我自己的数据（档案 + 考勤 + 排班 + 我有权查看的关怀记录）。
   *
   * 为什么是 Blob + 临时 object URL，而不是 `window.open('/api/staff/export')`：
   *   · 后端的 401/403/409/503 在 window.open 里会变成浏览器自己渲染的一页
   *     JSON 或下载失败，员工看不到任何可执行的提示；
   *   · 走 `staffApi` 才能复用 PwaApiError 的语义（见 src/lib/api.ts 的文件头）。
   *
   * 服务端已经带了 `Content-Disposition: attachment`，但那条响应头对本函数
   * 拿到的**响应体**没有影响（fetch 读的是正文），所以文件名在这里再写一次 ——
   * 与后端同名前缀，员工把两份文件放一起时能对上。
   *
   * 失败一律 `setExportError`：这是隐私权利入口，"点了没反应"是最不能接受的形态。
   */
  const handleExportData = async () => {
    setExportError(null);
    setIsExporting(true);
    let objectUrl: string | null = null;
    try {
      const payload = await staffApi.exportStaffData();
      // 缩进 2 空格：这份文件的读者是员工本人，不是程序。
      const json = JSON.stringify(payload, null, 2);
      objectUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `roveframe-staff-export-${staffMe?.staff.id ?? 'me'}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (err: unknown) {
      setExportError(describeError(err, '导出失败'));
    } finally {
      // 立刻 revoke 会在部分浏览器取消**尚未开始**的下载（点击到写入磁盘是
      // 异步的），所以延后释放；不释放则整份导出内容会一直留在内存里。
      if (objectUrl) {
        const url = objectUrl;
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      setIsExporting(false);
    }
  };

  /**
   * 退出登录。
   *
   * 为什么是一次**直连 fetch** 而不是走 `@/lib/api`：`staffApi` 里始终没有
   * logout 方法（登出是会话级操作，不属于员工业务接口），`/api/auth/logout`
   * 是这个源上唯一的登出接口（员工端用的是商家会话 cookie，不是独立的员工会话）。
   * 原型这里只是 `setIsAuthenticated(false)` —— 一个**假**登出：
   * cookie 还在，刷新一下就回到登录态。
   */
  const handleLogout = async () => {
    setIsLoggingOut(true);
    setLogoutError(null);
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // 员工登出后回到**员工**登录页（`/{locale}/staff/login`），不是通用的
      // `/{locale}/auth/login`：后者默认选中「老板」入口，员工从门店群里点开
      // 链接登录，登出后再看到老板侧的界面会以为自己走错了地方。
      window.location.assign(`/${locale}/staff/login`);
    } catch (err: unknown) {
      setIsLoggingOut(false);
      setLogoutError(err instanceof Error ? err.message : '退出登录失败');
    }
  };

  const mapPresence = usePresence(viewingDeliveryMapItem !== null, 220);
  const firstName = staffMe?.staff.name.split(' ')[0] ?? '';
  const employeeRole = readEmployeeRole(staffMe);
  const hiredAt = readHiredAt(staffMe);

  /**
   * 账号未关联员工档案（409 `staff_not_linked`）。
   *
   * 这是原型那个假登录页真正该做的事：员工已经登录了（会话有效），
   * 缺的是"这条账号对应哪条员工档案"。所以不给账号密码输入框 —— 再登一次
   * 也没用；给的是可执行的指引和重试。
   */
  if (notLinkedNotice) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center px-4 py-8 max-w-md mx-auto font-sans select-none">
        <div className="text-center space-y-2 mb-6">
          <div className="w-14 h-14 bg-amber-500/10 border border-amber-500/30 rounded-2xl text-amber-400 flex items-center justify-center mx-auto shadow-lg">
            <AlertCircle className="w-7 h-7" />
          </div>
          <h1 className="font-bold text-lg text-white">{t.staff.login_title}</h1>
        </div>
        <div className="p-3.5 bg-rose-950/70 border border-rose-700/60 rounded-xl text-xs text-rose-200 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">账号未关联员工档案</div>
            <div className="mt-0.5 leading-relaxed">{notLinkedNotice}</div>
          </div>
        </div>
        <button
          onClick={() => {
            setNotLinkedNotice(null);
            void loadStaffData();
          }}
          className="mt-4 w-full py-2.5 rounded-xl bg-teal-600 hover:bg-teal-500 text-white font-semibold text-xs shadow-md transition"
          id="staff-retry-link-btn"
        >
          重新检查
        </button>
        <div className="mt-6 text-center text-[11px] text-slate-500">
          店长或管理员请从老板端登录。
        </div>
      </div>
    );
  }

  return (
    <StaffShell
      currentTab={tab}
      onSelectTab={setTab}
      pendingDeliveriesCount={deliveries.pending.length}
      pendingReservationsCount={reservations.filter((r) => r.status === 'pending').length}
      locale={locale}
    >
      {/* Top Header Bar */}
      <header className="rf-staff-header sticky top-0 z-30 bg-slate-950/90 backdrop-blur-md border-b border-slate-800/80 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-teal-500/20 text-teal-400 flex items-center justify-center font-bold text-xs border border-teal-500/30">
            STAFF
          </div>
          <div>
            <div className="font-bold text-xs text-white leading-tight">
              {staffMe?.staff.name ?? ''}
            </div>
            {employeeRole && (
              <div className="text-[10px] text-teal-400">{employeeRole}</div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <PushSubscribe />
          <button
            onClick={async () => {
              setIsRefreshing(true);
              try {
                await loadStaffData();
              } finally {
                setIsRefreshing(false);
              }
            }}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
            title="刷新数据"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {/* PWA Install Banner */}
      <div className="rf-staff-install px-4 pt-3">
        <TierInstallPrompt appName="RoveFrame Staff" />
      </div>

      {/* 分区加载失败：逐条列出"哪一块没读到"，而不是让页面空白 */}
      {loadFailures.length > 0 && (
        <div className="px-4 pt-3">
          <div className="p-3 bg-rose-950/70 border border-rose-700/60 rounded-xl text-xs text-rose-200 space-y-1">
            <div className="flex items-center gap-2 font-semibold">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>以下数据没有加载成功</span>
            </div>
            {loadFailures.map((failure) => (
              <div key={failure.label} className="leading-relaxed pl-6">
                · {failure.label}：{failure.message}
              </div>
            ))}
            <div className="pl-6 pt-1 text-rose-300/80">请点右上角刷新重试。</div>
          </div>
        </div>
      )}

      {/* 轮询失败：外卖单没刷新出来时必须说，否则"待接单 (0)"像是在说真的没单 */}
      {pollError && (
        <div className="px-4 pt-3">
          <div className="p-2.5 bg-amber-950/70 border border-amber-700/60 rounded-xl text-[11px] text-amber-200 flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span>外卖单自动刷新失败：{pollError}</span>
          </div>
        </div>
      )}

      {/* Global Action Toast Notification */}
      {(clockFeedback || deliveryFeedback) && (
        <div className="px-4 pt-3">
          <div className="p-3 bg-teal-950/80 border border-teal-500/50 text-teal-200 rounded-xl text-xs flex items-center justify-between shadow-lg">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-teal-400 shrink-0" />
              <span>{clockFeedback || deliveryFeedback}</span>
            </div>
            <button
              onClick={() => {
                setClockFeedback(null);
                setDeliveryFeedback(null);
              }}
              className="text-teal-400 hover:text-white text-[11px]"
            >
              关闭
            </button>
          </div>
        </div>
      )}

      {/* VIEW 1: TODAY (/today, start_url conforming to §5.2) */}
      {tab === 'today' && (
        <div className="p-4 space-y-3.5">
          <div className="rf-staff-welcome">
            <div>
              <p>{clock?.date ?? ''}</p>
              <h2>
                {clock ? `${clock.greeting}，${firstName} 👋` : firstName}
              </h2>
              <span>今天也一起加油，让每一餐更美好。</span>
            </div>
            {/* 原型这里是一个写死的天气「18°C」，没有任何数据源。
                换成门店名（/api/staff/me 的 business.name），位置与视觉不变。 */}
            <b>
              <Sparkles className="w-4 h-4" /> {staffMe?.business.name ?? ''}
            </b>
          </div>
          {/* 1. CLOCK CARD: Current status + 1 Big Button */}
          <div className="bg-gradient-to-br from-slate-900 to-slate-850 border border-slate-800 rounded-2xl p-4 shadow-md space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Clock className="w-4 h-4 text-teal-400" />
                <span>实时考勤状态</span>
              </div>
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                  activeClock
                    ? 'bg-teal-500/20 text-teal-300 border border-teal-500/40'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                {activeClock ? t.staff.status_clocked_in : t.staff.status_not_clocked}
              </span>
            </div>

            <div className="py-1">
              <div className="text-xl font-bold text-white tracking-tight">
                {activeClock ? '上班工作中...' : '今日尚未打卡'}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                {activeClock
                  ? `打卡时间：${new Date(activeClock.clock_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                  : '到达门店后点击下方按钮完成今日考勤记录'}
              </div>
            </div>

            <button
              onClick={handleClockAction}
              disabled={isClocking}
              className={`w-full py-3 rounded-xl font-bold text-xs shadow-lg transition flex items-center justify-center gap-2 ${
                activeClock
                  ? 'bg-rose-600 hover:bg-rose-500 text-white'
                  : 'bg-teal-500 hover:bg-teal-400 text-slate-950'
              } disabled:opacity-50`}
              id="staff-today-clock-btn"
            >
              <Clock className="w-4 h-4" />
              <span>{isClocking ? '打卡处理中...' : activeClock ? t.staff.clock_out : t.staff.clock_in}</span>
            </button>
          </div>

          {/* 2. MY SHIFT TODAY */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3.5 space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                <CalendarDays className="w-3.5 h-3.5 text-teal-400" />
                <span>{t.staff.my_shifts_today}</span>
              </span>
              <button onClick={() => setTab('shifts')} className="text-teal-400 text-[11px] hover:underline">
                查看全部 14 天
              </button>
            </div>

            {shifts.length > 0 ? (
              <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800/80 space-y-1">
                <div className="font-semibold text-xs text-white">{shifts[0].role}</div>
                <div className="text-teal-400 text-xs font-mono">
                  {fmtDateTime(shifts[0].starts_at, locale)} - {fmtDateTime(shifts[0].ends_at, locale)}
                </div>
                {shifts[0].note && (
                  <div className="text-[11px] text-slate-400 mt-1">{shifts[0].note}</div>
                )}
              </div>
            ) : (
              <div className="text-center py-4 text-xs text-slate-500">{t.staff.no_shifts_today}</div>
            )}
          </div>

          {/* 3. PENDING DELIVERIES & RESERVATIONS QUICK BADGES */}
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setTab('deliveries')}
              className="bg-slate-900 border border-slate-800 hover:border-teal-500/50 p-3.5 rounded-2xl text-left transition flex flex-col justify-between"
              id="quick-deliveries-card"
            >
              <div className="flex items-center justify-between">
                <Bike className="w-4 h-4 text-amber-400" />
                <span className="w-6 h-6 rounded-full bg-amber-500/20 text-amber-300 font-bold text-xs flex items-center justify-center">
                  {deliveries.pending.length}
                </span>
              </div>
              <div className="mt-3">
                <div className="font-semibold text-xs text-slate-200">{t.staff.pending_deliveries}</div>
                <div className="text-[10px] text-slate-400 mt-0.5">
                  {deliveries.pending.length > 0 ? '有新订单待接单派送' : t.staff.no_deliveries}
                </div>
              </div>
            </button>

            <button
              onClick={() => setTab('reservations')}
              className="bg-slate-900 border border-slate-800 hover:border-teal-500/50 p-3.5 rounded-2xl text-left transition flex flex-col justify-between"
              id="quick-reservations-card"
            >
              <div className="flex items-center justify-between">
                <CalendarCheck className="w-4 h-4 text-teal-400" />
                <span className="w-6 h-6 rounded-full bg-teal-500/20 text-teal-300 font-bold text-xs flex items-center justify-center">
                  {reservations.filter((r) => r.status === 'pending').length}
                </span>
              </div>
              <div className="mt-3">
                <div className="font-semibold text-xs text-slate-200">{t.staff.pending_reservations}</div>
                <div className="text-[10px] text-slate-400 mt-0.5">
                  {reservations.filter((r) => r.status === 'pending').length > 0 ? '待店员确认预订' : t.staff.no_reservations}
                </div>
              </div>
            </button>
          </div>

          {/*
            「阳光透明后厨 · 每日巡检实况」整张卡片已移除（原型的 508-548 行）。
            两个按钮分别指向"上传后厨照片"和"巡查公示"，而：
              · 上传弹窗不存在文件输入，用的是 4 个图库 URL 且由上传者自签 verified；
              · `staffApi.getKitchenPhotos()` 返回空数组、`uploadKitchenPhoto()` 抛 501。
            挂着一个永远为空、点开是 501 的入口，比没有这个入口更糟。
            后端有了「上传 + 独立审核 + 真实温控」再整块接回来。
          */}
        </div>
      )}

      {/* VIEW 2: CLOCK / ATTENDANCE (/clock conforming to §5.3) */}
      {tab === 'clock' && (
        <div className="p-4 space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 text-center space-y-3">
            <div className="text-xs text-slate-400">考勤打卡状态</div>
            <div className="text-2xl font-bold text-white">
              {activeClock ? '已签到上班中' : '尚未打卡'}
            </div>
            {activeClock && (
              <div className="text-xs text-teal-400">
                打卡开始时间：{fmtDateTime(activeClock.clock_in_at, locale)}
              </div>
            )}

            <button
              onClick={handleClockAction}
              disabled={isClocking}
              className={`w-full py-3.5 rounded-xl font-bold text-sm shadow-xl transition flex items-center justify-center gap-2 ${
                activeClock
                  ? 'bg-rose-600 hover:bg-rose-500 text-white'
                  : 'bg-teal-500 hover:bg-teal-400 text-slate-950'
              } disabled:opacity-50`}
              id="staff-clock-action-btn"
            >
              <Clock className="w-5 h-5" />
              <span>{isClocking ? '打卡记录中...' : activeClock ? t.staff.clock_out : t.staff.clock_in}</span>
            </button>

            <div className="text-[10px] text-slate-500">
              防重点击与幂等保护已启用。如需补卡请联系店长在管理端操作（带合规审计记录）。
            </div>
          </div>

          {/* Attendance History (Read-only §5.3) */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
            <div className="font-semibold text-xs text-slate-300">近期出勤记录（只读）</div>
            {attendanceLogs.length === 0 ? (
              <div className="text-center py-6 text-xs text-slate-500">暂无出勤打卡历史</div>
            ) : (
              <div className="divide-y divide-slate-800/80 space-y-2">
                {attendanceLogs.map((log) => (
                  <div key={log.id} className="pt-2 flex items-center justify-between text-xs">
                    <div>
                      <div className="font-medium text-slate-200">
                        {fmtDateTime(log.clock_in_at, locale)}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        {log.clock_out_at ? `签退: ${fmtDateTime(log.clock_out_at, locale)}` : '上班进行中'}
                      </div>
                    </div>
                    <div>
                      <span className="px-2 py-0.5 rounded-md bg-slate-800 text-teal-300 font-mono text-[11px]">
                        {log.worked_minutes ? fmtDuration(log.worked_minutes, locale) : '打卡中'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* VIEW 3: SHIFTS (/shifts conforming to §5.4) */}
      {tab === 'shifts' && (
        <div className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-sm text-white">{t.staff.shifts_14_days}</h2>
            <span className="text-[11px] text-slate-400">仅显示本人排班</span>
          </div>

          {shifts.length === 0 ? (
            <div className="text-center py-12 text-xs text-slate-500 bg-slate-900 border border-slate-800 rounded-2xl">
              {t.staff.shifts_empty}
            </div>
          ) : (
            <div className="space-y-2.5">
              {shifts.map((shift) => (
                <div
                  key={shift.id}
                  className="bg-slate-900 border border-slate-800 p-3.5 rounded-2xl space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="px-2.5 py-0.5 rounded-md bg-teal-500/20 text-teal-300 text-xs font-semibold">
                      {shift.role}
                    </span>
                    <span className="text-[11px] text-slate-400">
                      {new Date(shift.starts_at).toLocaleDateString([], { weekday: 'short' })}
                    </span>
                  </div>
                  <div className="text-xs text-white font-mono">
                    {fmtDateTime(shift.starts_at, locale)} ~ {fmtDateTime(shift.ends_at, locale)}
                  </div>
                  {shift.note && (
                    <div className="text-[11px] text-slate-400 bg-slate-950/60 p-2 rounded-lg border border-slate-800/80">
                      {shift.note}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* VIEW 4: DELIVERIES (/deliveries conforming to §5.5) */}
      {tab === 'deliveries' && (
        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-sm text-white">外卖派单与接单</h2>
            <span className="text-[10px] text-slate-400">15秒自动刷新</span>
          </div>

          {/* Group 1: Pending Orders (待接单) */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between text-xs text-amber-400 font-semibold">
              <span>待接单 ({deliveries.pending.length})</span>
              <span className="text-[10px] text-slate-400">先到先得 · 原子抢单</span>
            </div>

            {deliveries.pending.length === 0 ? (
              <div className="text-center py-6 text-xs text-slate-500 bg-slate-900 border border-slate-800 rounded-xl">
                {t.staff.no_deliveries}
              </div>
            ) : (
              deliveries.pending.map((item) => (
                <div
                  key={item.id}
                  className="bg-slate-900 border border-amber-500/30 p-3.5 rounded-2xl space-y-2.5 shadow-sm"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-bold text-white">{item.order_no}</span>
                    {/* 币种：`StaffMeResponse` 不带 currency，`fmtCurrency` 的默认值就是 USD，
                        因此这里与项目"海外默认 USD"的约定一致，不是写死的演示数据。 */}
                    <span className="font-bold text-amber-400">
                      {fmtCurrency(item.total, 'USD', locale)}
                    </span>
                  </div>

                  <div className="text-xs text-slate-300 flex items-start gap-1.5">
                    <span className="text-slate-400 shrink-0">送达地:</span>
                    <span className="font-medium">{item.address_line}</span>
                  </div>

                  <div className="text-[11px] text-slate-400">
                    菜品: {item.items_summary}
                  </div>

                  <div className="flex items-center justify-between pt-1 text-[11px]">
                    <span className="text-slate-500">
                      承诺送达: {fmtDateTime(item.promised_at, locale)}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setViewingDeliveryMapItem(item)}
                        className="text-emerald-400 hover:text-emerald-300 flex items-center gap-1 font-medium text-[11px]"
                      >
                        <Navigation className="w-3 h-3" />
                        <span>查看路线图</span>
                      </button>
                      <a
                        href={`tel:${item.recipient_phone}`}
                        className="text-teal-400 hover:underline flex items-center gap-1"
                      >
                        <Phone className="w-3 h-3" />
                        <span>{item.recipient_phone}</span>
                      </a>
                    </div>
                  </div>

                  <button
                    onClick={() => handleClaimDelivery(item.id)}
                    className="w-full py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs rounded-xl shadow transition"
                    id={`claim-delivery-${item.id}`}
                  >
                    {t.staff.claim_delivery}
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Group 2: My Deliveries (我的配送中) */}
          <div className="space-y-2.5 pt-2 border-t border-slate-800">
            <div className="text-xs text-teal-400 font-semibold">
              {t.staff.my_deliveries} ({deliveries.mine.length})
            </div>

            {deliveries.mine.length === 0 ? (
              <div className="text-center py-6 text-xs text-slate-500 bg-slate-900 border border-slate-800 rounded-xl">
                当前没有正在配送中的订单
              </div>
            ) : (
              deliveries.mine.map((item) => (
                <div
                  key={item.id}
                  className="bg-slate-900 border border-teal-500/40 p-3.5 rounded-2xl space-y-2.5"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-bold text-white">{item.order_no}</span>
                    <span className="px-2 py-0.5 rounded-md bg-teal-500/20 text-teal-300 text-[10px] font-semibold">
                      {item.rider_status === 'picked_up' ? '配送中' : '已接单待取餐'}
                    </span>
                  </div>

                  <div className="text-xs text-slate-200">
                    <div className="font-medium">{item.address_line}</div>
                    <div className="text-[11px] text-slate-400 mt-0.5">{item.items_summary}</div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <button
                      onClick={() => setViewingDeliveryMapItem(item)}
                      className="w-full py-2 rounded-xl bg-stone-800 hover:bg-stone-700 text-emerald-400 text-xs font-semibold flex items-center justify-center gap-1.5 border border-stone-700/80 transition"
                    >
                      <Navigation className="w-3.5 h-3.5" />
                      <span>查看配送状态</span>
                    </button>
                    {/* 外部地图跳转：拼的是**真实的**收餐地址，不是模拟导航。 */}
                    <a
                      href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(item.address_line)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-full py-2 rounded-xl bg-stone-800 hover:bg-stone-700 text-sky-400 text-xs font-semibold flex items-center justify-center gap-1.5 border border-stone-700/80 transition"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>外部地图APP</span>
                    </a>
                  </div>

                  <div className="flex items-center justify-between text-xs pt-1 border-t border-slate-800/80">
                    <a
                      href={`tel:${item.recipient_phone}`}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 text-teal-400 hover:bg-slate-700 flex items-center gap-1.5 font-medium text-[11px]"
                    >
                      <Phone className="w-3.5 h-3.5" />
                      <span>{t.staff.call_customer}</span>
                    </a>

                    {item.rider_status !== 'picked_up' ? (
                      <button
                        onClick={() => handleDeliveryStatusAdvance(item.id, 'picked_up')}
                        className="px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-500 text-white font-semibold text-[11px]"
                      >
                        {t.staff.mark_picked_up}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleDeliveryStatusAdvance(item.id, 'delivered')}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-[11px]"
                      >
                        {t.staff.mark_delivered}
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* VIEW 5: RESERVATIONS (/reservations conforming to §5.6) */}
      {tab === 'reservations' && (
        <div className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-sm text-white">预订到店确认</h2>
            <span className="text-[11px] text-slate-400">今日安排</span>
          </div>

          {reservationFeedback && (
            <div className="p-2.5 bg-rose-950/70 border border-rose-700/60 rounded-xl text-[11px] text-rose-200 flex items-center gap-2">
              <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
              <span>{reservationFeedback}</span>
            </div>
          )}

          {reservations.length === 0 ? (
            <div className="text-center py-12 text-xs text-slate-500 bg-slate-900 border border-slate-800 rounded-2xl">
              {t.staff.no_reservations}
            </div>
          ) : (
            <div className="space-y-2.5">
              {reservations.map((res) => (
                <div
                  key={res.id}
                  className="bg-slate-900 border border-slate-800 p-3.5 rounded-2xl space-y-2 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <div className="font-semibold text-white">
                      {res.customer_name} ({res.party_size}位)
                    </div>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        res.status === 'confirmed'
                          ? 'bg-teal-500/20 text-teal-300'
                          : res.status === 'arrived'
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : res.status === 'cancelled'
                          ? 'bg-slate-800 text-slate-400'
                          : 'bg-amber-500/20 text-amber-300'
                      }`}
                    >
                      {res.status}
                    </span>
                  </div>

                  <div className="text-slate-300 flex items-center justify-between">
                    <span>到店时间: {fmtDateTime(res.reserved_at, locale)}</span>
                    <a href={`tel:${res.phone}`} className="text-teal-400 hover:underline flex items-center gap-1">
                      <Phone className="w-3 h-3" />
                      <span>{res.phone}</span>
                    </a>
                  </div>

                  {res.notes && (
                    <div className="text-[11px] text-slate-400 bg-slate-950/60 p-2 rounded-lg">
                      备注: {res.notes}
                    </div>
                  )}

                  <div className="flex gap-2 pt-1">
                    {res.status === 'pending' && (
                      <button
                        onClick={() => handleReservationAction(res.id, 'confirmed')}
                        className="flex-1 py-1.5 bg-teal-600 hover:bg-teal-500 text-white rounded-lg font-medium text-[11px]"
                      >
                        {t.staff.confirm_reservation}
                      </button>
                    )}
                    {res.status === 'confirmed' && (
                      <button
                        onClick={() => handleReservationAction(res.id, 'arrived')}
                        className="flex-1 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-medium text-[11px]"
                      >
                        {t.staff.mark_arrived}
                      </button>
                    )}
                    {res.status !== 'cancelled' && res.status !== 'arrived' && (
                      <button
                        onClick={() => handleReservationAction(res.id, 'cancelled')}
                        className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-[11px]"
                      >
                        {t.staff.cancel_reservation}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* VIEW 6: ME (/me conforming to §5.7) */}
      {tab === 'me' && (
        <div className="p-4 space-y-4">
          {/* Profile Card (Read-only) */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-teal-500/20 text-teal-400 flex items-center justify-center font-bold text-base border border-teal-500/40">
                {staffMe?.staff.name.slice(0, 2) ?? ''}
              </div>
              <div>
                <h3 className="font-bold text-sm text-white">{staffMe?.staff.name ?? ''}</h3>
                {employeeRole && <div className="text-xs text-teal-400">{employeeRole}</div>}
                {hiredAt && (
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    入职日期: {hiredAt} (只读，修改请找店长)
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Privacy Switch (§5.7 Birthday Opt-in) */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold text-xs text-white">{t.staff.privacy_opt_in}</div>
                <div className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                  {t.staff.privacy_opt_in_desc}
                </div>
              </div>
              <input
                type="checkbox"
                checked={privacyOptIn}
                onChange={(e) => handlePrivacyToggle(e.target.checked)}
                className="w-5 h-5 rounded text-teal-500 bg-slate-950 border-slate-700 mt-1 cursor-pointer"
                id="staff-privacy-opt-in-check"
              />
            </div>
            {privacyError && (
              <div className="p-2.5 bg-rose-950/70 border border-rose-700/60 rounded-xl text-[11px] text-rose-200">
                {privacyError}
              </div>
            )}
          </div>

          {/*
            Personal Data Export (§5.7 数据权利)。
            后端 `GET /api/staff/export` 只导出**会话本人**的数据（员工档案、
            考勤、排班，以及按老板端同一套可见性规则筛出的关怀记录），
            并会为每一次导出写一条审计 —— 卡片上的说明如实写出来，
            免得员工以为这是"老板看不见的一次性操作"。
          */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2">
            <div className="font-semibold text-xs text-white">{t.staff.export_my_data}</div>
            <div className="text-[11px] text-slate-400 leading-relaxed">
              导出内容仅限你本人：员工档案、考勤记录、排班，以及你有权查看的关怀记录。每次导出都会记入审计日志。
            </div>
            <button
              onClick={handleExportData}
              disabled={isExporting}
              className="w-full py-2.5 rounded-xl bg-teal-600/90 hover:bg-teal-500 text-white font-medium text-xs flex items-center justify-center gap-2 transition disabled:opacity-50"
              id="staff-export-data-btn"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{isExporting ? '正在导出...' : t.staff.export_my_data}</span>
            </button>
            {exportError && (
              <div className="p-2.5 bg-rose-950/70 border border-rose-700/60 rounded-xl text-[11px] text-rose-200">
                {exportError}
              </div>
            )}
          </div>

          {/* Care Resources Directory (Hard rule: strictly NO questionnaires or scoring!) */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
            <div className="flex items-center gap-1.5 text-teal-400 font-semibold text-xs">
              <HeartHandshake className="w-4 h-4" />
              <span>{t.staff.care_resources}</span>
            </div>
            <div className="text-[10px] text-slate-400 leading-relaxed">
              严格遵循隐私保护原则：本页面仅提供正规外部支持热线与自助指引，不进行任何心理测评、问卷或情绪打分。
            </div>

            {careResources.length === 0 ? (
              <div className="text-center py-4 text-[11px] text-slate-500">
                暂无可用的支持资源
              </div>
            ) : (
              <div className="space-y-2">
                {careResources.map((res, i) => (
                  <div key={`${res.title}-${i}`} className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1">
                    <div className="font-semibold text-xs text-slate-200">{res.title}</div>
                    <div className="text-[11px] text-slate-400 leading-relaxed">{res.description}</div>
                    <div className="pt-1 flex items-center justify-between text-[11px]">
                      {res.phone && (
                        <a href={`tel:${res.phone}`} className="text-teal-400 font-mono flex items-center gap-1">
                          <Phone className="w-3 h-3" />
                          <span>{res.phone}</span>
                        </a>
                      )}
                      {res.url && (
                        <a href={res.url} target="_blank" rel="noopener noreferrer" className="text-teal-400 hover:underline">
                          访问官方支持机构 &rarr;
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {logoutError && (
            <div className="p-2.5 bg-rose-950/70 border border-rose-700/60 rounded-xl text-[11px] text-rose-200">
              退出登录失败：{logoutError}
            </div>
          )}

          {/* Logout button —— 真的清 cookie，不是把本地布尔值翻成 false */}
          <button
            onClick={handleLogout}
            disabled={isLoggingOut}
            className="w-full py-2.5 rounded-xl bg-rose-950/50 hover:bg-rose-950 text-rose-300 font-medium text-xs flex items-center justify-center gap-2 border border-rose-900/60 transition disabled:opacity-50"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>{isLoggingOut ? '正在退出...' : t.staff.logout}</span>
          </button>
        </div>
      )}

      {/* Staff Delivery Status Modal（原型的"地图弹窗"换成只显示真实状态的追踪面板） */}
      {mapPresence.mounted && viewingDeliveryMapItem && (
        <div
          className={`fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-3 sm:p-5 backdrop-blur-md overflow-y-auto ${fadeClass(mapPresence.visible)}`}
          onClick={() => setViewingDeliveryMapItem(null)}
        >
          <div
            className={`w-full max-w-2xl ${popClass(mapPresence.visible)}`}
            onClick={(e) => e.stopPropagation()}
          >
            <DeliveryTrackerMap
              order={toTrackableOrder(viewingDeliveryMapItem)}
              onClose={() => setViewingDeliveryMapItem(null)}
              locale={locale}
            />
          </div>
        </div>
      )}
    </StaffShell>
  );
};
