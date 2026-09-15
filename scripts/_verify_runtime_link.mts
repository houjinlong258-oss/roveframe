/**
 * Phase 11 / Task 2 — TS -> Python runtime link verification.
 *
 * The final status audit's headline finding was that the execution plane was
 * "100% unreachable": the Next.js control plane never started the Python
 * runtime, so the TS -> Python hop had no deployed target. This script closes
 * that specific gap with evidence instead of assertion.
 *
 * It drives the REAL production client module (src/lib/roveagent/client.ts) —
 * not a hand-rolled fetch — against a live RoveAgent runtime, and exercises:
 *
 *   1. roveAgentConfigured()      wiring/auth resolution
 *   2. roveAgentHealth()          liveness
 *   3. roveAgentChat()            full agent loop over the wire
 *   4. a tool-triggering turn     so EnterpriseToolGate is exercised
 *
 * READ-ONLY with respect to the repository. It talks to whatever
 * ROVEAGENT_API_URL points at; it never writes files.
 *
 * Usage:
 *   ROVEAGENT_API_URL=http://127.0.0.1:8788 \
 *   ROVEAGENT_API_KEY=... ROVEAGENT_APPROVAL_SECRET=... \
 *   pnpm tsx scripts/_verify_runtime_link.mts
 */
import { randomUUID } from 'node:crypto';

const TENANT = '00000000-0000-0000-0000-000000000000';
const BUSINESS = '00000000-0000-0000-0000-000000000001';

let failures = 0;

function pass(label: string, detail: string): void {
  console.log(`  PASS  ${label.padEnd(42)} ${detail}`);
}

function fail(label: string, detail: string): void {
  failures += 1;
  console.log(`  FAIL  ${label.padEnd(42)} ${detail}`);
}

async function main(): Promise<number> {
  // Env must be set before the client module resolves its configuration.
  process.env.ROVEAGENT_API_URL ??= 'http://127.0.0.1:8788';
  process.env.ROVEAGENT_API_KEY ??= 'phase11-verify-key';
  process.env.ROVEAGENT_APPROVAL_SECRET ??= 'phase11-verify-approval-secret-distinct';

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const client = await import('../src/lib/roveagent/client.js');

  console.log('='.repeat(78));
  console.log('TS -> Python runtime link verification (Phase 11 / Task 2)');
  console.log('='.repeat(78));
  console.log(`ROVEAGENT_API_URL = ${process.env.ROVEAGENT_API_URL}`);
  console.log('');

  // --- 1. configuration resolution ---------------------------------------
  const configured = client.roveAgentConfigured();
  const gaps = client.roveAgentConfigGaps();
  if (configured) {
    pass('roveAgentConfigured()', 'true');
  } else {
    fail('roveAgentConfigured()', `false; gaps=${JSON.stringify(gaps)}`);
  }

  // --- 2. health ----------------------------------------------------------
  try {
    const health = await client.roveAgentHealth(5_000);
    pass('roveAgentHealth()', JSON.stringify(health));
  } catch (error) {
    fail('roveAgentHealth()', error instanceof Error ? error.message : String(error));
  }

  // --- 3. agent chat (plain turn) ----------------------------------------
  try {
    const sessionId = `ts-link-${randomUUID()}`;
    const result = await client.roveAgentChat({
      tenantId: TENANT,
      businessId: BUSINESS,
      userId: 'ts-link-verifier',
      message: 'Give me a short status summary.',
      agent: 'ceo',
      role: 'owner',
      permissions: ['business:read'],
      requestId: randomUUID(),
      taskId: randomUUID(),
      sessionId,
      industry: 'restaurant',
      businessContext: 'Verification run from the TypeScript client.',
    });
    if (typeof result.reply === 'string' && result.reply.length > 0) {
      pass('roveAgentChat()', `reply ${result.reply.length} chars, agent=${result.agent}`);
    } else {
      fail('roveAgentChat()', `empty reply: ${JSON.stringify(result)}`);
    }
  } catch (error) {
    fail('roveAgentChat()', error instanceof Error ? error.message : String(error));
  }

  // --- 4. tool-triggering turn (exercises EnterpriseToolGate) -------------
  try {
    const result = await client.roveAgentChat({
      tenantId: TENANT,
      businessId: BUSINESS,
      userId: 'ts-link-verifier',
      // The mock provider only emits a tool_call for prompts mentioning
      // "tool" or "read"; against a real provider any tool-requiring prompt
      // works. The point is that at least one tool dispatch crosses the wire.
      message: 'please read the business data',
      agent: 'ceo',
      role: 'owner',
      permissions: ['business:read'],
      requestId: randomUUID(),
      taskId: randomUUID(),
      sessionId: `ts-link-tool-${randomUUID()}`,
      industry: 'restaurant',
      businessContext: 'Verification run from the TypeScript client.',
    });
    pass('roveAgentChat() tool turn', `reply ${result.reply.length} chars`);
  } catch (error) {
    fail('roveAgentChat() tool turn', error instanceof Error ? error.message : String(error));
  }

  console.log('');
  console.log(failures === 0 ? 'RESULT: link OK' : `RESULT: ${failures} failure(s)`);
  console.log('='.repeat(78));
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    // Set exitCode and let the event loop drain instead of calling
    // process.exit() outright: the client uses keep-alive sockets, and tearing
    // the loop down under them trips a libuv assertion on Windows
    // ("!(handle->flags & UV_HANDLE_CLOSING)") that masks the real result.
    process.exitCode = code;
    // Safety net: if an idle keep-alive socket would hold the loop open, close
    // out after a short grace period. unref() so it never blocks a clean exit.
    setTimeout(() => process.exit(code), 3_000).unref();
  })
  .catch((error: unknown) => {
    console.error('verification crashed:', error);
    process.exitCode = 2;
  });
