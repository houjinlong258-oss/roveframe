import { clearSessionCookieHeader } from '@/lib/auth';
import { json } from '@/lib/api-helpers';

/** Clears the browser-only session cookie. Supabase JWT expiry remains the server-side limit. */
export async function POST() {
  const response = json({ ok: true });
  response.headers.set('Set-Cookie', clearSessionCookieHeader());
  return response;
}
