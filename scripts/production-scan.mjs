import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const mode = process.argv[2] ?? 'all';
const validModes = new Set(['all', 'secrets', 'brand', 'globals', 'artifacts']);
if (!validModes.has(mode)) {
  console.error('Usage: node scripts/production-scan.mjs [all|secrets|brand|globals|artifacts]');
  process.exit(2);
}

const gitCommand = process.platform === 'win32' ? 'git.exe' : 'git';
const sourceFiles = execFileSync(
  gitCommand,
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
).split('\0').filter(Boolean).map((file) => file.replaceAll('\\', '/'))
  .filter((file) => existsSync(resolve(root, file)));

const textExtensions = new Set([
  '', '.cjs', '.css', '.env', '.example', '.html', '.ini', '.js', '.json', '.jsx',
  '.md', '.mjs', '.py', '.sh', '.sql', '.svg', '.toml', '.ts', '.tsx', '.txt',
  '.yaml', '.yml',
]);
const legalNames = new Set(['LICENSE', 'LICENSE.md', 'NOTICE', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md']);
const forbiddenTopLevel = new Set([
  '.roveagent', '.worktrees', 'current_site', 'deploy_site', 'phase8-demo', 'reports',
  'roveframe_site', 'roveframe_upgrade', 'tmp', 'two_worlds', 'verify_shots',
]);
const forbiddenArchive = /\.(?:zip|tar|tar\.gz|tgz|rar|7z)$/i;
const legacyName = ['her', 'mes'].join('');
const legacyPattern = new RegExp(legacyName, 'i');
const unsafeGlobalPatterns = [
  { id: 'mutable-context-resolver', pattern: /^\s*_context_resolver\s*=/m },
  { id: 'context-resolver-setter', pattern: /def\s+set_tool_context_resolver\s*\(/ },
  { id: 'mutable-tool-context', pattern: /@dataclass\s*\r?\nclass\s+ToolContext\b/ },
];
const credentialName = /(?:SERVICE_ROLE|API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)/i;
const assignment = /^\s*([A-Z][A-Z0-9_]*(?:SERVICE_ROLE_KEY|SERVICE_ROLE|API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY))\s*=\s*(.+?)\s*$/;
const highConfidenceSecrets = [
  { id: 'private-key', pattern: /^\s*-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'provider-api-key', pattern: /\b(?:sk|rk|pk)_(?:live|prod)_[A-Za-z0-9_-]{16,}\b/ },
  { id: 'generic-secret-literal', pattern: /\b(?:sk|key)-[A-Za-z0-9_-]{24,}\b/ },
];
const placeholders = /^(?:['"])?(?:replace-me|placeholder|example|test-only|test_|your[-_]|<[^>]+>|\$\{|process\.env|os\.environ)/i;
const findings = [];

function isLegal(file) {
  const parts = file.split('/');
  return parts.some((part) => part === 'LICENSES') || legalNames.has(parts.at(-1));
}

function readText(file) {
  const absolute = resolve(root, file);
  const stats = statSync(absolute);
  if (!stats.isFile() || stats.size > 5 * 1024 * 1024) return null;
  if (!textExtensions.has(extname(file).toLowerCase())) return null;
  const buffer = readFileSync(absolute);
  if (buffer.includes(0)) return null;
  return buffer.toString('utf8');
}

function add(rule, file, line) {
  findings.push({ rule, file, line });
}

function scanBrand() {
  for (const file of sourceFiles) {
    if (isLegal(file)) continue;
    if (legacyPattern.test(file)) add('legacy-brand-path', file, 0);
    const text = readText(file);
    if (text === null) continue;
    text.split(/\r?\n/).forEach((line, index) => {
      if (legacyPattern.test(line)) add('legacy-brand-content', file, index + 1);
    });
  }
}

function scanSecrets() {
  for (const file of sourceFiles) {
    const base = file.split('/').at(-1) ?? '';
    if (/^\.env(?:\..+)?$/i.test(base) && base !== '.env.example') {
      add('disallowed-environment-file', file, 0);
      continue;
    }
    const text = readText(file);
    if (text === null) continue;
    text.split(/\r?\n/).forEach((line, index) => {
      const match = line.match(assignment);
      if (match && credentialName.test(match[1]) && !placeholders.test(match[2])) {
        const literal = match[2].match(/^['"]([^'"]+)['"]/);
        if (literal && literal[1].length >= 16) add('credential-assignment', file, index + 1);
      }
      for (const rule of highConfidenceSecrets) {
        if (rule.pattern.test(line)) add(rule.id, file, index + 1);
      }
    });
  }
}

function scanGlobals() {
  for (const file of sourceFiles.filter((entry) => entry.startsWith('roveagent/') && entry.endsWith('.py'))) {
    const text = readText(file);
    if (text === null) continue;
    for (const rule of unsafeGlobalPatterns) {
      const match = rule.pattern.exec(text);
      if (match) add(rule.id, file, text.slice(0, match.index).split(/\r?\n/).length);
    }
  }
}

function scanArtifacts() {
  for (const file of sourceFiles) {
    const top = file.split('/')[0];
    if (forbiddenTopLevel.has(top)) add('forbidden-repository-directory', file, 0);
    if (forbiddenArchive.test(file)) add('forbidden-archive', file, 0);
    if (file.includes('/__pycache__/') || file.endsWith('.pyc') || file.endsWith('.tsbuildinfo')) {
      add('forbidden-generated-file', file, 0);
    }
  }
}

if (mode === 'all' || mode === 'secrets') scanSecrets();
if (mode === 'all' || mode === 'brand') scanBrand();
if (mode === 'all' || mode === 'globals') scanGlobals();
if (mode === 'all' || mode === 'artifacts') scanArtifacts();

if (findings.length) {
  console.error(`Production scan failed with ${findings.length} finding(s). Secret values are never printed.`);
  for (const finding of findings) {
    const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    console.error(`${finding.rule}\t${location}`);
  }
  process.exit(1);
}

console.log(`Production scan (${mode}) passed across ${sourceFiles.length} source file(s).`);
