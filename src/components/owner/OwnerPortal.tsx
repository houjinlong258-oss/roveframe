'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Users,
  CalendarDays,
  Clock,
  HeartHandshake,
  Plus,
  Copy,
  Check,
  AlertCircle,
  CheckCircle2,
  Sliders,
} from 'lucide-react';
import {
  Locale,
  TeamMember,
  TeamAttendanceAuditRecord,
  CareSignal,
  CareNote,
} from '@/types';
import { bossApi } from '@/lib/api';
import { fmtDateTime, fmtDuration } from '@/lib/format';
import { getTranslations } from '@/lib/i18n';
import { TierInstallPrompt } from '@/components/pwa/tier-install-prompt';

/**
 * 老板端「团队 / 考勤 / 关怀」界面（挂载在 `/{locale}/team`）。
 *
 * ## 为什么这里只有三个 Tab
 *
 * 原型 `OwnerPortal`（_pwa-review/src/components/owner/OwnerPortal.tsx，1224 行）
 * 是一个 7 Tab 的门店管理门户：dashboard / team / shifts / care / config /
 * analytics / simulations。本次只搬运 **team + 考勤(shifts) + care** 三个面，
 * 另外四个整块移除，理由分别是：
 *
 *   · **dashboard** —— 整个 Tab 是写死的演示数据：一个固定的中文日期、
 *     一笔固定的今日营业额、十条柱状高度数组，以及订单数 / 新增顾客 /
 *     外卖占比 / 顾客评分四个字面量指标。仓库里已经有一个**真实**的
 *     经营仪表盘（`/{locale}/dashboard`，20 个管理页之一），
 *     把编造的数字挂上"经营首页"比没有这一页更糟。
 *   · **analytics** —— 同样是字面量：一笔固定的本月营业额、12 条柱状高度、
 *     三个固定的横轴刻度、以及热门菜品 TOP5（菜名 / 金额 / 份数全是编的）。
 *     没有任何 `bossApi` 方法为它提供数据。
 *   · **simulations** —— §9 的验收仿真开关（把 409 冲突注入前端）。
 *     它调用的 `bossApi.resetAllDemoData()` 在 `src/lib/api.ts`
 *     （本次不得修改）里**不存在**，这个 Tab 连类型都过不了。
 *   · **config** —— 门店经营模式与配送配置。它走 `customerApi.getSiteConfig()`，
 *     而那个方法的默认参数是一个写死的演示 slug（`'grove-bistro'`，库里没有
 *     这个站），并且这一能力已经由后台既有的官网/设置页面承担。
 *
 * 因此**不需要**额外的薄包装层：直接把这四个 Tab 从本组件里去掉，
 * 剩下的就是能接真实数据的三块。`OwnerTab` 也因此只保留三个值。
 *
 * ## 与真实数据对齐时必须改的地方
 *
 *   1. `Promise.all` + 空 `catch` → `Promise.allSettled` + 逐项失败提示。
 *   2. 补卡（§6.2）原型选的是**员工**，而 `bossApi.retroactiveClock` 与后端
 *      `PATCH /api/team/attendance?id=` 都按**考勤记录 id** 定位。按员工定位在
 *      "一个人有多条班次记录"时会改错行，所以这里改成选记录，时间也从该记录预填。
 *   3. 邀请链接：原型把 `{ invite_url }` **整个对象**交给 `clipboard.writeText`
 *      （复制出来是 `[object Object]`），并且不管结果如何都显示"已复制"。
 *      现在会收窄 `invite_url`、区分"已复制/请手动复制/失败"三种结果。
 *   4. 所有静默 `catch {}` 全部改成可见的错误提示。
 *
 * ## 已知缺口：部分文案没有 i18n 键（本次修不了）
 *
 * 原型这部分界面是**中文单语**的：Tab 名与表格列头里，只有
 * `t.team.tab_directory` / `t.team.tab_attendance` / `t.team.retro_clock` 等少数
 * 走了 `getTranslations`，其余（"团队关怀中心"、"员工姓名"、"审计合规事由"…）
 * 都是写死的中文。`src/lib/i18n.ts` 里也确实没有对应键，而该文件在本次任务的
 * 禁改清单里。结果：`/en/team` 与 `/es/team` 会把这几处中文原样渲染出来。
 * 校验/列头这类界面文案若要三语化，需要先往 `i18n.ts` 补键（另一个改动）。
 */

/** 只保留能接真实数据的三块。原型里另外四个 Tab 见文件头。 */
export type OwnerTab = 'team' | 'shifts' | 'care';

interface OwnerPortalProps {
  locale: Locale;
}

/** 与 staff tier 同形态：后端错误对象上有 `error` 字段。 */
function describeError(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'error' in err) {
    const message = (err as { error?: unknown }).error;
    if (typeof message === 'string' && message) return message;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * 邀请链接收窄。
 *
 * `bossApi.generateInviteUrl` 的类型声明是 `{ invite_url: string }`，但后端
 * `/api/team/invite` 的 201 响应里那一行是
 * `invite_url: (invited.user as ...).invite_link ?? null` —— **运行时可能是 null**。
 * 把这个值直接交给 `clipboard.writeText` 会写出字符串 "null" 并显示"已复制"，
 * 被邀请人永远登不进来。所以必须自己收窄，拿不到就当失败。
 */
function readInviteUrl(result: { invite_url: string }): string | null {
  const value = (result as { invite_url?: unknown }).invite_url;
  return typeof value === 'string' && value ? value : null;
}

/**
 * 补卡事由。
 *
 * `GET /api/team/attendance` 实际返回的是 `note` 列（写入时是
 * `"<理由>（补卡 by <uid>）"`），而已 vendor 的 `TeamAttendanceAuditRecord`
 * （本次不许改）声明的是 `audit_reason`。两个都读，都没有才当作"正常考勤"。
 */
function readAuditReason(record: TeamAttendanceAuditRecord): string | null {
  if (typeof record.audit_reason === 'string' && record.audit_reason) return record.audit_reason;
  const note = (record as TeamAttendanceAuditRecord & { note?: unknown }).note;
  return typeof note === 'string' && note ? note : null;
}

/**
 * ISO 时间戳 → `<input type="datetime-local">` 需要的**本地**时间字符串。
 * 不能直接用 `toISOString()`：那是 UTC，会让补卡时间整体偏移一个时区。
 */
function toLocalInputValue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type InviteOutcome =
  | { staffId: string; kind: 'copied' }
  | { staffId: string; kind: 'manual'; url: string };

export const OwnerPortal: React.FC<OwnerPortalProps> = ({ locale }) => {
  const t = getTranslations(locale);
  const [activeTab, setActiveTab] = useState<OwnerTab>('team');

  // Data states
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [attendanceAudits, setAttendanceAudits] = useState<TeamAttendanceAuditRecord[]>([]);
  const [careSignals, setCareSignals] = useState<CareSignal[]>([]);
  const [careNotes, setCareNotes] = useState<CareNote[]>([]);
  const [loadFailures, setLoadFailures] = useState<string[]>([]);

  // Modal & feedback states
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);
  const [showMemberModal, setShowMemberModal] = useState(false);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [showRetroClockModal, setShowRetroClockModal] = useState(false);
  const [showAddCareNoteModal, setShowAddCareNoteModal] = useState(false);
  const [inviteOutcome, setInviteOutcome] = useState<InviteOutcome | null>(null);
  const [inviteError, setInviteError] = useState<{ staffId: string; message: string } | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [careError, setCareError] = useState<string | null>(null);

  // 补卡（§6.2）：按**考勤记录**定位，时间从该记录预填
  const [retroAttendanceId, setRetroAttendanceId] = useState<string>('');
  const [retroInTime, setRetroInTime] = useState<string>('');
  const [retroOutTime, setRetroOutTime] = useState<string>('');
  const [retroAuditReason, setRetroAuditReason] = useState<string>('');
  const [retroError, setRetroError] = useState<string | null>(null);

  // 关怀备忘（§6.3）
  const [noteStaffId, setNoteStaffId] = useState<string>('');
  const [noteContent, setNoteContent] = useState<string>('');

  const loadAllOwnerData = useCallback(async () => {
    // 逐项结算：原型把 4 个请求塞进一个 Promise.all 加一个空 catch，
    // 任意一个失败都会让整页空白且没有任何提示。
    const [teamR, auditsR, signalsR, notesR] = await Promise.allSettled([
      bossApi.getTeamMembers(),
      bossApi.getAttendanceRecords(),
      bossApi.getCareSignals(),
      bossApi.getCareNotes(),
    ]);

    const failures: string[] = [];

    if (teamR.status === 'fulfilled') {
      setTeamMembers(teamR.value);
      if (teamR.value.length > 0) {
        setNoteStaffId((prev) => prev || teamR.value[0].id);
      }
    } else {
      failures.push(`员工档案：${describeError(teamR.reason, '加载失败')}`);
    }

    if (auditsR.status === 'fulfilled') {
      setAttendanceAudits(auditsR.value);
    } else {
      failures.push(`考勤记录：${describeError(auditsR.reason, '加载失败')}`);
    }

    if (signalsR.status === 'fulfilled') {
      setCareSignals(signalsR.value);
    } else {
      failures.push(`关怀信号：${describeError(signalsR.reason, '加载失败')}`);
    }

    if (notesR.status === 'fulfilled') {
      setCareNotes(notesR.value);
    } else {
      failures.push(`关怀记录：${describeError(notesR.reason, '加载失败')}`);
    }

    setLoadFailures(failures);
  }, []);

  useEffect(() => {
    void loadAllOwnerData();
  }, [loadAllOwnerData]);

  // 提示条 3 秒后自动消失（纯 UI 计时，不涉及数据）
  useEffect(() => {
    if (!toastMessage) return;
    const timer = setTimeout(() => setToastMessage(null), 3000);
    return () => clearTimeout(timer);
  }, [toastMessage]);

  /**
   * 生成并复制邀请链接。
   *
   * 三个必须分开的结果（原型把它们混成了一个"已复制"）：
   *   · 拿到链接且剪贴板可用 → copied
   *   · 拿到链接但剪贴板不可用（http 访问等非安全上下文）→ manual，把链接显示出来让店长自己复制
   *   · 任何失败（500 / 409 already_linked / invite_url 为 null）→ inviteError，原样显示后端消息
   */
  const handleGenerateInvite = async (member: TeamMember) => {
    setInviteError(null);
    setInviteOutcome(null);
    try {
      const result = await bossApi.generateInviteUrl(member.id, member.email);
      const url = readInviteUrl(result);
      if (!url) {
        setInviteError({
          staffId: member.id,
          message:
            '后端没有返回可用的邀请链接（invite_url 为 null）。' +
            '这通常是上游 admin API 没有给出 invite_link，请稍后重试或联系开发者。',
        });
        return;
      }
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (!clipboard?.writeText) {
        setInviteOutcome({ staffId: member.id, kind: 'manual', url });
        return;
      }
      await clipboard.writeText(url);
      setInviteOutcome({ staffId: member.id, kind: 'copied' });
    } catch (err: unknown) {
      setInviteError({ staffId: member.id, message: describeError(err, '邀请链接生成失败') });
    }
  };

  /** 补卡提交（§6.2：审计原因严格必填，记录按 id 定位）。 */
  const handleRetroactiveClockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRetroError(null);

    const reason = retroAuditReason.trim();
    if (!reason) {
      setRetroError(t.team.retro_reason_required);
      return;
    }
    const record = attendanceAudits.find((a) => a.id === retroAttendanceId);
    if (!record) {
      setRetroError('请选择要修正的考勤记录');
      return;
    }
    // `<input type="datetime-local">` 给的是本地时间字符串；Date.parse 会按本地时区解析，
    // 转成 ISO 再交给后端（后端做 Date.parse + toISOString，两边语义一致）。
    const inMs = Date.parse(retroInTime);
    if (!Number.isFinite(inMs)) {
      setRetroError('补卡上班时间无法解析，请重新选择');
      return;
    }
    const outMs = Date.parse(retroOutTime);
    if (!Number.isFinite(outMs)) {
      setRetroError('补卡下班时间无法解析，请重新选择');
      return;
    }

    try {
      await bossApi.retroactiveClock(
        record.staff_id,
        record.staff_name,
        new Date(inMs).toISOString(),
        new Date(outMs).toISOString(),
        reason,
        record.id,
      );
      setAttendanceAudits(await bossApi.getAttendanceRecords());
      setShowRetroClockModal(false);
      setRetroAuditReason('');
      setToastMessage('补卡记录已安全写入出勤审计库');
    } catch (err: unknown) {
      setRetroError(describeError(err, '补卡保存失败'));
    }
  };

  /** 关怀信号决策（§6.3）。 */
  const handleCareSignalDecision = async (signalId: string, decision: 'accept' | 'dismiss') => {
    setCareError(null);
    try {
      await bossApi.handleCareSignal(signalId, decision);
      setCareSignals(await bossApi.getCareSignals());
      setToastMessage(decision === 'accept' ? '关怀建议已采纳，转为待审批流程' : '关怀建议已忽略');
    } catch (err: unknown) {
      setCareError(describeError(err, '关怀建议处理失败'));
    }
  };

  /** 新增 1 对 1 关怀备忘（§6.3）。 */
  const handleCreateCareNote = async (e: React.FormEvent) => {
    e.preventDefault();
    setCareError(null);
    const content = noteContent.trim();
    if (!content || !noteStaffId) {
      setCareError('请选择员工并填写沟通内容');
      return;
    }
    try {
      await bossApi.createCareNote(noteStaffId, content);
      setCareNotes(await bossApi.getCareNotes());
      setShowAddCareNoteModal(false);
      setNoteContent('');
      setToastMessage('员工1对1关怀沟通记录已加密存档');
    } catch (err: unknown) {
      setCareError(describeError(err, '关怀备忘保存失败'));
    }
  };

  /** 选中一条考勤记录后，把它的时间预填进补卡表单。 */
  const handleSelectRetroRecord = (id: string) => {
    setRetroAttendanceId(id);
    const record = attendanceAudits.find((a) => a.id === id);
    setRetroInTime(toLocalInputValue(record?.clock_in_at ?? null));
    setRetroOutTime(toLocalInputValue(record?.clock_out_at ?? null));
  };

  const openRetroClockModal = () => {
    setRetroError(null);
    setShowRetroClockModal(true);
    // 默认选第一条记录，并同步预填时间 —— 让"选中的记录"与"填着的时间"永远一致。
    const first = attendanceAudits[0];
    if (first) handleSelectRetroRecord(first.id);
  };

  const tabs: { id: OwnerTab; label: string; icon: React.FC<{ className?: string }> }[] = [
    { id: 'team', label: t.team.tab_directory, icon: Users },
    // 原型这个 Tab 的导航文案用的是"排班管理"，但内容全是考勤审计（§6.2）。
    // 这里改用"考勤明细"，与页面真正在做的事一致。
    { id: 'shifts', label: t.team.tab_attendance, icon: CalendarDays },
    { id: 'care', label: '团队关怀中心', icon: HeartHandshake },
  ];

  return (
    <div className="rf-owner min-h-screen bg-slate-100 text-slate-900 font-sans antialiased">
      {/* Top Banner & Header */}
      <header className="rf-owner-header bg-slate-900 text-white shadow-md sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-teal-600 flex items-center justify-center font-black text-amber-300 text-sm shadow-xs">
              RF
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-bold text-sm tracking-tight">RoveFrame · 门店管理中心</h1>
                <span className="px-2 py-0.2 bg-teal-900 text-teal-300 text-[10px] font-semibold rounded-full border border-teal-700">
                  团队与考勤
                </span>
              </div>
              {/*
                原型这里显示店名，取值是"按写死的演示 slug 取站点配置，取不到就回落
                一个编好的店名"。`bossApi` 里没有任何方法能给出本门店的名称，
                所以这一行直接去掉 —— 少一行不等于少功能，但显示一个不属于本门店的
                店名会让店长以为进错了店。
              */}
              <p className="text-[11px] text-slate-400">
                员工档案 · 考勤审计 · 团队关怀
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-400 hidden sm:inline">当前身份: 店长 / 店东</span>
            <Sliders className="w-4 h-4 text-slate-500" />
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="rf-owner-tabs max-w-6xl mx-auto px-4 flex gap-2 border-t border-slate-800 overflow-x-auto scrollbar-none text-xs font-medium">
          {tabs.map((tabItem) => {
            const Icon = tabItem.icon;
            const active = activeTab === tabItem.id;
            return (
              <button
                key={tabItem.id}
                onClick={() => setActiveTab(tabItem.id)}
                className={`flex items-center gap-2 py-3 px-3.5 border-b-2 transition whitespace-nowrap ${
                  active
                    ? 'border-teal-400 text-teal-300 font-semibold'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
                id={`owner-tab-${tabItem.id}`}
              >
                <Icon className="w-4 h-4" />
                <span>{tabItem.label}</span>
              </button>
            );
          })}
        </div>
      </header>

      {/* Main Container */}
      <main className="rf-owner-main max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* PWA Install Banner */}
        <div className="rf-owner-install">
          <TierInstallPrompt appName="RoveFrame Owner" />
        </div>

        {/* Global Toast */}
        {toastMessage && (
          <div className="p-3.5 bg-teal-800 text-white rounded-xl text-xs flex items-center gap-2 shadow-lg">
            <CheckCircle2 className="w-4 h-4 text-amber-300 shrink-0" />
            <span>{toastMessage}</span>
          </div>
        )}

        {/* 分区加载失败：逐条说明哪一块没读到 */}
        {loadFailures.length > 0 && (
          <div className="p-3.5 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-xs space-y-1">
            <div className="flex items-center gap-2 font-semibold">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>以下数据没有加载成功</span>
            </div>
            {loadFailures.map((failure) => (
              <div key={failure} className="pl-6 leading-relaxed">
                · {failure}
              </div>
            ))}
          </div>
        )}

        {/* TAB 1: TEAM MEMBERS (§6.1) */}
        {activeTab === 'team' && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-bold text-slate-900">{t.team.tab_directory}</h2>
                <p className="text-xs text-slate-500">
                  管理员工档案、岗位薪资、入职日期及账号激活邀请链接。
                </p>
              </div>
              <button
                onClick={() => {
                  setMemberError(null);
                  setEditingMember({
                    id: '',
                    name: '',
                    position: 'Service Crew',
                    phone: '',
                    email: '',
                    employment_type: 'full_time',
                    hourly_rate: '20.00',
                    hired_at: new Date().toISOString().slice(0, 10),
                    birthday: '',
                    status: 'active',
                    is_active: true,
                    user_id: null,
                    has_account: false,
                  });
                  setShowMemberModal(true);
                }}
                className="px-3.5 py-2 bg-teal-800 hover:bg-teal-900 text-white rounded-xl text-xs font-semibold flex items-center gap-1.5 shadow-xs transition"
                id="add-team-member-btn"
              >
                <Plus className="w-4 h-4" />
                <span>{t.team.add_member}</span>
              </button>
            </div>

            {teamMembers.length === 0 ? (
              <div className="bg-white p-8 rounded-2xl border border-slate-200 text-center text-xs text-slate-400">
                暂无员工档案
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {teamMembers.map((member) => (
                  <div
                    key={member.id}
                    className="bg-white rounded-2xl border border-slate-200/90 p-4.5 shadow-2xs hover:shadow-xs transition space-y-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <div className="w-10 h-10 rounded-xl bg-teal-50 text-teal-800 font-bold flex items-center justify-center text-sm border border-teal-200/60">
                          {member.name.slice(0, 2)}
                        </div>
                        <div>
                          <h3 className="font-bold text-sm text-slate-900">{member.name}</h3>
                          <div className="text-[11px] text-teal-700 font-medium">{member.position}</div>
                        </div>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                          member.has_account
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : 'bg-amber-50 text-amber-700 border border-amber-200'
                        }`}
                      >
                        {member.has_account ? '已关联账号' : '待激活'}
                      </span>
                    </div>

                    <div className="text-xs space-y-1 text-slate-600 bg-slate-50 p-2.5 rounded-xl">
                      <div className="flex justify-between">
                        <span className="text-slate-400">用工类型:</span>
                        <span className="font-medium">
                          {member.employment_type === 'full_time'
                            ? '全职'
                            : member.employment_type === 'part_time'
                              ? '兼职'
                              : '合同制'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">时薪标准:</span>
                        {/* 时薪是档案里的自由文本（`hourly_rate: string`），不做数值假设，
                            只把币种符号与来源讲清楚：与项目"海外默认 USD"一致。*/}
                        <span className="font-medium font-mono">${member.hourly_rate} / hr</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">入职日期:</span>
                        <span className="font-medium">{member.hired_at}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">联系电话:</span>
                        <span className="font-medium">{member.phone || '未填写'}</span>
                      </div>
                    </div>

                    {/* 邀请结果：成功 / 需手动复制 / 失败，三种都要看得见 */}
                    {inviteOutcome?.staffId === member.id && inviteOutcome.kind === 'manual' && (
                      <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-[10px] text-amber-800 break-all">
                        当前环境无法访问剪贴板，请手动复制邀请链接：
                        <div className="mt-1 font-mono">{inviteOutcome.url}</div>
                      </div>
                    )}
                    {inviteError?.staffId === member.id && (
                      <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-lg text-[10px] text-rose-700 leading-relaxed">
                        邀请链接生成失败：{inviteError.message}
                      </div>
                    )}

                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={() => handleGenerateInvite(member)}
                        className="flex-1 py-1.5 px-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-medium flex items-center justify-center gap-1 transition"
                        title="生成员工端 PWA 登录激活链接"
                      >
                        {inviteOutcome?.staffId === member.id && inviteOutcome.kind === 'copied' ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-600" />
                            <span className="text-emerald-700 font-semibold">{t.team.invite_success}</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span>{t.team.invite_account}</span>
                          </>
                        )}
                      </button>
                      <button
                        onClick={() => {
                          setMemberError(null);
                          setEditingMember(member);
                          setShowMemberModal(true);
                        }}
                        className="px-3 py-1.5 bg-teal-50 hover:bg-teal-100 text-teal-800 rounded-lg text-xs font-semibold transition"
                      >
                        编辑档案
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 2: ATTENDANCE AUDIT (§6.2) */}
        {activeTab === 'shifts' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-bold text-slate-900">{t.team.tab_attendance}</h2>
                <p className="text-xs text-slate-500">
                  出勤打卡数据合规审计。支持店长合规补卡（审计原因严格必填）。
                </p>
              </div>
              <button
                onClick={openRetroClockModal}
                disabled={attendanceAudits.length === 0}
                className="px-3.5 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold rounded-xl text-xs flex items-center gap-1.5 shadow-xs transition disabled:opacity-50"
                id="retroactive-punch-btn"
              >
                <Clock className="w-4 h-4" />
                <span>{t.team.retro_clock}</span>
              </button>
            </div>

            {/* Attendance Audit Log Table */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-2xs overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-slate-50 text-slate-500 font-medium border-b border-slate-200">
                      <th className="py-3 px-4">员工姓名</th>
                      <th className="py-3 px-4">上班打卡时间</th>
                      <th className="py-3 px-4">下班签退时间</th>
                      <th className="py-3 px-4">核定工时</th>
                      <th className="py-3 px-4">数据来源</th>
                      <th className="py-3 px-4">审计合规事由</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {attendanceAudits.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-slate-400">
                          所选时间范围内暂无考勤记录
                        </td>
                      </tr>
                    ) : (
                      attendanceAudits.map((aud) => {
                        const reason = readAuditReason(aud);
                        return (
                          <tr key={aud.id} className="hover:bg-slate-50/70 transition">
                            <td className="py-3 px-4 font-semibold text-slate-900">
                              {aud.staff_name}
                            </td>
                            <td className="py-3 px-4 font-mono text-slate-600">
                              {fmtDateTime(aud.clock_in_at, locale)}
                            </td>
                            <td className="py-3 px-4 font-mono text-slate-600">
                              {aud.clock_out_at ? fmtDateTime(aud.clock_out_at, locale) : '打卡进行中'}
                            </td>
                            <td className="py-3 px-4 font-semibold text-teal-800 font-mono">
                              {aud.worked_minutes == null ? '—' : fmtDuration(aud.worked_minutes, locale)}
                            </td>
                            <td className="py-3 px-4">
                              <span
                                className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                  aud.clock_in_source === 'staff_pwa'
                                    ? 'bg-teal-50 text-teal-700 border border-teal-200'
                                    : 'bg-amber-50 text-amber-700 border border-amber-200'
                                }`}
                              >
                                {aud.clock_in_source === 'staff_pwa' ? '员工自主打卡' : '店长补卡'}
                              </span>
                            </td>
                            <td className="py-3 px-4 text-slate-500 max-w-xs truncate">
                              {reason ?? '正常考勤'}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: TEAM CARE CENTER (§6.3) */}
        {activeTab === 'care' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-bold text-slate-900">团队关怀中心</h2>
                <p className="text-xs text-slate-500">
                  员工生理健康周期、连续出勤高负荷关怀信号，及严格受控的 1 对 1 沟通备忘录。
                </p>
              </div>
              <button
                onClick={() => {
                  setCareError(null);
                  setShowAddCareNoteModal(true);
                }}
                className="px-3.5 py-2 bg-teal-800 hover:bg-teal-900 text-white rounded-xl text-xs font-semibold flex items-center gap-1.5 shadow-xs transition"
              >
                <Plus className="w-4 h-4" />
                <span>记录 1对1 关怀沟通</span>
              </button>
            </div>

            {careError && (
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{careError}</span>
              </div>
            )}

            {/* Care Signals List */}
            <div className="space-y-3">
              <h3 className="font-semibold text-xs text-slate-700">系统关怀信号识别</h3>
              {careSignals.length === 0 ? (
                <div className="bg-white p-8 rounded-2xl border border-slate-200 text-center text-xs text-slate-400">
                  暂无待处理的关怀信号
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                  {careSignals.map((sig) => (
                    <div
                      key={sig.id}
                      className="bg-white rounded-2xl border border-slate-200 p-4 shadow-2xs space-y-3"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-lg bg-amber-50 text-amber-700 flex items-center justify-center font-bold">
                            <HeartHandshake className="w-4 h-4" />
                          </div>
                          <div>
                            <div className="font-bold text-xs text-slate-900">{sig.title}</div>
                            <div className="text-[10px] text-teal-700">{sig.staff_name}</div>
                          </div>
                        </div>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            sig.status === 'open'
                              ? 'bg-amber-100 text-amber-800'
                              : sig.status === 'awaiting_approval'
                              ? 'bg-purple-100 text-purple-800'
                              : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          {sig.status === 'open'
                            ? '待处理'
                            : sig.status === 'awaiting_approval'
                            ? '转入审批中'
                            : '已忽略'}
                        </span>
                      </div>

                      <p className="text-xs text-slate-600 leading-relaxed bg-slate-50 p-2.5 rounded-xl">
                        {sig.detail}
                      </p>

                      {sig.status === 'open' && (
                        <div className="flex gap-2 pt-1">
                          <button
                            onClick={() => handleCareSignalDecision(sig.id, 'accept')}
                            className="flex-1 py-1.5 bg-teal-800 hover:bg-teal-900 text-white rounded-lg font-semibold text-xs transition"
                          >
                            采纳并流转审批
                          </button>
                          <button
                            onClick={() => handleCareSignalDecision(sig.id, 'dismiss')}
                            className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-xs transition"
                          >
                            暂不处理
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 1-on-1 Notes List */}
            <div className="space-y-3 pt-4 border-t border-slate-200">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-xs text-slate-700">1 对 1 关怀沟通记录（仅对沟通双方授权可见）</h3>
                <span className="text-[11px] text-slate-400">已执行受控权限过滤</span>
              </div>

              {careNotes.length === 0 ? (
                <div className="bg-white p-8 rounded-2xl border border-slate-200 text-center text-xs text-slate-400">
                  暂无 1 对 1 关怀记录
                </div>
              ) : (
                <div className="space-y-2.5">
                  {careNotes.map((note) => {
                    const member = teamMembers.find((m) => m.id === note.staff_id);
                    return (
                      <div key={note.id} className="bg-white p-4 rounded-2xl border border-slate-200 space-y-1.5 text-xs">
                        <div className="flex items-center justify-between text-slate-500">
                          <span className="font-semibold text-slate-800">
                            针对员工: {member?.name ?? note.staff_id}
                          </span>
                          <span className="font-mono text-[11px]">{fmtDateTime(note.created_at, locale)}</span>
                        </div>
                        <p className="text-slate-700 leading-relaxed bg-slate-50 p-2.5 rounded-xl">
                          {note.content}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* RETROACTIVE CLOCK MODAL (§6.2 Mandatory reason) */}
      {showRetroClockModal && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 backdrop-blur-xs"
          onClick={() => setShowRetroClockModal(false)}
        >
          <div
            className="bg-white rounded-2xl max-w-md w-full p-5 space-y-4 shadow-2xl text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <h3 className="font-bold text-sm text-slate-900 flex items-center gap-1.5">
                <Clock className="w-4 h-4 text-amber-600" />
                <span>店长合规补卡登记</span>
              </h3>
              <button onClick={() => setShowRetroClockModal(false)} className="text-slate-400 hover:text-slate-600">
                &times;
              </button>
            </div>

            {retroError && (
              <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg">
                {retroError}
              </div>
            )}

            <form onSubmit={handleRetroactiveClockSubmit} className="space-y-3">
              <div>
                <label className="block text-slate-700 font-medium mb-1">
                  选择要修正的考勤记录
                </label>
                {/*
                  原型这里选的是**员工**。后端 `PATCH /api/team/attendance?id=`
                  按考勤记录定位，`bossApi.retroactiveClock` 也要求 attendanceId ——
                  按员工定位在"一个人有多条班次记录"时会改错行。
                */}
                <select
                  value={retroAttendanceId}
                  onChange={(e) => handleSelectRetroRecord(e.target.value)}
                  className="w-full px-3 py-2 border rounded-xl bg-white"
                >
                  {attendanceAudits.map((aud) => (
                    <option key={aud.id} value={aud.id}>
                      {aud.staff_name} · {fmtDateTime(aud.clock_in_at, locale)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-700 font-medium mb-1">补卡上班时间</label>
                  <input
                    type="datetime-local"
                    required
                    value={retroInTime}
                    onChange={(e) => setRetroInTime(e.target.value)}
                    className="w-full px-2.5 py-1.5 border rounded-xl"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-medium mb-1">补卡下班时间</label>
                  <input
                    type="datetime-local"
                    required
                    value={retroOutTime}
                    onChange={(e) => setRetroOutTime(e.target.value)}
                    className="w-full px-2.5 py-1.5 border rounded-xl"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-700 font-medium mb-1">
                  合规审计原因 <span className="text-rose-500 font-bold">* (严格必填)</span>
                </label>
                <textarea
                  required
                  rows={3}
                  value={retroAuditReason}
                  onChange={(e) => setRetroAuditReason(e.target.value)}
                  placeholder={t.team.retro_reason_required}
                  className="w-full px-3 py-2 border rounded-xl text-xs focus:ring-2 focus:ring-teal-600"
                  id="retroactive-reason-input"
                />
              </div>

              <button
                type="submit"
                className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-xl transition"
                id="submit-retroactive-btn"
              >
                确认写入出勤审计档案
              </button>
            </form>
          </div>
        </div>
      )}

      {/* 1-ON-1 CARE NOTE MODAL */}
      {showAddCareNoteModal && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 backdrop-blur-xs"
          onClick={() => setShowAddCareNoteModal(false)}
        >
          <div
            className="bg-white rounded-2xl max-w-md w-full p-5 space-y-4 shadow-2xl text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <h3 className="font-bold text-sm text-slate-900">记录 1 对 1 关怀沟通备忘</h3>
              <button onClick={() => setShowAddCareNoteModal(false)} className="text-slate-400 hover:text-slate-600">
                &times;
              </button>
            </div>

            {careError && (
              <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg">
                {careError}
              </div>
            )}

            <form onSubmit={handleCreateCareNote} className="space-y-3">
              <div>
                <label className="block text-slate-700 font-medium mb-1">沟通对象员工</label>
                <select
                  value={noteStaffId}
                  onChange={(e) => setNoteStaffId(e.target.value)}
                  className="w-full px-3 py-2 border rounded-xl bg-white"
                >
                  {teamMembers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.position})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-slate-700 font-medium mb-1">沟通纪要与跟进关怀事项</label>
                <textarea
                  required
                  rows={4}
                  value={noteContent}
                  onChange={(e) => setNoteContent(e.target.value)}
                  placeholder="记录关于工时负荷、岗位支持或关怀反馈要点..."
                  className="w-full px-3 py-2 border rounded-xl"
                />
              </div>

              <div className="text-[11px] text-slate-500">
                隐私约束：本条记录仅对店长（作者）和该员工本人授权可见，不会向其他员工公开。
              </div>

              <button
                type="submit"
                className="w-full py-2.5 bg-teal-800 hover:bg-teal-900 text-white font-bold rounded-xl transition"
              >
                保存关怀备忘
              </button>
            </form>
          </div>
        </div>
      )}

      {/* TEAM MEMBER EDIT MODAL */}
      {showMemberModal && editingMember && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 backdrop-blur-xs"
          onClick={() => setShowMemberModal(false)}
        >
          <div
            className="bg-white rounded-2xl max-w-md w-full p-5 space-y-4 shadow-2xl text-xs max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <h3 className="font-bold text-sm text-slate-900">员工人事档案编辑</h3>
              <button onClick={() => setShowMemberModal(false)} className="text-slate-400 hover:text-slate-600">
                &times;
              </button>
            </div>

            {memberError && (
              <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg">
                {memberError}
              </div>
            )}

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setMemberError(null);
                try {
                  await bossApi.addOrUpdateTeamMember(editingMember);
                  setTeamMembers(await bossApi.getTeamMembers());
                  setShowMemberModal(false);
                  setToastMessage('员工档案已保存更新');
                } catch (err: unknown) {
                  // 原型这里没有 try/catch：保存失败时弹窗静静地留着，
                  // 店长会以为自己没点中。
                  setMemberError(describeError(err, '员工档案保存失败'));
                }
              }}
              className="space-y-3"
            >
              <div>
                <label className="block text-slate-700 font-medium mb-1">姓名</label>
                <input
                  type="text"
                  required
                  value={editingMember.name}
                  onChange={(e) => setEditingMember({ ...editingMember, name: e.target.value })}
                  className="w-full px-3 py-1.5 border rounded-xl"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-700 font-medium mb-1">岗位职位</label>
                  <input
                    type="text"
                    required
                    value={editingMember.position}
                    onChange={(e) => setEditingMember({ ...editingMember, position: e.target.value })}
                    className="w-full px-3 py-1.5 border rounded-xl"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-medium mb-1">用工类型</label>
                  {/* `TeamMember.employment_type` 有三个值：full_time / part_time / contract。
                      原型的下拉框只给了前两个，编辑一条合同制档案会把它悄悄改成全职。 */}
                  <select
                    value={editingMember.employment_type}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value !== 'full_time' && value !== 'part_time' && value !== 'contract') return;
                      setEditingMember({ ...editingMember, employment_type: value });
                    }}
                    className="w-full px-3 py-1.5 border rounded-xl bg-white"
                  >
                    <option value="full_time">全职 (Full-time)</option>
                    <option value="part_time">兼职 (Part-time)</option>
                    <option value="contract">合同制 (Contract)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-700 font-medium mb-1">时薪标准 ($/hr)</label>
                  <input
                    type="text"
                    value={editingMember.hourly_rate}
                    onChange={(e) => setEditingMember({ ...editingMember, hourly_rate: e.target.value })}
                    className="w-full px-3 py-1.5 border rounded-xl"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-medium mb-1">入职日期</label>
                  <input
                    type="date"
                    value={editingMember.hired_at}
                    onChange={(e) => setEditingMember({ ...editingMember, hired_at: e.target.value })}
                    className="w-full px-3 py-1.5 border rounded-xl"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-700 font-medium mb-1">联系电话</label>
                <input
                  type="tel"
                  value={editingMember.phone}
                  onChange={(e) => setEditingMember({ ...editingMember, phone: e.target.value })}
                  className="w-full px-3 py-1.5 border rounded-xl"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-medium mb-1">电子邮箱</label>
                <input
                  type="email"
                  value={editingMember.email}
                  onChange={(e) => setEditingMember({ ...editingMember, email: e.target.value })}
                  className="w-full px-3 py-1.5 border rounded-xl"
                />
              </div>

              <button
                type="submit"
                className="w-full py-2.5 bg-teal-800 hover:bg-teal-900 text-white font-bold rounded-xl transition"
              >
                保存员工档案
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
