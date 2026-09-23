/**
 * Generation of `docker/deploy.env` for the self-hosted deployment.
 *
 * Kept in a library module (and not inline in the CLI) so that
 * tests/selfhosted-deploy.test.ts can assert the real thing instead of a
 * re-implementation: a test that re-derives the JWT itself would pass even if
 * this file were broken.
 *
 * Zero dependencies — `node:crypto` only, matching the project rule that
 * nothing new is added for something Node already does.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/** Every key this module is able to produce. Exported so a test can diff it. */
export const GENERATED_KEYS = [
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'COZE_SUPABASE_URL',
  'COZE_SUPABASE_ANON_KEY',
  'COZE_SUPABASE_SERVICE_ROLE_KEY',
  'COZE_SUPABASE_JWT_SECRET',
  'JWT_SECRET',
  'STORAGE_PUBLIC_BASE_URL',
  'S3_PROTOCOL_ACCESS_KEY_ID',
  'S3_PROTOCOL_ACCESS_KEY_SECRET',
  'NEXT_PUBLIC_APP_URL',
  'SITE_DOMAIN',
  'ACME_EMAIL',
  'ENCRYPTION_SECRET',
  'ROVEAGENT_API_KEY',
  'ROVEAGENT_APPROVAL_SECRET',
  'ROVEAGENT_LLM_API_KEY',
  'ROVEAGENT_LLM_BASE_URL',
  'ROVEAGENT_LLM_MODEL',
  'ROVEFRAME_PLATFORM_LLM_API_KEY',
  'ROVEFRAME_PLATFORM_LLM_BASE_URL',
  'ROVEFRAME_PLATFORM_LLM_MODEL',
  'WEB_PORT',
];

/** Keys that are written only when a value exists for them. */
export const CONDITIONAL_KEYS = ['IMAGE_REGISTRY'];

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : '';
    out[key] = value;
  }
  return out;
}

export function readExistingEnv(file) {
  const map = new Map();
  if (!existsSync(file)) return map;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    map.set(line.slice(0, eq).trim(), line.slice(eq + 1));
  }
  return map;
}

function urlSafe(bytes) {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Supabase's legacy symmetric API keys: a plain HS256 JWT whose payload carries
 * the role the request should run as. supabase-js sends it as
 * `Authorization: Bearer <key>`; PostgREST, GoTrue and Storage API verify the
 * signature and read `role` from the payload. A random string 401s everything.
 *
 * `iss: supabase` matches the convention Supabase's own tooling expects.
 * Nothing in src/ validates `iss` — src/lib/auth-guard.ts:126 checks the HS256
 * signature, `exp`, `sub` and `app_metadata.tenant_id` only.
 */
export function apiKey(role, jwtSecret) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 60 * 60 * 24 * 365 * 10; // 10 years, same order as Supabase's own
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({ role, iss: 'supabase', iat, exp });
  const signature = createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/**
 * Build the env file contents.
 *
 * Existing values always win. Regenerating JWT_SECRET logs every user out;
 * regenerating POSTGRES_PASSWORD locks the stack out of its own database,
 * because the password is baked into the data volume on first boot.
 */
export function buildDeployEnv(options = {}) {
  const existing = options.existing instanceof Map ? options.existing : new Map();
  const domain = (options.domain || '').trim();
  const email = (options.email || '').trim();
  const llmKey = (options.llmKey || '').trim();
  const llmBaseUrl = (options.llmBaseUrl || '').trim();
  const llmModel = (options.llmModel || '').trim();
  const registry = (options.registry || '').trim();
  const port = String(options.port || '').trim();

  const generated = new Map();
  const kept = [];

  const secretOf = (key, make) => {
    const prior = existing.get(key);
    if (prior) {
      kept.push(key);
      return prior;
    }
    const value = make();
    generated.set(key, value);
    return value;
  };

  const jwtSecret = secretOf('JWT_SECRET', () => urlSafe(48));
  const postgresPassword = secretOf('POSTGRES_PASSWORD', () => urlSafe(32));
  const anonKey = secretOf('COZE_SUPABASE_ANON_KEY', () => apiKey('anon', jwtSecret));
  const serviceRoleKey = secretOf('COZE_SUPABASE_SERVICE_ROLE_KEY', () => apiKey('service_role', jwtSecret));

  // The two runtime secrets MUST differ: roveagent/api/app.py answers 503 when
  // they match, so that holding the caller key does not also grant the right to
  // sign approval callbacks.
  const runtimeApiKey = secretOf('ROVEAGENT_API_KEY', () => urlSafe(36));
  let approvalSecret = secretOf('ROVEAGENT_APPROVAL_SECRET', () => urlSafe(36));
  if (approvalSecret === runtimeApiKey) {
    approvalSecret = urlSafe(36);
    generated.set('ROVEAGENT_APPROVAL_SECRET', approvalSecret);
  }

  const encryptionSecret = secretOf('ENCRYPTION_SECRET', () => randomBytes(32).toString('base64'));
  const s3KeyId = secretOf('S3_PROTOCOL_ACCESS_KEY_ID', () => urlSafe(18));
  const s3KeySecret = secretOf('S3_PROTOCOL_ACCESS_KEY_SECRET', () => urlSafe(32));

  const publicOrigin = existing.get('NEXT_PUBLIC_APP_URL')
    || (domain ? `https://${domain}` : 'http://localhost');

  const llmKeyWasPlaceholder = !existing.get('ROVEAGENT_LLM_API_KEY') && !llmKey;
  const llmKeyValue = existing.get('ROVEAGENT_LLM_API_KEY') || llmKey || 'not-configured';

  const lines = [];
  const push = (s = '') => lines.push(s);

  push('# ---------------------------------------------------------------------------');
  push('# RoveFrame AI Business OS — generated deployment environment');
  push('#');
  push('# Generated by scripts/gen-deploy-secrets.mjs. Re-running keeps every value');
  push('# already present here and only fills blanks, so it is safe to run again.');
  push('#');
  push('# NEVER commit this file. It matches the `*.env` rule in .gitignore.');
  push('# ---------------------------------------------------------------------------');
  push();
  push('# === Built-in database =====================================================');
  push('# Postgres runs in the `db` container. The password is applied to the supabase');
  push('# roles (authenticator / supabase_auth_admin / supabase_storage_admin) by');
  push('# docker/db/roles.sql on the FIRST boot of an empty data volume. Changing it');
  push('# after that locks the stack out of its own database.');
  push(`POSTGRES_PASSWORD=${postgresPassword}`);
  push('POSTGRES_DB=postgres');
  push();
  push('# The single origin the app uses for /rest/v1, /auth/v1 and /storage/v1.');
  push('# `gateway` is internal-only and is never published to the host.');
  push('COZE_SUPABASE_URL=http://gateway');
  push(`COZE_SUPABASE_ANON_KEY=${anonKey}`);
  push(`COZE_SUPABASE_SERVICE_ROLE_KEY=${serviceRoleKey}`);
  push('# Same value as JWT_SECRET: lets src/lib/auth-guard.ts:126 verify tokens');
  push('# in-process instead of calling GoTrue on every request.');
  push(`COZE_SUPABASE_JWT_SECRET=${jwtSecret}`);
  push(`JWT_SECRET=${jwtSecret}`);
  push('# Browser-facing base for uploaded media (src/app/api/upload/route.ts).');
  push('# Unset, the app falls back to COZE_SUPABASE_URL — right for Supabase Cloud,');
  push('# wrong here, because http://gateway does not resolve from a browser.');
  push(`STORAGE_PUBLIC_BASE_URL=${publicOrigin}`);
  push(`S3_PROTOCOL_ACCESS_KEY_ID=${s3KeyId}`);
  push(`S3_PROTOCOL_ACCESS_KEY_SECRET=${s3KeySecret}`);
  push();
  push('# === Public origin, domain and certificates ================================');
  push('# Read at RUNTIME (verified: NEXT_PUBLIC_APP_URL is not baked into the build).');
  push(`NEXT_PUBLIC_APP_URL=${publicOrigin}`);
  push('# Empty for an IP-only install. When set, /api/site/authorize approves');
  push('# this hostname for certificate issuance.');
  push(`SITE_DOMAIN=${existing.get('SITE_DOMAIN') ?? domain}`);
  push('# Optional: Let\'s Encrypt uses it for expiry warnings. Certificates are still');
  push('# issued without it.');
  push(`ACME_EMAIL=${existing.get('ACME_EMAIL') ?? email}`);
  push();
  push('# === Credential encryption =================================================');
  push('# src/lib/crypto.ts throws without it, and it MUST NOT equal the Supabase');
  push('# service key: rotating the database credential would then make every stored');
  push('# provider/email credential permanently undecryptable.');
  push(`ENCRYPTION_SECRET=${encryptionSecret}`);
  push();
  push('# === Runtime authentication (shared by web + roveagent) ====================');
  push('# Must differ from each other: roveagent/api/app.py refuses to start otherwise.');
  push(`ROVEAGENT_API_KEY=${runtimeApiKey}`);
  push(`ROVEAGENT_APPROVAL_SECRET=${approvalSecret}`);
  push();
  push('# === Models ================================================================');
  if (llmKeyWasPlaceholder) {
    push('# NOT CONFIGURED. /api/agent/chat answers 503 by design until a real key is');
    push('# here — the runtime never fabricates an answer. Replace this placeholder, or');
    push('# add a provider under Settings -> Models in the web UI.');
  }
  push(`ROVEAGENT_LLM_API_KEY=${llmKeyValue}`);
  push(`ROVEAGENT_LLM_BASE_URL=${existing.get('ROVEAGENT_LLM_BASE_URL') ?? llmBaseUrl}`);
  push(`ROVEAGENT_LLM_MODEL=${existing.get('ROVEAGENT_LLM_MODEL') ?? (llmModel || 'gpt-4o-mini')}`);
  push('# Optional platform fallback for tenants that configured no provider of their');
  push('# own. Without it such a tenant has no working model at all.');
  push(`ROVEFRAME_PLATFORM_LLM_API_KEY=${existing.get('ROVEFRAME_PLATFORM_LLM_API_KEY') ?? ''}`);
  push(`ROVEFRAME_PLATFORM_LLM_BASE_URL=${existing.get('ROVEFRAME_PLATFORM_LLM_BASE_URL') ?? ''}`);
  push(`ROVEFRAME_PLATFORM_LLM_MODEL=${existing.get('ROVEFRAME_PLATFORM_LLM_MODEL') ?? ''}`);
  push();
  push('# === Build / registry ======================================================');
  if (registry) {
    push('# Empty = Docker Hub (registry-1.docker.io). Set it when that registry is');
    push('# unreachable, e.g. docker.m.daocloud.io/ — note the trailing slash.');
    push(`IMAGE_REGISTRY=${registry}`);
  } else {
    push('# IMAGE_REGISTRY=docker.m.daocloud.io/');
  }
  push('# NPM_REGISTRY=https://registry.npmmirror.com (the default in docker-compose.yml)');
  push();
  push('# === Edge ===================================================================');
  push(`WEB_PORT=${existing.get('WEB_PORT') ?? (port || '5000')}`);

  return {
    content: `${lines.join('\n')}\n`,
    summary: {
      publicOrigin,
      siteDomain: domain || '(none — IP only)',
      keptExisting: kept.length,
      generated: generated.size,
      llmKeyConfigured: !llmKeyWasPlaceholder,
      imageRegistry: registry || '(default: Docker Hub)',
    },
    llmKeyWasPlaceholder,
  };
}
