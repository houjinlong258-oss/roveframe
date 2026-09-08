import { IterationBudget } from './iteration-budget';
import { isRepetitionDominated } from '../context/repetition-guard';
import { toolCallKey } from '../tools/call-key';

export interface ToolCall { id: string; name: string; input: unknown }
export interface Observation { call: ToolCall; result: unknown }
export interface Decision { calls: ToolCall[]; text?: string; replan: boolean }
export type StopReason = 'completed' | 'budget' | 'repetition' | 'awaiting_approval' | 'blocked' | 'cancelled';
export interface RuntimeResult {
  reason: StopReason;
  text?: string;
  observations: Observation[];
  iterations: number;
}
export interface RuntimeOptions {
  maxIterations?: number;
  maxToolCalls?: number;
  signal?: AbortSignal;
  plan: (observations: readonly Observation[]) => Promise<Decision>;
  /** Adapter must enforce schema, authenticated scope, permission, approval and audit. */
  execute: (call: ToolCall) => Promise<{ result: unknown; stop?: 'awaiting_approval' | 'blocked' }>;
}

/** Per-request state only. No credentials, database, global memory or tool authority. */
export async function runAgentLoop(options: RuntimeOptions): Promise<RuntimeResult> {
  const iterations = new IterationBudget(options.maxIterations ?? 4);
  const tools = new IterationBudget(options.maxToolCalls ?? 4);
  const seen = new Set<string>();
  const ids = new Set<string>();
  const observations: Observation[] = [];
  const finish = (reason: StopReason, text?: string): RuntimeResult => ({
    reason, text, observations, iterations: iterations.used,
  });
  while (iterations.remaining > 0) {
    if (options.signal?.aborted) return finish('cancelled');
    iterations.consume();
    const decision = await options.plan(observations);
    if (options.signal?.aborted) return finish('cancelled');
    if (decision.text && isRepetitionDominated(decision.text)) return finish('repetition');
    if (!decision.calls.length) return finish('completed', decision.text);
    let executed = 0;
    for (const call of decision.calls) {
      if (options.signal?.aborted) return finish('cancelled');
      const key = toolCallKey(call);
      if (seen.has(key)) continue;
      // Reusing an ID for a different operation would corrupt audit correlation.
      if (!call.id || ids.has(call.id)) return finish('blocked');
      if (!tools.consume()) return finish('budget');
      seen.add(key);
      ids.add(call.id);
      const output = await options.execute(call);
      observations.push({ call, result: output.result });
      executed += 1;
      if (output.stop) return finish(output.stop);
    }
    if (!executed) return finish('repetition');
    if (!decision.replan) return finish('completed');
    if (!tools.remaining) return finish('budget');
  }
  return finish('budget');
}
