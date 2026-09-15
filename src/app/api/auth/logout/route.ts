import { clearSessionCookieHeader, isSecureRequest } from '@/lib/auth';
import { json } from '@/lib/api-helpers';

/** Clears the browser-only session cookie. Supabase JWT expiry remains the server-side limit. */
export async function POST(request: Request) {
  const response = json({ ok: true });
  response.headers.set('Set-Cookie', clearSessionCookieHeader(isSecureRequest(request)));
  return response;
}
