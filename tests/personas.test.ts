import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERSONAS, resolvePersonaKey } from '../src/lib/agent/personas';

test('four executive personas exist with stable employee mapping', () => {
  assert.equal(PERSONAS.length, 4);
  const byKey = new Map(PERSONAS.map((p) => [p.key, p]));
  assert.equal(byKey.get('ceo-insight')?.employeeKey, 'ceo');
  assert.equal(byKey.get('coo')?.employeeKey, 'operations');
  assert.equal(byKey.get('cmo')?.employeeKey, 'marketing');
  assert.equal(byKey.get('cto')?.employeeKey, 'devops');
});

test('resolvePersonaKey normalizes unknown values to ceo-insight', () => {
  assert.equal(resolvePersonaKey('cmo'), 'cmo');
  assert.equal(resolvePersonaKey('cto'), 'cto');
  assert.equal(resolvePersonaKey(undefined), 'ceo-insight');
  assert.equal(resolvePersonaKey('hacker'), 'ceo-insight');
});

test('chat route forwards persona as employee key and never trusts raw input', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/api/agent/chat/route.ts'), 'utf8');
  assert.match(source, /resolvePersonaKey/);
  assert.match(source, /PERSONA_EMPLOYEE/);
});

test('agent page exposes persona selector chips', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/[locale]/agent/page.tsx'), 'utf8');
  assert.match(source, /PERSONAS\.map/);
  assert.match(source, /setPersona/);
  assert.match(source, /persona,/);
});

test('python personas map to the single runtime workforce', () => {
  const source = readFileSync(join(process.cwd(), 'roveagent/workforce/personas.py'), 'utf8');
  for (const key of ['ceo-insight', 'coo', 'cmo', 'cto']) {
    assert.ok(source.includes('"' + key + '"'), key + ' persona missing');
  }
});
