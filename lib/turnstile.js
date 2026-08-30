// Cloudflare Turnstile verification. The owner has not created a Turnstile
// widget yet, so with no TURNSTILE_SECRET_KEY configured this verifies
// nothing and says so honestly in the result — the form works today and
// tightens the moment the key lands in .env. No credential is invented.
export async function verifyTurnstile(token, ip, { secret = process.env.TURNSTILE_SECRET_KEY, timeoutMs = 8000 } = {}) {
  if (!secret) return { ok: true, skipped: true, note: 'TURNSTILE_SECRET_KEY not configured; challenge not enforced.' };
  if (!token) return { ok: false, error: 'missing turnstile token' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
    });
    const data = await res.json();
    return { ok: Boolean(data.success), codes: data['error-codes'] || [] };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  } finally { clearTimeout(timer); }
}
