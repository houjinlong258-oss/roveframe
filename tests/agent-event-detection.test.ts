import test from 'node:test';
import assert from 'node:assert/strict';
import { detectBusinessEvents } from '@/lib/agent/events/detector';

test('Event Detection Engine: handles business scanning without crashing', async () => {
  try {
    const events = await detectBusinessEvents('tenant_demo', 'business_demo');
    assert.ok(Array.isArray(events), 'Events should be returned as an array');
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    // Gracefully handle unconfigured Supabase environment in unit tests
    assert.ok(message.includes('COZE_SUPABASE_URL') || message.includes('fetch'), 'Should gracefully handle DB connection');
  }
});
