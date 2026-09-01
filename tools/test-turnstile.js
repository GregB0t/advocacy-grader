// Turnstile verification tests (phase G). Run: npm test
//
// WHY THIS SUITE EXISTS: lib/turnstile.js decides whether a lead is accepted, and
// its four outcomes are easy to collapse into two. Collapsing them is how a gate
// starts claiming it checked something it did not:
//
//   no secret          -> accept, recorded 'not-enforced'
//   secret, no token   -> REFUSE
//   Cloudflare says no -> REFUSE
//   Cloudflare down    -> accept, recorded 'unverified-outage'  (NEVER 'passed')
//
// The last line is the one worth a test. A soft fallback that recorded 'passed'
// would be a fabricated signal in the lead data, which is the same class of error
// spec §7 forbids in the public report.
//
// These tests stub globalThis.fetch, so they are hermetic: no network, no key, no
// Cloudflare account. The REAL siteverify endpoint is exercised separately, by
// hand, against Cloudflare's published dummy secrets — a stub can only prove the
// branching, never that the wire format still matches.
import assert from 'node:assert/strict';
import { verifyTurnstile, turnstileOutcome } from '../lib/turnstile.js';

let n = 0, failed = 0;
async function test(name, fn) {
  const realFetch = globalThis.fetch;
  try { await fn(); n++; console.log('ok - ' + name); }
  catch (err) { failed++; console.error('FAIL - ' + name + '\n    ' + (err.message || err)); }
  finally { globalThis.fetch = realFetch; }
}
const SECRET = 'test-secret-never-sent-anywhere';
const stub = (impl) => { globalThis.fetch = impl; };
const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

await test('no secret configured: accepted, skipped, and recorded not-enforced', async () => {
  let called = false;
  stub(async () => { called = true; return jsonRes({ success: true }); });
  const r = await verifyTurnstile('anything', '1.2.3.4', { secret: '' });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(called, false, 'siteverify must not be called when there is no secret');
  assert.equal(turnstileOutcome(r), 'not-enforced');
});

await test('secret set but no token: REFUSED, and Cloudflare is never called', async () => {
  let called = false;
  stub(async () => { called = true; return jsonRes({ success: true }); });
  const r = await verifyTurnstile('', '1.2.3.4', { secret: SECRET });
  assert.equal(r.ok, false, 'a missing token must not be accepted once a secret is configured');
  assert.equal(r.reason, 'missing-token');
  assert.equal(called, false);
});

await test('Cloudflare accepts: ok, and recorded passed', async () => {
  stub(async () => jsonRes({ success: true }));
  const r = await verifyTurnstile('tok', null, { secret: SECRET });
  assert.equal(r.ok, true);
  assert.equal(r.unreachable, undefined, 'a real pass must not be marked unreachable');
  assert.equal(turnstileOutcome(r), 'passed');
});

await test('Cloudflare rejects: REFUSED, and the error codes survive', async () => {
  stub(async () => jsonRes({ success: false, 'error-codes': ['invalid-input-response'] }));
  const r = await verifyTurnstile('tok', null, { secret: SECRET });
  assert.equal(r.ok, false, 'a rejected token must be refused');
  assert.equal(r.reason, 'rejected');
  assert.deepEqual(r.codes, ['invalid-input-response']);
});

await test('a spent token is a REJECTION, not an outage', async () => {
  // Cloudflare answers 200 with success:false for a replayed token. If that ever
  // fell into the outage branch, replay would become free.
  stub(async () => jsonRes({ success: false, 'error-codes': ['timeout-or-duplicate'] }));
  const r = await verifyTurnstile('tok', null, { secret: SECRET });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'rejected');
});

await test('network error: accepted as an OUTAGE and never recorded as passed', async () => {
  stub(async () => { throw new Error('getaddrinfo ENOTFOUND challenges.cloudflare.com'); });
  const r = await verifyTurnstile('tok', null, { secret: SECRET });
  assert.equal(r.ok, true, 'a Cloudflare outage must not block lead capture');
  assert.equal(r.unreachable, true);
  assert.notEqual(turnstileOutcome(r), 'passed', 'an outage must never be recorded as a pass');
  assert.equal(turnstileOutcome(r), 'unverified-outage');
});

await test('siteverify HTTP 500 is an outage, not a verdict', async () => {
  stub(async () => jsonRes({}, false, 500));
  const r = await verifyTurnstile('tok', null, { secret: SECRET });
  assert.equal(r.ok, true);
  assert.equal(turnstileOutcome(r), 'unverified-outage');
});

await test('a non-JSON body is an outage, not a pass and not a rejection', async () => {
  stub(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
  const r = await verifyTurnstile('tok', null, { secret: SECRET });
  assert.equal(r.ok, true);
  assert.equal(turnstileOutcome(r), 'unverified-outage');
});

await test('the timeout aborts and lands in the outage branch', async () => {
  stub((_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new Error('The operation was aborted.')));
  }));
  const started = Date.now();
  const r = await verifyTurnstile('tok', null, { secret: SECRET, timeoutMs: 60 });
  assert.ok(Date.now() - started < 5000, 'verify hung instead of aborting');
  assert.equal(r.ok, true);
  assert.equal(turnstileOutcome(r), 'unverified-outage');
});

await test('the recorded vocabulary is exactly three values', async () => {
  assert.equal(turnstileOutcome({ ok: true, skipped: true }), 'not-enforced');
  assert.equal(turnstileOutcome({ ok: true, unreachable: true }), 'unverified-outage');
  assert.equal(turnstileOutcome({ ok: true, reason: 'passed' }), 'passed');
});

await test('the remote IP is forwarded, and the secret is sent as a form field not a header', async () => {
  let seen = null;
  stub(async (_url, opts) => { seen = opts; return jsonRes({ success: true }); });
  await verifyTurnstile('tok', '9.9.9.9', { secret: SECRET });
  const params = new URLSearchParams(seen.body.toString());
  assert.equal(params.get('secret'), SECRET);
  assert.equal(params.get('response'), 'tok');
  assert.equal(params.get('remoteip'), '9.9.9.9');
  assert.equal(JSON.stringify(seen.headers).includes(SECRET), false, 'the secret must not travel in a header');
});

if (failed) { console.error(`\n${failed} turnstile test(s) FAILED`); process.exit(1); }
console.log(`\n${n} tests passed`);
