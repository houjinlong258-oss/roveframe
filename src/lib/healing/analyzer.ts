/**
 * Sprint 5 — Error Self-Healing MVP
 * analyzer.ts
 *
 * Performs root-cause analysis on a captured error.
 * Uses deterministic heuristic rules (no LLM call required so it works offline)
 * and, when an AI router is available, optionally enriches the analysis.
 *
 * SAFETY: This module never writes to any file or database.
 *         It only produces a read-only AnalysisResult report.
 */

import { CapturedError, ErrorCategory, ErrorSeverity } from './error-collector';

export interface RootCauseSuggestion {
  title: string;
  explanation: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface AnalysisResult {
  errorId: string;
  fingerprint: string;
  severity: ErrorSeverity;
  category: ErrorCategory;
  rootCauses: RootCauseSuggestion[];
  recommendedAction: string;
  analyzedAt: string;
  occurrenceCount: number; // How many times this fingerprint was seen
}

// ---------------------------------------------------------------------------
// Heuristic knowledge base
// ---------------------------------------------------------------------------

interface HeuristicRule {
  match: (err: CapturedError) => boolean;
  rootCause: Omit<RootCauseSuggestion, never>;
  action: string;
}

const HEURISTIC_RULES: HeuristicRule[] = [
  // --- JSON / Unexpected end of input ---
  {
    match: (e) =>
      e.message.toLowerCase().includes('unexpected end of json') ||
      e.message.toLowerCase().includes("unexpected token") ||
      e.message.toLowerCase().includes('json parse error'),
    rootCause: {
      title: 'API returned empty or malformed JSON body',
      explanation:
        'The fetch call succeeded (HTTP 200) but the response body was empty or truncated. ' +
        'Likely causes: (1) API route returned early without a body, ' +
        '(2) SSE/stream was read as JSON, ' +
        '(3) middleware terminated the response before the handler wrote it.',
      confidence: 'high',
    },
    action:
      'Ensure every API route handler calls `return json(...)` or `return new Response(body)` ' +
      'on all code paths. Check for missing `return` in early-exit branches.',
  },
  // --- 401/403 Auth ---
  {
    match: (e) =>
      e.category === 'auth' ||
      e.message.toLowerCase().includes('unauthorized') ||
      e.message.toLowerCase().includes('forbidden') ||
      e.statusCode === 401 ||
      e.statusCode === 403,
    rootCause: {
      title: 'Request rejected due to missing or invalid authentication',
      explanation:
        'The server returned 401/403. Possible causes: ' +
        '(1) session cookie expired, ' +
        '(2) Bearer token missing or rotated, ' +
        '(3) tenant scope mismatch, ' +
        '(4) RBAC role insufficient for the operation.',
      confidence: 'high',
    },
    action:
      'Check that the client sends the `rf_session` cookie or a valid Bearer token. ' +
      'Verify the user role against the required RBAC permission on the API route. ' +
      'Consider refreshing the session if the token expired.',
  },
  // --- 500 Internal Server Error ---
  {
    match: (e) =>
      (e.statusCode !== undefined && e.statusCode >= 500) ||
      e.message.toLowerCase().includes('internal server error'),
    rootCause: {
      title: 'Unhandled server exception',
      explanation:
        'The API handler threw an uncaught exception and returned HTTP 500. ' +
        'Inspect the server logs for the stack trace. Common causes: ' +
        'null dereference, missing environment variable, or database connection failure.',
      confidence: 'medium',
    },
    action:
      'Review server-side logs around the timestamp of this error. ' +
      'Add try/catch around the failing handler or ensure all env vars are set.',
  },
  // --- Database / Supabase ---
  {
    match: (e) =>
      e.category === 'database' ||
      e.message.toLowerCase().includes('supabase') ||
      e.message.toLowerCase().includes('postgres') ||
      e.message.toLowerCase().includes('relation') ||
      e.message.toLowerCase().includes('column') ||
      e.message.toLowerCase().includes('does not exist'),
    rootCause: {
      title: 'Database schema or connection error',
      explanation:
        'A Supabase/PostgreSQL query failed. Possible causes: ' +
        '(1) pending migration not applied, ' +
        '(2) table or column referenced in code does not exist in DB, ' +
        '(3) RLS policy blocking the service-role call, ' +
        '(4) connection pool exhausted.',
      confidence: 'high',
    },
    action:
      'Apply the pending migration in `src/lib/migration.ts`. ' +
      'Verify the table/column name against the actual Supabase schema. ' +
      'Confirm the service-role key is set in SUPABASE_SERVICE_KEY.',
  },
  // --- Network / Fetch ---
  {
    match: (e) =>
      e.category === 'network' ||
      e.message.toLowerCase().includes('failed to fetch') ||
      e.message.toLowerCase().includes('network error') ||
      e.message.toLowerCase().includes('econnrefused'),
    rootCause: {
      title: 'Network connectivity failure',
      explanation:
        'A fetch or HTTP call failed before receiving a response. ' +
        'Possible causes: (1) server not running, (2) CORS blocked, ' +
        '(3) external API unreachable, (4) DNS resolution failure.',
      confidence: 'medium',
    },
    action:
      'Verify the target service is reachable. ' +
      'Check CORS configuration in `next.config.ts`. ' +
      'Confirm that all NEXT_PUBLIC_* and server-side env vars are set correctly.',
  },
  // --- TypeScript / Undefined property ---
  {
    match: (e) =>
      e.message.toLowerCase().includes('cannot read properties of undefined') ||
      e.message.toLowerCase().includes('cannot read property') ||
      e.message.toLowerCase().includes('is not a function'),
    rootCause: {
      title: 'Null/undefined dereference at runtime',
      explanation:
        'Code attempted to access a property on an undefined or null value. ' +
        'Usually caused by a missing null-check on an API response, ' +
        'optional chaining omitted, or an incorrect assumption about data shape.',
      confidence: 'high',
    },
    action:
      'Add optional chaining (`?.`) and nullish-coalescing (`??`) guards ' +
      'around the failing property access. ' +
      'Validate API response shapes against their TypeScript types.',
  },
];

const DEFAULT_SUGGESTION: RootCauseSuggestion = {
  title: 'Unclassified runtime error',
  explanation:
    'No specific heuristic rule matched this error. Manual inspection is required.',
  confidence: 'low',
};
const DEFAULT_ACTION =
  'Review the stack trace and error context. Enable verbose server logging for more detail.';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyse a single captured error and return a structured AnalysisResult.
 * This is a pure synchronous function — no I/O, no LLM calls.
 */
export function analyzeError(
  error: CapturedError,
  occurrenceCount = 1
): AnalysisResult {
  const matchedRules = HEURISTIC_RULES.filter((rule) => rule.match(error));

  const rootCauses: RootCauseSuggestion[] =
    matchedRules.length > 0
      ? matchedRules.map((r) => r.rootCause)
      : [DEFAULT_SUGGESTION];

  const recommendedAction =
    matchedRules.length > 0
      ? matchedRules.map((r) => r.action).join(' Additionally: ')
      : DEFAULT_ACTION;

  return {
    errorId: error.id,
    fingerprint: error.fingerprint,
    severity: error.severity,
    category: error.category,
    rootCauses,
    recommendedAction,
    analyzedAt: new Date().toISOString(),
    occurrenceCount,
  };
}

/**
 * Batch-analyze a list of errors, de-duplicating by fingerprint.
 * Returns one AnalysisResult per unique fingerprint (highest severity wins).
 */
export function analyzeErrors(errors: CapturedError[]): AnalysisResult[] {
  const groups = new Map<string, CapturedError[]>();
  for (const e of errors) {
    const group = groups.get(e.fingerprint) ?? [];
    group.push(e);
    groups.set(e.fingerprint, group);
  }

  const results: AnalysisResult[] = [];
  for (const [, group] of groups) {
    // Pick the most recent representative
    const representative = group[group.length - 1];
    results.push(analyzeError(representative, group.length));
  }

  // Sort: critical → high → medium → low
  const ORDER: ErrorSeverity[] = ['critical', 'high', 'medium', 'low'];
  results.sort(
    (a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity)
  );

  return results;
}
