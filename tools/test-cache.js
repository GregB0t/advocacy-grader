// Cache-layer regression tests (phase D). Run: npm test
//
// These guard three bugs that were live in the repo on 2026-08-30 and were not
// caught by any existing test, because no existing test read the cache:
//
//   1. TWELVE corpus evidence files were keyed on bare stems (gong.json,
//      linear.json …) while EvidenceCache keys on hostname, so a lookup of
//      gong.io or linear.app MISSED and paid a full cold run. Two of the twelve
//      were not even .com domains, so "append .com" would have been wrong.
//   2. The seed corpus expired at 7 days — on 2026-09-04, two days after ship.
//   3. out/ is gitignored, so a git deploy arrived with an EMPTY cache.
//
// The first test is the one that matters: EVERY host that has a published
// report must be a cache hit, checked against the SHIPPED seed archive rather
// than against whatever happens to be in the working tree — because the
// archive is what a fresh deploy actually gets.
import assert from 'node:assert/strict';
import { readdirSync, existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EvidenceCache, cacheKey, CACHE_TTL_MS } from '../lib/cache.js';
import { ensureSeed } from '../lib/seed.js';
import { Fetcher, setGlobalConcurrency, globalConcurrencyState } from '../lib/http.js';

let n = 0, failed = 0;
function test(name, fn) {
  try { fn(); n++; console.log('ok - ' + name); }
  catch (err) { failed++; console.error('FAIL - ' + name + '\n    ' + (err.message || err)); }
}
async function testAsync(name, fn) {
  try { await fn(); n++; console.log('ok - ' + name); }
  catch (err) { failed++; console.error('FAIL - ' + name + '\n    ' + (err.message || err)); }
}

const DAY = 24 * 60 * 60 * 1000;

// Unpack the shipped seed into a scratch dir: this is the deploy path.
const scratch = mkdtempSync(join(tmpdir(), 'grader-cache-test-'));
const seedResult = ensureSeed({ tgz: 'seed/calib.tgz', destRoot: scratch, quiet: true });
const seedDir = join(scratch, 'calib');

test('the shipped seed archive unpacks', () => {
  assert.ok(seedResult.ok, `seed/calib.tgz did not unpack: ${seedResult.reason || ''}`);
  assert.ok(seedResult.written > 300, `expected 300+ evidence files from the seed, got ${seedResult.written}`);
});

// ---- THE INVARIANT: every published report is a cache hit ----
test('EvidenceCache.get() hits for every host derived from site/reports/*.html', () => {
  assert.ok(existsSync('site/reports'), 'site/reports is missing — run `npm run build:site`');
  const hosts = readdirSync('site/reports')
    .filter((f) => f.endsWith('.html'))
    .map((f) => f.replace(/\.html$/, ''));
  assert.ok(hosts.length > 300, `expected 300+ published reports, found ${hosts.length}`);

  const cache = new EvidenceCache({ dir: join(scratch, 'writable'), seedDirs: [seedDir] });
  const misses = hosts.filter((h) => !cache.get(h));
  assert.deepEqual(misses, [], `${misses.length} published report(s) MISS the cache: ${misses.slice(0, 12).join(', ')}`);
});

test('a report filename that is a bare stem would be caught, not silently passed', () => {
  // Guards the guard: prove the check above can actually fail. 'gong' (the old
  // bare-stem key) must miss, while 'gong.io' (the real host) must hit.
  const cache = new EvidenceCache({ dir: join(scratch, 'writable'), seedDirs: [seedDir] });
  assert.equal(cache.get('gong'), null, "'gong' should NOT resolve — the test above would be vacuous if it did");
  assert.ok(cache.get('gong.io'), "'gong.io' should resolve");
  assert.ok(cache.get('linear.app'), "'linear.app' should resolve");
  assert.ok(cache.get('nvidia.com'), "'nvidia.com' should resolve");
});

test('www. and case variants collapse onto the same cache key', () => {
  const cache = new EvidenceCache({ dir: join(scratch, 'writable'), seedDirs: [seedDir] });
  assert.ok(cache.get('www.nvidia.com'), 'www.nvidia.com should hit nvidia.com');
  assert.ok(cache.get('NVIDIA.com'), 'NVIDIA.com should hit nvidia.com');
  assert.equal(cacheKey('www.Gong.io'), 'gong.io');
});

// ---- TTL: 30 days, measured at read time against meta.started_at ----
test('the TTL is 30 days', () => {
  assert.equal(CACHE_TTL_MS, 30 * DAY, 'CACHE_TTL_MS must be 30 days');
});

function withClock(offsetMs, fn) {
  const realNow = Date.now;
  Date.now = () => realNow.call(Date) + offsetMs;
  try { return fn(); } finally { Date.now = realNow; }
}

// The clock offsets below are measured from the evidence's OWN started_at, not
// from today. Measuring from today silently drifts as the corpus ages — the
// first draft of this test did exactly that and failed, because the corpus was
// already two days old and +29 days from now is +31 days from collection.
const ageOf = (ev) => Date.now() - Date.parse(ev.meta.started_at);

test('cached evidence still HITS at 29 days after collection', () => {
  const cache = new EvidenceCache({ dir: join(scratch, 'writable'), seedDirs: [seedDir] });
  const ev = cache.get('nvidia.com');
  assert.ok(ev, 'nvidia.com must be cached before its TTL can be tested');
  const toDay29 = 29 * DAY - ageOf(ev.evidence);
  const hit = withClock(toDay29, () => cache.get('nvidia.com'));
  assert.ok(hit, 'nvidia.com should still be a hit 29 days after collection');
});

test('cached evidence MISSES at 31 days after collection', () => {
  const cache = new EvidenceCache({ dir: join(scratch, 'writable'), seedDirs: [seedDir] });
  const ev = cache.get('nvidia.com');
  assert.ok(ev, 'nvidia.com must be cached before its TTL can be tested');
  const toDay31 = 31 * DAY - ageOf(ev.evidence);
  const miss = withClock(toDay31, () => cache.get('nvidia.com'));
  assert.equal(miss, null, 'nvidia.com should be stale 31 days after collection');
});

test('the shipped corpus is not already expired', () => {
  // The bug this whole phase exists for: the seed silently going cold. If this
  // fails, the corpus needs re-warming (tools/prewarm.js) before deploying.
  const cache = new EvidenceCache({ dir: join(scratch, 'writable'), seedDirs: [seedDir] });
  const hosts = readdirSync(seedDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  const cold = hosts.filter((h) => !cache.get(h));
  assert.deepEqual(cold, [], `${cold.length} seeded domain(s) have already expired: ${cold.slice(0, 8).join(', ')}`);
});

test('a failure envelope in the WRITABLE cache still self-heals in an hour', () => {
  // The short failure TTL must survive the 7 -> 30 day change: a site that was
  // merely down must not be frozen as "unreadable" for a month.
  const dir = join(scratch, 'failtest');
  mkdirSync(dir, { recursive: true });
  const started = new Date().toISOString();
  writeFileSync(join(dir, 'downsite.com.json'), JSON.stringify({ meta: { started_at: started, input: 'downsite.com' } }));
  const cache = new EvidenceCache({ dir, seedDirs: [] });
  assert.ok(cache.get('downsite.com'), 'a fresh failure envelope is still served');
  assert.equal(withClock(2 * 60 * 60 * 1000, () => cache.get('downsite.com')), null,
    'a failure envelope must expire after ~1 hour, not 30 days');
});

test('a failure envelope in a SEED dir keeps the full TTL', () => {
  // sociabble.com resolved no origin during calibration. As a curated seed it
  // must stay served, or the corpus develops holes.
  const cache = new EvidenceCache({ dir: join(scratch, 'writable'), seedDirs: [seedDir] });
  assert.ok(withClock(2 * 60 * 60 * 1000, () => cache.get('sociabble.com')),
    'a seeded failure envelope must not expire on the 1-hour failure TTL');
});

test('the cache never stores a score', () => {
  const dir = join(scratch, 'putstore');
  mkdirSync(dir, { recursive: true });
  const cache = new EvidenceCache({ dir, seedDirs: [] });
  cache.put('example.com', { meta: { started_at: new Date().toISOString() }, scoring: { grade: 'A' }, lead_score: { tier: 'hot' } });
  const back = cache.get('example.com');
  assert.ok(back, 'the written entry reads back');
  assert.equal('scoring' in back.evidence, false, 'a scoring block must never be persisted');
  assert.equal('lead_score' in back.evidence, false, 'a lead score must never be persisted');
});

// ---- the global request gate the batch runner depends on ----
await testAsync('the global HTTP gate never exceeds its cap', async () => {
  setGlobalConcurrency(4);
  try {
    let peak = 0, active = 0;
    const f = new Fetcher({ timeoutMs: 200 });
    f._get = async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return { ok: true }; };
    await Promise.all(Array.from({ length: 40 }, (_, i) => f.get('https://example.com/' + i)));
    assert.ok(peak <= 4, `peak in-flight was ${peak}, cap was 4`);
    assert.deepEqual(globalConcurrencyState(), { limit: 4, active: 0, queued: 0 });
  } finally { setGlobalConcurrency(0); }
});

test('the gate is OFF by default so the live server is never serialized', () => {
  assert.equal(globalConcurrencyState().limit, 0);
});

// ---- oversized responses must settle, never hang (the K2 349/350 bug) ----
// ultradentproducts.com serves a 33.5MB catalog page; res.destroy() on the
// oversize guard emitted neither 'end' nor 'error', so the fetch promise never
// settled, run() awaited forever, and prewarm died with Node exit 13. A fetch
// that trips maxBytes must RESOLVE (truncated), within bounded time.
await testAsync('a response larger than maxBytes resolves as truncated instead of hanging', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    const chunk = Buffer.alloc(64 * 1024, 'x');
    // Write far more than the fetcher's maxBytes, slowly enough that the
    // guard fires mid-stream, then keep the connection open: exactly the
    // shape that used to strand the promise.
    let sent = 0;
    const iv = setInterval(() => {
      sent += chunk.length;
      res.write(chunk);
      if (sent > 1024 * 1024) clearInterval(iv); // stop writing, never end()
    }, 1);
    res.on('close', () => clearInterval(iv));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // The SSRF guard refuses loopback by design; GRADER_ALLOW_PRIVATE exists
  // precisely for fixture tests against a local server. Restored below.
  const prevAllow = process.env.GRADER_ALLOW_PRIVATE;
  process.env.GRADER_ALLOW_PRIVATE = '1';
  try {
    const f = new Fetcher({ timeoutMs: 10000, maxBytes: 256 * 1024 });
    const result = await Promise.race([
      f.get(`http://127.0.0.1:${port}/huge`, { note: 'oversize test' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('fetch did not settle within 5s — the oversize hang is back')), 5000)),
    ]);
    assert.ok(result, 'fetch settled');
    assert.equal(result.error, null, `fetch errored instead of truncating: ${result.error}`);
  } finally {
    if (prevAllow === undefined) delete process.env.GRADER_ALLOW_PRIVATE; else process.env.GRADER_ALLOW_PRIVATE = prevAllow;
    server.close();
  }
});

if (failed) { console.error(`\n${failed} cache test(s) FAILED`); process.exit(1); }
console.log(`\n${n} tests passed`);
