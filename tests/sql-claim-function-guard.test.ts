import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { fetchLiveSchema } from '../src/lib/boot-check';

/**
 * PL/pgSQL 的 OUT 参数 / 表列重名歧义（42702）守卫。
 *
 * ## 为什么需要它（这一类缺陷已经上线过两次）
 *
 *   1. `claim_agent_task_runs`：OUT 参数 `attempt` / `max_attempts` 与表列同名，
 *      函数体写成未限定的 `case when attempt >= max_attempts`。
 *      调用方还写着 `if (error) return []`，把失败吞成"本轮没有任务" ——
 *      21 行任务卡住最久 11 天，日志一片干净（Phase 15 修）。
 *   2. `claim_notification_outbox`：同一形态（`attempts` / `max_attempts`）。
 *      这次调用方没有吞错，于是**换成生产入口跑起来就立刻报出来**：
 *        [scheduler] notification outbox worker failed:
 *          Error: notification outbox claim failed:
 *            column reference "attempts" is ambiguous
 *      48 行通知卡住 5.1 天，attempts 永远是 0（Phase 19 修）。
 *
 * 两次都是"只有真的把调度器跑起来才看得见"。所以这里加一道静态守卫：
 * 只要有人再写出同形态的函数，**不需要连库、不需要跑调度器**就会红。
 *
 * ## 判据怎么来的（不维护手写清单）
 *
 *   · OUT 参数名：从 `returns table ( ... )` 里就地解析；
 *   · 表列名：从**真实库**读（`fetchLiveSchema`，与 boot-check 同一来源），
 *     不在这里抄一份列清单；
 *   · 只在"比较/表达式上下文"里判定（`P <op>` 或 `<op> P`），
 *     并先剥掉 `set` 赋值的左值 —— 那一侧的标识符一定是列，Postgres 不报歧义。
 *
 * ## 它不做什么（如实说明）
 *
 * 它不是 SQL 解析器：不做括号/字符串字面量的完整词法分析，也不判断类型。
 * 它只覆盖"OUT 参数名与表列同名、且在表达式里未限定"这一种形态 —— 也就是
 * 实际上线过的这两种。做不到的写在这里，而不是假装它是通用的 SQL linter。
 */

const MIGRATE_SQL = readFileSync('scripts/migrate.sql', 'utf8');

interface FnBlock {
  name: string;
  outParams: string[];
  body: string;
}

/** 解析所有 `create [or replace] function public.X(...) returns table (...) ... $$ body $$;` */
export function parseReturnsTableFunctions(sql: string): FnBlock[] {
  const out: FnBlock[] = [];
  const re = /create\s+(?:or\s+replace\s+)?function\s+public\.([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*returns\s+table\s*\(([\s\S]*?)\)\s*language\s+plpgsql[\s\S]*?as\s+\$\$([\s\S]*?)\$\$/gi;
  for (const m of sql.matchAll(re)) {
    const [, name, , tableDecl, body] = m;
    // OUT 参数名：每个逗号分隔项的第一个标识符
    const outParams = tableDecl
      .split(',')
      .map((entry) => /^\s*([a-z_][a-z0-9_]*)/i.exec(entry.trim())?.[1])
      .filter((x): x is string => Boolean(x));
    out.push({ name, outParams, body });
  }
  return out;
}

/** 从函数体里取出被引用的 public 表名（update/from/insert into）。 */
export function referencedTables(body: string): string[] {
  const names = new Set<string>();
  for (const m of body.matchAll(/\b(?:update|from|insert\s+into|join)\s+public\.([a-z0-9_]+)/gi)) {
    names.add(m[1]);
  }
  return [...names];
}

/** 剥掉 `set a = ..., b = ...` 的赋值左值（那一侧一定是列，不构成歧义）。 */
export function stripSetTargets(body: string): string {
  return body.replace(/\bset\b([\s\S]*?)(?=\bwhere\b|\bfrom\b|\breturning\b|;)/gi, (whole, assignments: string) => {
    const rewritten = assignments
      .split(',')
      .map((part) => {
        const eq = part.indexOf('=');
        return eq >= 0 ? part.slice(eq) : part; // 丢掉左值，保留 `= 表达式`
      })
      .join(',');
    return `set${rewritten}`;
  });
}

/** 找出在表达式上下文里**未限定**出现的标识符（`P <op>` 或 `<op> P`）。 */
export function unqualifiedInExpressions(body: string, names: readonly string[]): string[] {
  const stripped = stripSetTargets(body);
  const found: string[] = [];
  for (const n of names) {
    const op = String.raw`(?:>=|<=|<>|!=|=|<|>|\+|-|\*|/)`;
    const after = new RegExp(String.raw`(?<![\w.])${n}\s*${op}`, 'i');
    const before = new RegExp(String.raw`${op}\s*${n}(?![\w(])`, 'i');
    if (after.test(stripped) || before.test(stripped)) found.push(n);
  }
  return found;
}

describe('PL/pgSQL claim 函数：OUT 参数与表列不得同名未限定（42702）', () => {
  test('解析器确实找到了这两个 claim 函数（否则本节什么都没测）', () => {
    const fns = parseReturnsTableFunctions(MIGRATE_SQL).map((f) => f.name);
    assert.ok(fns.includes('claim_agent_task_runs'), `未解析到 claim_agent_task_runs（解析到：${fns.join(',')}）`);
    assert.ok(fns.includes('claim_notification_outbox'), '未解析到 claim_notification_outbox');
  });

  test('负向对照：把修好的写法换回旧写法，必须被判定为歧义', () => {
    // 旧写法（真实上线过）：未限定的 attempts / max_attempts
    const buggy = 'update public.notification_outbox set status = case when attempts >= max_attempts then \'failed\' else \'queued\' end where status = \'sending\';';
    const flagged = unqualifiedInExpressions(buggy, ['attempts', 'max_attempts']);
    assert.deepEqual(flagged.sort(), ['attempts', 'max_attempts'],
      '这条对照失败说明判据不具检测能力 —— 它会放过真实上线过的那个写法');

    // 修好后的写法必须不再被判出
    const fixed = 'update public.notification_outbox n set status = case when n.attempts >= n.max_attempts then \'failed\' else \'queued\' end where n.status = \'sending\';';
    assert.deepEqual(unqualifiedInExpressions(fixed, ['attempts', 'max_attempts']), [],
      '限定写法被误判成歧义 —— 那会把正确的代码判成错的');
  });

  test('负向对照：set 左值不算歧义（否则会误报正确写法）', () => {
    const withSetTarget = 'update public.notification_outbox set attempts = attempts + 1 where id = $1;';
    // 左值 attempts 必须被剥掉；右侧未限定的 attempts 仍应被报出（它确实有歧义）
    const flagged = unqualifiedInExpressions(withSetTarget, ['attempts']);
    assert.deepEqual(flagged, ['attempts'], '右侧未限定的引用应当被报出');
    const okForm = 'update public.notification_outbox n set attempts = n.attempts + 1 where n.id = $1;';
    assert.deepEqual(unqualifiedInExpressions(okForm, ['attempts']), [], '两侧都限定后不应报出');
  });

  test('真实 migrate.sql：没有任何 claim 函数还在用未限定的同名引用', async () => {
    const live = await fetchLiveSchema();
    if (live === null) {
      console.log('  [skip] 读不到真实 schema，无法判断"哪些名字是表列" → UNVERIFIED（不是通过）');
      return;
    }
    const problems: string[] = [];
    const evaluated: string[] = [];
    for (const fn of parseReturnsTableFunctions(MIGRATE_SQL)) {
      const tables = referencedTables(fn.body);
      const columnsInScope = new Set<string>();
      for (const t of tables) for (const c of live[t] ?? []) columnsInScope.add(c);
      // 只有"既是 OUT 参数、又是被引用表的列"的名字才有歧义风险
      const risky = fn.outParams.filter((p) => columnsInScope.has(p));
      if (risky.length === 0) continue;
      evaluated.push(`${fn.name}[${risky.join(',')}]`);
      const bad = unqualifiedInExpressions(fn.body, risky);
      if (bad.length) problems.push(`${fn.name}: ${bad.join(', ')}（OUT 参数与 ${tables.join('/')} 的列同名且未限定）`);
    }
    assert.deepEqual(problems, [],
      '这些函数在调用时会直接报 42702，队列永远不会被消费：\n  ' + problems.join('\n  '));
    // ⚠️ 非空断言：没有这一条，上面的 deepEqual([]) 在"一个冒烟名字都没算出来"时
    // 也会绿 —— 那就是一条永远通过的检查。实测过：早期版本确实可能是空转的。
    assert.ok(evaluated.length > 0,
      '没有任何函数被真正检查 —— 这一节是空转的，它的"通过"不构成证据。'
      + `解析到的函数：${parseReturnsTableFunctions(MIGRATE_SQL).map((f) => f.name).join(', ')}`);
    console.log(`  [ok] 实际检查了 ${evaluated.length} 个函数：${evaluated.join(' ')}`);
  });

  test('已知的两个修复点就地钉住（防止被"简化"回去）', () => {
    const fns = parseReturnsTableFunctions(MIGRATE_SQL);
    const notif = fns.find((f) => f.name === 'claim_notification_outbox');
    assert.ok(notif, '找不到 claim_notification_outbox');
    assert.match(notif.body, /n\.attempts\s*>=\s*n\.max_attempts/,
      'claim_notification_outbox 的租约回收又用了未限定的 attempts —— 那正是让它 5.1 天不工作的原因');
  });
});
