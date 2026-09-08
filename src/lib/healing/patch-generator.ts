/**
 * Sprint 5 — Error Self-Healing MVP
 * patch-generator.ts
 *
 * Generates safe, human-readable patch *proposals* based on an AnalysisResult.
 *
 * CRITICAL SAFETY CONSTRAINTS:
 *   1. This module NEVER writes to any file.
 *   2. All patches are returned as structured proposals for human review.
 *   3. Patches targeting src/core/*, src/app/api/auth/*, and production
 *      environment files are blocked by the SafetyFilter.
 *   4. Patch content is limited to configuration changes and additive code
 *      (no deletions of existing business logic).
 */

import { AnalysisResult } from './analyzer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PatchStatus = 'pending_review' | 'approved' | 'rejected' | 'applied';

export interface PatchHunk {
  description: string;
  filePath: string;       // Relative path (never absolute)
  patchType: 'add_null_check' | 'add_error_handler' | 'add_return' | 'config_change' | 'documentation';
  before?: string;        // Pseudocode / pattern to look for
  after: string;          // Proposed replacement / addition
}

export interface PatchProposal {
  id: string;
  analysisId: string;     // Links back to AnalysisResult.errorId
  fingerprint: string;
  status: PatchStatus;
  title: string;
  summary: string;
  hunks: PatchHunk[];
  riskLevel: 'safe' | 'moderate' | 'review_required';
  blockedReason?: string; // Set when safety filter rejects
  createdAt: string;
  requiresHumanApproval: boolean; // Always true in Sprint 5
}

// ---------------------------------------------------------------------------
// Safety filter — paths that must never be touched by auto-generated patches
// ---------------------------------------------------------------------------

const BLOCKED_PATH_PREFIXES = [
  'src/core/',
  'src/app/api/auth/',
  'src/lib/crypto.',
  'src/lib/auth.',
  'src/lib/migration.',
  'src/server.',
  'next.config.',
  '.env',
  'pnpm-lock',
  'package.json',
  'tsconfig',
];

function isPathBlocked(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return BLOCKED_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix.toLowerCase()));
}

function _makeProposalId(): string {
  return `patch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// ---------------------------------------------------------------------------
// Heuristic patch templates
// ---------------------------------------------------------------------------

interface PatchTemplate {
  matchCategory: string[];
  matchTitleKeyword: string[];
  buildHunks: (analysis?: AnalysisResult) => PatchHunk[];
  riskLevel: PatchProposal['riskLevel'];
}

const PATCH_TEMPLATES: PatchTemplate[] = [
  // --- JSON / Empty response body ---
  {
    matchCategory: ['validation', 'runtime'],
    matchTitleKeyword: ['api returned empty', 'malformed json', 'unexpected end'],
    buildHunks: () => [
      {
        description: 'Guard fetch() calls with a response.ok check before calling .json()',
        filePath: 'src/app/[locale]/_example_page/page.tsx',
        patchType: 'add_error_handler',
        before: `const data = await res.json();`,
        after: `if (!res.ok) throw new Error(\`API error \${res.status}: \${await res.text()}\`);
const data = await res.json();`,
      },
      {
        description: 'Ensure API route handler returns a body on every code path',
        filePath: 'src/app/api/_example_route/route.ts',
        patchType: 'add_return',
        before: `// Handler exits without return`,
        after: `return json({ error: 'Unexpected state' }, 500);`,
      },
    ],
    riskLevel: 'safe',
  },
  // --- Null / undefined dereference ---
  {
    matchCategory: ['runtime'],
    matchTitleKeyword: ['null', 'undefined dereference', 'cannot read'],
    buildHunks: () => [
      {
        description: 'Add optional chaining and nullish coalescing guards',
        filePath: 'src/app/[locale]/_example_component/component.tsx',
        patchType: 'add_null_check',
        before: `const value = data.items[0].name;`,
        after: `const value = data?.items?.[0]?.name ?? 'Unknown';`,
      },
    ],
    riskLevel: 'safe',
  },
  // --- Auth errors ---
  {
    matchCategory: ['auth'],
    matchTitleKeyword: ['missing or invalid authentication', 'forbidden', 'unauthorized'],
    buildHunks: () => [
      {
        description: 'Add session validation before protected API call',
        filePath: 'src/app/api/_example_protected/route.ts',
        patchType: 'add_error_handler',
        before: `// Missing auth guard`,
        after: `const session = await resolveSession(request.headers);
if (!session) return json({ error: 'Unauthorized' }, 401);`,
      },
    ],
    riskLevel: 'moderate',
  },
  // --- Database errors ---
  {
    matchCategory: ['database'],
    matchTitleKeyword: ['schema', 'connection', 'migration', 'does not exist'],
    buildHunks: () => [
      {
        description: 'Apply pending database migration to create missing tables/columns',
        filePath: 'docs/healing/database-migration-steps.md',
        patchType: 'documentation',
        after: `# Pending Migration Action\n\n` +
          `Run the following to apply schema changes:\n\n` +
          `\`\`\`bash\n` +
          `# Via Supabase SQL Editor (recommended):\n` +
          `# Paste contents of src/lib/migration.ts → apply()\n\n` +
          `# Or via CLI:\n` +
          `# pnpm exec tsx scripts/seed.ts --dry-run\n` +
          `\`\`\`\n\n` +
          `Ensure SUPABASE_URL and SUPABASE_SERVICE_KEY are set in your .env file.`,
      },
    ],
    riskLevel: 'safe',
  },
  // --- Network errors ---
  {
    matchCategory: ['network'],
    matchTitleKeyword: ['connectivity', 'fetch', 'network'],
    buildHunks: () => [
      {
        description: 'Add retry logic with exponential backoff for fetch calls',
        filePath: 'src/lib/_example_fetch_helper.ts',
        patchType: 'add_error_handler',
        before: `const res = await fetch(url);`,
        after: `let res: Response | undefined;
let lastErr: Error | undefined;
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    res = await fetch(url);
    break;
  } catch (e) {
    lastErr = e as Error;
    await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
  }
}
if (!res) throw lastErr ?? new Error('Fetch failed after 3 retries');`,
      },
    ],
    riskLevel: 'safe',
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a patch proposal for a given AnalysisResult.
 * Returns a PatchProposal with requiresHumanApproval always = true (Sprint 5).
 * Does NOT write any file.
 */
export function generatePatchProposal(analysis: AnalysisResult): PatchProposal {
  const proposalId = _makeProposalId();
  const now = new Date().toISOString();

  // Match template
  const titleLower = analysis.rootCauses.map((rc) => rc.title.toLowerCase()).join(' ');
  const matched = PATCH_TEMPLATES.find((tmpl) => {
    const categoryMatch = tmpl.matchCategory.includes(analysis.category);
    const titleMatch = tmpl.matchTitleKeyword.some((kw) => titleLower.includes(kw));
    return categoryMatch && titleMatch;
  });

  // No template matched → return a documentation-only proposal
  if (!matched) {
    return {
      id: proposalId,
      analysisId: analysis.errorId,
      fingerprint: analysis.fingerprint,
      status: 'pending_review',
      title: 'Manual Investigation Required',
      summary:
        'No automated patch template matched this error. ' +
        'A developer should inspect the stack trace and apply a fix manually.',
      hunks: [],
      riskLevel: 'review_required',
      createdAt: now,
      requiresHumanApproval: true,
    };
  }

  const hunks = matched.buildHunks(analysis);

  // Safety filter
  const blockedHunks = hunks.filter((h) => isPathBlocked(h.filePath));
  if (blockedHunks.length > 0) {
    return {
      id: proposalId,
      analysisId: analysis.errorId,
      fingerprint: analysis.fingerprint,
      status: 'rejected',
      title: 'Patch blocked by safety filter',
      summary:
        'One or more proposed changes target protected paths. Human review required.',
      hunks,
      riskLevel: 'review_required',
      blockedReason: `Protected paths: ${blockedHunks.map((h) => h.filePath).join(', ')}`,
      createdAt: now,
      requiresHumanApproval: true,
    };
  }

  return {
    id: proposalId,
    analysisId: analysis.errorId,
    fingerprint: analysis.fingerprint,
    status: 'pending_review',
    title: `Suggested Fix: ${analysis.rootCauses[0]?.title ?? 'Runtime error'}`,
    summary: analysis.recommendedAction,
    hunks,
    riskLevel: matched.riskLevel,
    createdAt: now,
    requiresHumanApproval: true,
  };
}

/**
 * Batch-generate proposals for a list of analysis results.
 */
export function generatePatchProposals(analyses: AnalysisResult[]): PatchProposal[] {
  return analyses.map((a) => generatePatchProposal(a));
}
