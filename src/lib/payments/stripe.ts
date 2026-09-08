import crypto from 'node:crypto';

const STRIPE_API = 'https://api.stripe.com/v1';

export interface StripeCheckoutInput {
  secretKey: string;
  amount: number;
  currency: string;
  description: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface StripePaymentIntent {
  id: string;
  status: string;
  amount: number;
  amount_received?: number;
  amount_refunded?: number;
  currency: string;
  latest_charge?: string | null;
}

export interface StripeRefund {
  id: string;
  status: string | null;
  amount: number;
  payment_intent: string;
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  payment_intent?: string | null;
}

const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG',
  'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const THREE_DECIMAL_CURRENCIES = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

export function currencyExponent(currency: string): number {
  const normalized = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(normalized)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(normalized)) return 3;
  return 2;
}

/** Create a hosted Checkout Session without shipping a heavyweight SDK. */
export async function createStripeCheckoutSession(
  input: StripeCheckoutInput,
): Promise<StripeCheckoutSession> {
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('line_items[0][price_data][currency]', input.currency.toLowerCase());
  params.set('line_items[0][price_data][product_data][name]', input.description);
  params.set('line_items[0][price_data][unit_amount]', String(toMinorUnits(input.amount, input.currency)));
  params.set('line_items[0][quantity]', '1');
  params.set('success_url', input.successUrl);
  params.set('cancel_url', input.cancelUrl);
  for (const [key, value] of Object.entries(input.metadata)) {
    params.set(`metadata[${key}]`, value);
    params.set(`payment_intent_data[metadata][${key}]`, value);
  }

  const response = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': input.idempotencyKey,
    },
    body: params,
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Stripe Checkout HTTP ${response.status}`);
  const data = (await response.json()) as Partial<StripeCheckoutSession>;
  if (typeof data.id !== 'string') throw new Error('Stripe Checkout response has no session id');
  return { id: data.id, url: typeof data.url === 'string' ? data.url : null, payment_intent: data.payment_intent };
}

function stripeError(status: number, payload: unknown): Error {
  const message = payload && typeof payload === 'object'
    && 'error' in payload && payload.error && typeof payload.error === 'object'
    && 'message' in payload.error && typeof payload.error.message === 'string'
    ? payload.error.message
    : `Stripe API HTTP ${status}`;
  return new Error(message);
}

export async function createStripeRefund(input: {
  secretKey: string;
  paymentIntentId: string;
  amountMinor?: number;
  idempotencyKey: string;
  metadata: Record<string, string>;
}): Promise<StripeRefund> {
  const params = new URLSearchParams({ payment_intent: input.paymentIntentId });
  if (input.amountMinor !== undefined) params.set('amount', String(input.amountMinor));
  for (const [key, value] of Object.entries(input.metadata)) params.set(`metadata[${key}]`, value);
  const response = await fetch(`${STRIPE_API}/refunds`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': input.idempotencyKey,
    },
    body: params,
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json() as Partial<StripeRefund> & Record<string, unknown>;
  if (!response.ok) throw stripeError(response.status, payload);
  if (typeof payload.id !== 'string' || typeof payload.amount !== 'number' || typeof payload.payment_intent !== 'string') {
    throw new Error('Stripe Refund response is incomplete');
  }
  return { id: payload.id, status: typeof payload.status === 'string' ? payload.status : null,
    amount: payload.amount, payment_intent: payload.payment_intent };
}

export async function retrieveStripePaymentIntent(
  secretKey: string,
  paymentIntentId: string,
): Promise<StripePaymentIntent> {
  const response = await fetch(`${STRIPE_API}/payment_intents/${encodeURIComponent(paymentIntentId)}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json() as Partial<StripePaymentIntent> & Record<string, unknown>;
  if (!response.ok) throw stripeError(response.status, payload);
  if (typeof payload.id !== 'string' || typeof payload.status !== 'string'
    || typeof payload.amount !== 'number' || typeof payload.currency !== 'string') {
    throw new Error('Stripe PaymentIntent response is incomplete');
  }
  return payload as StripePaymentIntent;
}

export function mapStripePaymentStatus(status: string): string {
  if (status === 'succeeded') return 'paid';
  if (status === 'canceled') return 'cancelled';
  if (status === 'requires_payment_method') return 'failed';
  return status;
}

export function validateStripeRuntime(secretKey: string, appOrigin: string): void {
  if (!/^sk_(?:test|live)_[A-Za-z0-9]+$/.test(secretKey)) throw new Error('Stripe secret key format is invalid');
  if (process.env.NODE_ENV !== 'production') return;
  if (new URL(appOrigin).protocol !== 'https:') throw new Error('Stripe production checkout requires HTTPS');
  if (!secretKey.startsWith('sk_live_') && process.env.STRIPE_ALLOW_TEST_MODE !== '1') {
    throw new Error('Stripe production checkout requires a live secret key');
  }
}

/** Verify Stripe-Signature using the documented timestamped HMAC scheme. */
export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const fields = signatureHeader.split(',').map((part) => part.trim());
  const timestamp = fields.find((part) => part.startsWith('t='))?.slice(2);
  const signatures = fields.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
  if (!timestamp || signatures.length === 0 || !/^\d+$/.test(timestamp)) return false;
  const timestampNumber = Number(timestamp);
  if (!Number.isSafeInteger(timestampNumber) || Math.abs(nowSeconds - timestampNumber) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', webhookSecret).update(`${timestamp}.${rawBody}`).digest('hex');
  return signatures.some((candidate) => {
    const actual = Buffer.from(candidate, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
  });
}

export function toMinorUnits(amount: number, currency = 'USD'): number {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be greater than zero');
  const minor = Math.round(amount * (10 ** currencyExponent(currency)));
  if (!Number.isSafeInteger(minor) || minor > 99_999_999) throw new Error('amount is out of range');
  return minor;
}
