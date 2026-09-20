import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTenantContext, requireBusinessContext } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';

/**
 * 关怀待办的决定：接受 / 忽略。
 *
 * ## 为什么必须由人决定
 *
 * 这些待办是**信号**（"已连续上班 6 天""生日快到了""这天有排班没打卡"），
 * 不是判定。所以流程刻意是「提出 → 人看 → 接受或忽略」，
 * 没有"自动执行"的分支。忽略（dismiss）是完全合法的结果 ——
 * 如果只允许接受，老板就会开始无视整个页面。
 *
 * ## 副作用必须走既有审批链，不得在这里直接执行
 *
 * "接受"这条路径将来会有真实副作用（例如：给全店发一条生日祝福广播、
 * 给本人推送一条休息提醒、把某天标记为调休）。凡是**对外可见或要花钱**的
 * 动作，本项目的一贯口径是必须先经审批（见 src/lib/agent/approvals.ts 与
 * src/lib/mutation-guard.ts 的说明）。
 *
 * 因此本路由的规则是：
 *   · 有副作用时 → 返回 `{ ok: true, status: 'awaiting_approval', approval_id }`，
 *     **并在这里就停止**，绝不先执行副作用再等审批；
 *   · 无副作用时（当前全部 6 种信号都属于这一类）→ 就地更新状态。
 *
 * 前端必须把 `awaiting_approval` 显示成"等待审批"，不能显示成"已完成" ——
 * 那会让老板以为事情已经办了。
 */

const DECISIONS = ['accept', 'dismiss'] as const;
type Decision = (typeof DECISIONS)[number];
const MAX_DECISION_NOTE = 240;

/**
 * 哪些 kind 的"接受"会产生真实副作用。
 *
 * 目前**是空的**：6 种信号全部只对应"记一笔 / 提示一下"，
 * 没有任何对外发送或资金动作。保留这份清单而不是删掉它，是为了让
 * "新增一个带副作用的信号"有一个必须显式登记的位置 ——
 * 不登记就会走进下面 `awaiting_approval` 的分支被拦下，而不是静默执行。
 */
const SIDE_EFFECT_KINDS: ReadonlySet<string> = new Set<string>();

async function decideTask(
  request: NextRequest,
  routeContext: { params: Promise<{ id: string }> },
) {
  const context = requireBusinessContext(await getTenantContext(request));

  const { id } = await routeContext.params;
  const taskId = typeof id === 'string' ? id.trim() : '';
  if (!taskId || taskId.length > 36) {
    return NextResponse.json({ error: 'invalid task id' }, { status: 400 });
  }

  let body: { decision?: unknown; note?: unknown };
  try {
    body = (await request.json()) as { decision?: unknown; note?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const decision = typeof body.decision === 'string' ? body.decision.trim() : '';
  if (!(DECISIONS as readonly string[]).includes(decision)) {
    return NextResponse.json(
      { error: `decision must be one of ${DECISIONS.join(', ')}` },
      { status: 400 },
    );
  }
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length > MAX_DECISION_NOTE) {
    return NextResponse.json(
      { error: `note must be at most ${MAX_DECISION_NOTE} characters` },
      { status: 400 },
    );
  }

  const client = getSupabaseClient();
  const { data: task, error: lookupError } = await client
    .from('staff_care_tasks')
    .select('id, staff_id, kind, status, signal_key')
    .eq('id', taskId)
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId)
    .maybeSingle();
  if (lookupError) return NextResponse.json({ error: lookupError.message }, { status: 500 });
  if (!task) return NextResponse.json({ error: 'care task not found' }, { status: 404 });

  const current = task as { id: string; staff_id: string; kind: string; status: string };

  // 已经决定过的待办不允许再决定：重复点击"接受"会把 decided_at / decided_by
  // 覆盖成最后一个人，审计里就查不出是谁先处理的。
  if (current.status !== 'open') {
    return NextResponse.json(
      { error: 'this care task has already been decided', status: current.status },
      { status: 409 },
    );
  }

  const nextStatus = decision === 'accept' ? 'accepted' : 'dismissed';

  // ---------------------------------------------------------------
  // 副作用分支：**只登记，不执行**。
  //
  // 这里返回 awaiting_approval 而不是调用任何发送/资金接口。审批链是唯一的
  // 执行入口（src/lib/agent/approvals.ts），绕过它等于把"对外可见动作必须审批"
  // 这条规则变成一个可以随手绕开的约定。
  // ---------------------------------------------------------------
  if (decision === 'accept' && SIDE_EFFECT_KINDS.has(current.kind)) {
    return NextResponse.json({
      ok: true,
      status: 'awaiting_approval',
      approval_id: null,
      detail: 'this decision has a side effect; it must go through the approval chain before anything is executed',
    });
  }

  // 状态推进用**单条带条件的 UPDATE**（status = 'open' 挂在链上），
  // 而不是"先查再改"：两个端同时决定同一件事时，先查再改会让后者覆盖前者。
  const { data: updated, error: updateError } = await client
    .from('staff_care_tasks')
    .update({
      status: nextStatus,
      decided_by: context.userId,
      decided_at: new Date().toISOString(),
      decision_note: note || null,
    })
    .eq('id', taskId)
    .eq('tenant_id', context.tenantId)
    .eq('business_id', context.businessId)
    .eq('status', 'open')
    .select('id, status, decided_by, decided_at')
    .maybeSingle();
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
  if (!updated) {
    // 竞态：另一处在这两次查询之间决定了它。
    return NextResponse.json(
      { error: 'this care task has already been decided', code: 'already_decided' },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, status: nextStatus });
}

export const POST = protectBusinessMutation(
  { permission: 'workforce:care', action: 'care.task.decide', entity: 'staff_care_tasks' },
  decideTask,
);
