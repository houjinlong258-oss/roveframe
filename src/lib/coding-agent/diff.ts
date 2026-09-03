/**
 * Phase 8 — Enterprise AI Change Approval
 * diff.ts
 *
 * 统一 diff（unified diff）生成引擎。
 *
 * 输入：旧文件内容 + 提案内容（CodingProposal 存的是全量 proposedContent，
 * 不存在预计算的 patch），输出结构化的 hunks + 标准 unified diff 文本，
 * 供 /enterprise/approvals 的 diff viewer 渲染。
 *
 * 算法：Myers O(ND) 行级 diff，先裁剪公共前缀/后缀加速；
 * 超大文件（> MAX_DIFF_LINES 行）退化为 tooLarge 标记，UI 回落到全量预览。
 *
 * 纯函数，无副作用，可单测。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type DiffLineType = 'context' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  content: string;
  /** 旧文件行号（add 行无） */
  oldLine?: number;
  /** 新文件行号（del 行无） */
  newLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  filePath: string;
  operation: 'create' | 'modify' | 'delete';
  isNew: boolean;
  isDeleted: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** 文件过大未计算 diff（UI 应回落到全量内容预览） */
  tooLarge: boolean;
}

/** 单侧超过该行数则不计算 diff，避免 Myers 在大文件上退化 */
export const MAX_DIFF_LINES = 3000;
/** hunk 上下文行数（与 git 默认一致） */
export const DEFAULT_CONTEXT_LINES = 3;

// ---------------------------------------------------------------------------
// Myers O(ND) 行 diff
// ---------------------------------------------------------------------------

type Op = ' ' | '-' | '+';

/**
 * Myers 核心：返回把 a 变成 b 的操作序列（' '=保留, '-'=删除, '+'=新增）。
 * 调用方应先裁剪公共前后缀以控制规模。
 */
function myersOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return new Array<Op>(m).fill('+');
  if (m === 0) return new Array<Op>(n).fill('-');

  const max = n + m;
  // trace[d] = 该轮结束时的 V 数组快照，用于回溯
  const trace: Array<Map<number, number>> = [];
  let v = new Map<number, number>();
  v.set(1, 0);

  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v);
    const next = new Map<number, number>();
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1));
      let x = down ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next.set(k, x);
      if (x >= n && y >= m) {
        trace.push(next);
        found = true;
        break;
      }
    }
    v = next;
  }

  // 回溯生成操作序列
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const vPrev = trace[d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && (vPrev.get(k - 1) ?? -1) < (vPrev.get(k + 1) ?? -1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = vPrev.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(' ');
      x--;
      y--;
    }
    if (down) {
      ops.push('+');
      y--;
    } else {
      ops.push('-');
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push(' ');
    x--;
    y--;
  }
  while (x > 0) {
    ops.push('-');
    x--;
  }
  while (y > 0) {
    ops.push('+');
    y--;
  }
  return ops.reverse();
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 计算两段文本的行级 diff，返回带双侧行号的扁平行序列。
 * 先做公共前缀/后缀裁剪，控制 Myers 的输入规模。
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.length === 0 ? [] : oldText.split('\n');
  const b = newText.length === 0 ? [] : newText.split('\n');

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops = myersOps(midA, midB);

  const lines: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (let i = 0; i < start; i++) {
    lines.push({ type: 'context', content: a[i], oldLine: oldNo++, newLine: newNo++ });
  }
  let ia = 0;
  let ib = 0;
  for (const op of ops) {
    if (op === ' ') {
      lines.push({ type: 'context', content: midA[ia++], oldLine: oldNo++, newLine: newNo++ });
      ib++;
    } else if (op === '-') {
      lines.push({ type: 'del', content: midA[ia++], oldLine: oldNo++ });
    } else {
      lines.push({ type: 'add', content: midB[ib++], newLine: newNo++ });
    }
  }
  for (let i = endA; i < a.length; i++) {
    lines.push({ type: 'context', content: a[i], oldLine: oldNo++, newLine: newNo++ });
  }
  return lines;
}

/** 把扁平 diff 行折叠为带上下文的 hunks（git 风格：变更间隔 ≤ 2×context 合并为一个 hunk） */
export function buildHunks(lines: DiffLine[], contextLines = DEFAULT_CONTEXT_LINES): DiffHunk[] {
  const changeIdx: number[] = [];
  lines.forEach((l, i) => {
    if (l.type !== 'context') changeIdx.push(i);
  });
  if (changeIdx.length === 0) return [];

  // 按变更位置分组：相邻变更之间的上下文行数 ≤ 2×context 时并入同一 hunk
  const groups: Array<[number, number]> = [];
  let gs = changeIdx[0];
  let ge = changeIdx[0];
  for (let i = 1; i < changeIdx.length; i++) {
    const gap = changeIdx[i] - ge - 1; // 两个变更之间的上下文行数
    if (gap <= contextLines * 2) {
      ge = changeIdx[i];
    } else {
      groups.push([gs, ge]);
      gs = ge = changeIdx[i];
    }
  }
  groups.push([gs, ge]);

  return groups.map(([gStart, gEnd]) => {
    const from = Math.max(0, gStart - contextLines);
    const to = Math.min(lines.length - 1, gEnd + contextLines);
    return makeHunk(lines.slice(from, to + 1));
  });
}

function makeHunk(lines: DiffLine[]): DiffHunk {
  const first = lines[0];
  const oldLines = lines.filter((l) => l.type !== 'add').length;
  const newLines = lines.filter((l) => l.type !== 'del').length;
  return {
    // git 约定：纯新增 hunk 旧起点为 0（-0,0），纯删除 hunk 新起点为 0（+0,0）
    oldStart: oldLines === 0 ? 0 : (first.oldLine ?? 1),
    oldLines,
    newStart: newLines === 0 ? 0 : (first.newLine ?? 1),
    newLines,
    lines,
  };
}

/** 计算单个文件变更的完整 FileDiff */
export function diffFile(
  filePath: string,
  operation: 'create' | 'modify' | 'delete',
  oldContent: string | null,
  proposedContent?: string
): FileDiff {
  const oldText = operation === 'create' ? '' : oldContent ?? '';
  const newText = operation === 'delete' ? '' : proposedContent ?? '';

  const oldCount = oldText === '' ? 0 : oldText.split('\n').length;
  const newCount = newText === '' ? 0 : newText.split('\n').length;

  if (oldCount > MAX_DIFF_LINES || newCount > MAX_DIFF_LINES) {
    return {
      filePath,
      operation,
      isNew: operation === 'create',
      isDeleted: operation === 'delete',
      hunks: [],
      additions: newCount,
      deletions: oldCount,
      tooLarge: true,
    };
  }

  const lines = computeLineDiff(oldText, newText);
  const hunks = buildHunks(lines);
  return {
    filePath,
    operation,
    isNew: operation === 'create',
    isDeleted: operation === 'delete',
    hunks,
    additions: lines.filter((l) => l.type === 'add').length,
    deletions: lines.filter((l) => l.type === 'del').length,
    tooLarge: false,
  };
}

/** 格式化为标准 unified diff 文本（---/+++ 头 + @@ hunk 头） */
export function formatUnifiedDiff(diff: FileDiff): string {
  const oldLabel = diff.isNew ? '/dev/null' : `a/${diff.filePath}`;
  const newLabel = diff.isDeleted ? '/dev/null' : `b/${diff.filePath}`;
  const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  for (const hunk of diff.hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
      out.push(`${prefix}${line.content}`);
    }
  }
  return out.join('\n');
}
