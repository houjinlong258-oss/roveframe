#!/usr/bin/env node
/**
 * Generate `docker/deploy.env` for the self-hosted deployment.
 *
 *   node scripts/gen-deploy-secrets.mjs --domain app.example.com \
 *     --email ops@example.com --llm-key sk-... [--out docker/deploy.env]
 *
 * All the logic lives in scripts/lib/deploy-secrets.mjs so that
 * tests/selfhosted-deploy.test.ts can exercise the real implementation rather
 * than a copy of it. This file is only argument handling and I/O.
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildDeployEnv, parseArgs, readExistingEnv } from './lib/deploy-secrets.mjs';

const args = parseArgs(process.argv.slice(2));

if (args.help !== undefined) {
  process.stdout.write(
    'usage: node scripts/gen-deploy-secrets.mjs [--out docker/deploy.env]\n' +
    '         [--domain HOST] [--email ADDR] [--llm-key KEY]\n' +
    '         [--llm-base-url URL] [--llm-model NAME] [--registry PREFIX] [--port N]\n',
  );
  process.exit(0);
}

const outPath = path.resolve(args.out || path.join('docker', 'deploy.env'));

const { content, summary, llmKeyWasPlaceholder } = buildDeployEnv({
  existing: readExistingEnv(outPath),
  domain: args.domain,
  email: args.email,
  llmKey: args['llm-key'],
  llmBaseUrl: args['llm-base-url'],
  llmModel: args['llm-model'],
  registry: args.registry,
  port: args.port,
});

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, content, 'utf8');
try {
  chmodSync(outPath, 0o600);
} catch {
  // Windows has no meaningful POSIX mode; the file is still written.
}

process.stdout.write(`${JSON.stringify({ path: outPath, ...summary }, null, 2)}\n`);

if (llmKeyWasPlaceholder) {
  process.stderr.write(
    '\nWARNING: ROVEAGENT_LLM_API_KEY is a placeholder. The AI assistant will\n' +
    'answer 503 until a real key is set in docker/deploy.env (then: docker compose\n' +
    '--env-file docker/deploy.env up -d).\n',
  );
}
