import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_CLOCK_SKEW_SECONDS = 300;

function secret(): string {
  return process.env.ROVEAGENT_APPROVAL_SECRET || process.env.ROVEAGENT_API_KEY || '';
}

export function signRoveAgentPayload(body: string, timestamp = Math.floor(Date.now() / 1000)): {
  timestamp: string;
  signature: string;
} {
  const value = secret();
  if (!value) throw new Error('RoveAgent approval signing secret is not configured');
  const timestampText = String(timestamp);
  return {
    timestamp: timestampText,
    signature: createHmac('sha256', value).update(`${timestampText}.${body}`).digest('hex'),
  };
}

export function verifyRoveAgentPayload(body: string, timestamp: string, signature: string): boolean {
  const value = secret();
  const parsedTimestamp = Number(timestamp);
  if (!value || !timestamp || !signature || !Number.isSafeInteger(parsedTimestamp)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - parsedTimestamp) > MAX_CLOCK_SKEW_SECONDS) return false;
  const expected = createHmac('sha256', value).update(`${timestamp}.${body}`).digest('hex');
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
