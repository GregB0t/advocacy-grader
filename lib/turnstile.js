// Cloudflare Turnstile verification for the email gate.
//
// FOUR OUTCOMES, KEPT DISTINCT ON PURPOSE. Collapsing them is how a gate starts
// lying about what it checked:
//
//   no secret configured -> { ok: true,  skipped: true }      recorded 'not-enforced'
//   secret, but no token -> { ok: false, reason: 'missing-token' }        403
//   Cloudflare says no   -> { ok: false, reason: 'rejected', codes }      403
//   Cloudflare unreachable-> { ok: true, unreachable: true }   recorded 'unverified-outage'
//
// THE LAST ONE IS A DELIBERATE SOFT FALLBACK (Greg, 2026-09-01). An outage on
// Cloudflare's side is not evidence of a bot, and lead capture is this project's
// one irreversible gap — a lost real lead costs more than an admitted bot at this
// traffic. It is NOT recorded as 'passed', because nothing passed: the row says
// 'unverified-outage' so the exception is auditable rather than invisible.
// A MISSING or REJECTED token is still refused. Only a failure to REACH
// Cloudflare falls through.
export async function verifyTurnstile(token, ip, { secret = process.env.TURNSTILE_SECRET_KEY, timeoutMs = 8000 } = {}) {
  if (!secret) return { ok: true, skipped: true, note: 'TURNSTILE_SECRET_KEY not configured; challenge not enforced.' };
  if (!token) return { ok: false, reason: 'missing-token', error: 'missing turnstile token' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
    });
    // A non-2xx from the siteverify endpoint is Cloudflare failing to answer, not
    // Cloudflare rejecting the visitor. Treat it as an outage, not as a verdict.
    if (!res.ok) return { ok: true, unreachable: true, reason: 'unreachable', error: `siteverify HTTP ${res.status}` };
    const data = await res.json();
    if (data.success) return { ok: true, reason: 'passed' };
    return { ok: false, reason: 'rejected', codes: data['error-codes'] || [] };
  } catch (err) {
    // Network error, timeout/abort, or a body that was not JSON. In every case the
    // verdict is unknown rather than negative.
    return { ok: true, unreachable: true, reason: 'unreachable', error: String(err.message || err) };
  } finally { clearTimeout(timer); }
}

// One place that turns a verify result into the value stored on the lead row, so
// the report, the sheet and any future consumer read the same vocabulary.
export function turnstileOutcome(ts) {
  if (ts.skipped) return 'not-enforced';
  if (ts.unreachable) return 'unverified-outage';
  return 'passed';
}
