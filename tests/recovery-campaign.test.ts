import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectChurnSegment, personalize } from '@/lib/agent/recovery-campaign';

interface CustomerRow {
  id: string;
  name: string;
  email: string | null;
  total_spent: string | number | null;
  visit_count: number | null;
  last_visit_at: string | null;
  churn_risk: string | null;
}

function row(partial: Partial<CustomerRow> & { id: string }): CustomerRow {
  return { name: 'Guest', email: 'guest@example.com', total_spent: 0, visit_count: 1, last_visit_at: null, churn_risk: null, ...partial };
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

test('selectChurnSegment: keeps inactive high-value customers and drops others', () => {
  const rows: CustomerRow[] = [
    row({ id: 'c1', name: 'A', email: 'a@x.com', total_spent: 1200, visit_count: 9, last_visit_at: daysAgo(90) }),
    row({ id: 'c2', name: 'B', email: 'b@x.com', total_spent: 300, visit_count: 2, last_visit_at: daysAgo(75) }),
    row({ id: 'c3', name: 'C', email: 'c@x.com', total_spent: 900, visit_count: 6, last_visit_at: daysAgo(10) }),
    row({ id: 'c4', name: 'D', email: null, total_spent: 2000, visit_count: 20, last_visit_at: daysAgo(120) }),
    row({ id: 'c5', name: 'E', email: 'e@x.com', total_spent: 1500, visit_count: 12, last_visit_at: null }),
  ];
  const segment = selectChurnSegment(rows, { daysInactive: 60, minTotalSpent: 800, limit: 100 });
  const ids = segment.map((c) => c.id);
  assert.ok(ids.includes('c1'), '90d inactive + high value');
  assert.ok(ids.includes('c5'), 'never visited = churn');
  assert.ok(!ids.includes('c2'), 'below value threshold');
  assert.ok(!ids.includes('c3'), 'still active');
  assert.ok(!ids.includes('c4'), 'no email contact');
  assert.equal(segment.find((c) => c.id === 'c1')?.days_since_last_visit, 90);
});

test('selectChurnSegment: sorts by lifetime spend and caps at limit', () => {
  const rows = [1, 2, 3].map((n) => row({
    id: 'c' + n, total_spent: n * 100, last_visit_at: daysAgo(80), email: 'c' + n + '@x.com',
  }));
  const segment = selectChurnSegment(rows, { daysInactive: 60, minTotalSpent: 0, limit: 2 });
  assert.deepEqual(segment.map((c) => c.id), ['c3', 'c2']);
});

test('personalize: replaces {name} placeholder only', () => {
  const out = personalize('Hi {name}, welcome back', { name: 'Alice' });
  assert.equal(out, 'Hi Alice, welcome back');
  assert.equal(personalize('No placeholder', { name: 'Alice' }), 'No placeholder');
});

test('internal business-data route exposes the campaign operations', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/api/internal/agent/business-data/route.ts'), 'utf8');
  assert.match(source, /'analyze_churn_customers'/);
  assert.match(source, /'send_recovery_campaign'/);
  assert.match(source, /executeRecoveryCampaign/);
  assert.match(source, /analyzeChurnCustomers/);
});

test('gate policy requires OWNER approval for the campaign tool', () => {
  const source = readFileSync(join(process.cwd(), 'roveagent/tools/framework.py'), 'utf8');
  assert.match(source, /ToolPolicy\("send_customer_recovery_campaign", "comms:send",/);
  assert.match(source, /ApprovalPolicy.OWNER/);
});

test('email queue processor performs the real status machine', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/email/outgoing.ts'), 'utf8');
  assert.ok(source.includes("status: 'sending'"), 'missing sending transition');
  assert.ok(source.includes("status: 'sent'"), 'missing sent transition');
  assert.ok(source.includes("status: 'failed'"), 'missing failed transition');
  assert.ok(source.includes("status: 'queued'"), 'missing requeue transition');
  assert.match(source, /nodemailer.createTransport/);
  assert.match(source, /recordCampaignMemory/);
});
