/**
 * Sprint 6 — AI Coding Agent
 * context-builder.ts
 *
 * Builds a read-only CodingContext snapshot for a given CodingTask.
 * Reads only pre-approved safe paths from the filesystem.
 * Never writes any file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodingTask, CodingContext, CodeContextFile } from './types';
import { getAllowedWritePaths } from './permission-guard';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(process.cwd());
const MAX_EXCERPT_LINES = 120;
const MAX_FILES_PER_CONTEXT = 8;

// Directories always safe to read for context (never include secrets/env)
const READABLE_DIRS = [
  'src/custom',
  'src/lib/agent',
  'src/lib/customization',
  'src/lib/plugins',
  'src/lib/healing',
  'src/lib/coding-agent',
  'docs',
  'messages',
];

// File extensions to include
const ALLOWED_EXTENSIONS = new Set(['.ts', '.tsx', '.json', '.md']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readExcerpt(absPath: string): string {
  try {
    const content = fs.readFileSync(absPath, 'utf-8');
    const lines = content.split('\n');
    const excerpt = lines.slice(0, MAX_EXCERPT_LINES).join('\n');
    return excerpt + (lines.length > MAX_EXCERPT_LINES ? `\n... (${lines.length - MAX_EXCERPT_LINES} more lines)` : '');
  } catch {
    return '// [unreadable]';
  }
}

function listFilesInDir(dir: string, depth = 0): string[] {
  if (depth > 3) return [];
  const absDir = path.join(PROJECT_ROOT, dir);
  if (!fs.existsSync(absDir)) return [];
  try {
    return fs.readdirSync(absDir, { withFileTypes: true }).flatMap((entry) => {
      const rel = path.join(dir, entry.name).replace(/\\/g, '/');
      if (entry.isDirectory()) return listFilesInDir(rel, depth + 1);
      if (ALLOWED_EXTENSIONS.has(path.extname(entry.name))) return [rel];
      return [];
    });
  } catch {
    return [];
  }
}

/** Score a file's relevance to the task description (keyword overlap). */
function relevanceScore(filePath: string, description: string): number {
  const lower = description.toLowerCase();
  const parts = filePath.toLowerCase().replace(/[/_\-.]/g, ' ').split(' ');
  return parts.filter((p) => p.length > 3 && lower.includes(p)).length;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a read-only coding context for the given task.
 * Selects the most relevant files from safe readable directories.
 */
export function buildCodingContext(task: CodingTask): CodingContext {
  // Collect all readable files
  const allFiles = READABLE_DIRS.flatMap((dir) => listFilesInDir(dir));

  // Add any explicitly requested target files (already validated by permission-guard)
  const explicitFiles = (task.targetFiles ?? []).filter(
    (f) => !allFiles.includes(f.replace(/\\/g, '/'))
  );
  const candidates = [...allFiles, ...explicitFiles];

  // Rank by relevance
  const ranked = candidates
    .map((f) => ({ path: f, score: relevanceScore(f, task.description) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FILES_PER_CONTEXT);

  const relevantFiles: CodeContextFile[] = ranked.map(({ path: relPath }) => {
    const absPath = path.join(PROJECT_ROOT, relPath);
    const excerpt = readExcerpt(absPath);
    const lineCount = excerpt.split('\n').length;
    return { relativePath: relPath, excerpt, lineCount };
  });

  const projectSummary = `
RoveFrame AI Business OS — Next.js 16 / React 19 / TypeScript 5 / shadcn/ui / Tailwind CSS 4.
Supabase backend (service_role_key, no Auth). next-intl i18n (en/zh/es).
Coding Agent WRITE access: ${getAllowedWritePaths().join(', ')}.
All changes are proposals — never auto-applied. Human approval required.
`.trim();

  return {
    taskId: task.id,
    relevantFiles,
    projectSummary,
    allowedWritePaths: getAllowedWritePaths(),
  };
}
