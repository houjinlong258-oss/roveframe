/**
 * Sprint 6 — AI Coding Agent
 * code-generator.ts
 *
 * Calls the AI router to generate a CodingProposal for a given task + context.
 * Uses `invokeChat` (capability: 'agent') to get a structured JSON response.
 *
 * SAFETY GUARANTEES:
 *   1. Every generated file path is validated through permission-guard.checkPath().
 *   2. Blocked paths produce a 'rejected' proposal — no content returned.
 *   3. requiresHumanApproval is always true.
 *   4. This module never writes to the filesystem.
 */

import { invokeChat } from '@/lib/ai/router';
import { CodingTask, CodingContext, CodingProposal, CodeChange } from './types';
import { checkPath } from './permission-guard';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProposalId(): string {
  return `cprop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function buildSystemPrompt(context: CodingContext): string {
  const filesSummary = context.relevantFiles
    .map((f) => `### ${f.relativePath}\n\`\`\`typescript\n${f.excerpt}\n\`\`\``)
    .join('\n\n');

  return `You are RoveAgent Coding Agent — an AI assistant integrated into the RoveFrame AI Business OS.

## Project Context
${context.projectSummary}

## Relevant Codebase Files
${filesSummary || '(No relevant files found)'}

## Your Task
Generate a structured JSON coding proposal. Follow these STRICT rules:
1. You may ONLY propose changes to files under: ${context.allowedWritePaths.join(', ')}
2. NEVER touch: src/core/, src/app/api/auth/, src/lib/crypto.ts, src/lib/migration.ts, .env, package.json, tsconfig.json
3. Return ONLY valid JSON — no markdown fences, no explanation outside JSON.
4. Every change must include a clear 'rationale'.
5. Prefer additive changes over deletions.
6. TypeScript strict mode. No 'any'. shadcn/ui components. Tailwind CSS 4.

## Output Format (strict JSON)
{
  "title": "Short descriptive title",
  "summary": "What this change does and why",
  "riskLevel": "safe" | "moderate" | "review_required",
  "changes": [
    {
      "filePath": "src/custom/example.ts",
      "operation": "create" | "modify" | "delete",
      "proposedContent": "// full file content here",
      "rationale": "Why this change is needed"
    }
  ]
}`;
}

function buildUserPrompt(task: CodingTask): string {
  return `Task ID: ${task.id}
Task Type: ${task.type}
Description: ${task.description}${task.relatedErrorFingerprint ? `\nRelated Error Fingerprint: ${task.relatedErrorFingerprint}` : ''}

Generate the coding proposal JSON now.`;
}

// ---------------------------------------------------------------------------
// JSON extraction — handles cases where model wraps JSON in markdown
// ---------------------------------------------------------------------------

function extractJSON(raw: string): string {
  // Strip ```json ... ``` fences if present
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  // Find first { ... } block
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) return raw.slice(start, end + 1);
  return raw.trim();
}

// ---------------------------------------------------------------------------
// Fallback proposal (when AI is unavailable or returns invalid JSON)
// ---------------------------------------------------------------------------

function makeFallbackProposal(task: CodingTask, reason: string): CodingProposal {
  return {
    id: makeProposalId(),
    taskId: task.id,
    status: 'pending_review',
    title: 'Manual Implementation Required',
    summary: `AI code generation unavailable: ${reason}. A developer should implement this task manually.`,
    changes: [],
    riskLevel: 'review_required',
    requiresHumanApproval: true,
    blockedPaths: [],
    generatedAt: new Date().toISOString(),
    model: 'fallback',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a CodingProposal using the AI router.
 * Falls back to a manual-review proposal if AI is unavailable.
 * Never writes any file.
 */
export async function generateCodingProposal(
  task: CodingTask,
  context: CodingContext,
  forwardHeaders?: Record<string, string>
): Promise<CodingProposal> {
  const proposalId = makeProposalId();
  const now = new Date().toISOString();

  let rawResponse: string;
  const modelUsed = 'agent';

  try {
    rawResponse = await invokeChat(
      'agent',
      [
        { role: 'system', content: buildSystemPrompt(context) },
        { role: 'user', content: buildUserPrompt(task) },
      ],
      forwardHeaders
    );
  } catch (err) {
    return makeFallbackProposal(task, err instanceof Error ? err.message : 'Unknown AI error');
  }

  // Parse JSON response
  let parsed: {
    title?: string;
    summary?: string;
    riskLevel?: string;
    changes?: Array<{
      filePath?: string;
      operation?: string;
      proposedContent?: string;
      rationale?: string;
    }>;
  };

  try {
    parsed = JSON.parse(extractJSON(rawResponse));
  } catch {
    return makeFallbackProposal(task, 'AI returned non-JSON response');
  }

  // Validate and filter changes through permission guard
  const blockedPaths: string[] = [];
  const safeChanges: CodeChange[] = [];

  for (const change of parsed.changes ?? []) {
    const filePath = (change.filePath ?? '').replace(/\\/g, '/');
    const operation = (change.operation ?? 'modify') as CodeChange['operation'];

    if (!filePath) continue;

    const check = checkPath(filePath, operation, task.type);
    if (!check.allowed) {
      blockedPaths.push(`${filePath} (${check.reason})`);
      continue;
    }

    safeChanges.push({
      filePath,
      operation,
      proposedContent: change.proposedContent,
      rationale: change.rationale ?? 'No rationale provided',
    });
  }

  const riskLevel =
    blockedPaths.length > 0
      ? 'review_required'
      : ((parsed.riskLevel as CodingProposal['riskLevel']) ?? 'moderate');

  return {
    id: proposalId,
    taskId: task.id,
    status: blockedPaths.length > 0 ? 'rejected' : 'pending_review',
    title: parsed.title ?? `Coding Proposal: ${task.type}`,
    summary: parsed.summary ?? task.description,
    changes: safeChanges,
    riskLevel,
    requiresHumanApproval: true,
    blockedPaths,
    generatedAt: now,
    model: modelUsed,
  };
}
