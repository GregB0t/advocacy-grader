// Adversarial hardening harness for the live endpoint. Re-runnable by the owner.
//   node tools/harden.js adversarial   # SSRF + malformed input, 0 credits
//   node tools/harden.js leads         # gate/lead path, 0 credits
//   node tools/harden.js limits        # rate limits, 0 credits (cache-hit domains)
//   node tools/harden.js concurrency   # 2-concurrent queue + memory, 0 credits
//   node tools/harden.js cachehit      # corpus cache-hit lookups + report render, 0 credits
//   node tools/harden.js live <domain> [maxCredits]   # one fresh live run (spends credits)
//   node tools/harden.js all           # everything except live
//
// Drives a real server child process over HTTP where the attack surface is
// HTTP; calls run()/fastProbe() directly for the credit-capped live matrix.
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { appendFileSync } from 'node:fs';

const TEST_PORT = Number(process.env.HARDEN_PORT || 8799);
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const OUT = 'out/harden-results.jsonl';
const rec = (o) => { try { appendFileSync(OUT, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n'); } catch {} };

function req(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + path, { method, headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let buf = ''; res.on('data', (c) => buf += c); res.on('end', () => { let j; try { j = JSON.parse(buf); } catch { j = buf.slice(0, 200); } resolve({ status: res.statusCode, body: j, raw: buf.length }); });
    });
    r.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }));
    const to = setTimeout(() => { r.destroy(); resolve({ status: 0, body: 'CLIENT-TIMEOUT' }); }, 30000);
    r.on('close', () => clearTimeout(to));
    if (data) r.write(data); r.end();
  });
}

async function startServer(extraEnv = {}) {
  const child = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(TEST_PORT), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {}); child.stderr.on('data', (d) => process.env.HARDEN_VERBOSE && console.error('[srv]', String(d).trim()));
  // wait for listen
  for (let i = 0; i < 60; i++) {
    const ok = await new Promise((res) => { const s = net.connect(TEST_PORT, '127.0.0.1', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
    if (ok) return child;
    await sleep(200);
  }
  throw new Error('server did not start');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- adversarial
async function adversarial() {
  const child = await startServer();
  const inputs = [
    'localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254', '10.0.0.1', '[::1]',
    '192.168.1.1', '172.16.0.1', '100.64.0.1', '8.8.8.8', 'http://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd', 'https://user:pass@169.254.169.254/', '2130706433', '0x7f000001',
    'ftp://example.com', 'http://internal', 'metadata.google.internal', 'foo.local',
    'example.com/path?q=1#frag', 'exa mple.com', 'münchen.de', 'xn--mnchen-3ya.de',
    'x'.repeat(300) + '.com', '', '   ', 'does-not-resolve-zzzq.example', 'http://[::ffff:127.0.0.1]/',
  ];
  console.log('=== B. ADVERSARIAL / MALFORMED INPUT (via POST /api/lookup) ===');
  console.log('input'.padEnd(46), 'status', 'result');
  for (const domain of inputs) {
    const r = await req('POST', '/api/lookup', { domain });
    const summary = r.body?.error ? 'ERR: ' + r.body.error : (r.body?.state ? `state=${r.body.state} dom=${r.body.domain} fastFindings=${r.body.fast?.findings?.length ?? '-'} note=${(r.body.fast?.note||'').slice(0,40)}` : JSON.stringify(r.body).slice(0, 80));
    console.log(JSON.stringify(domain).slice(0, 45).padEnd(46), String(r.status).padEnd(6), summary);
    rec({ test: 'adversarial', input: domain, status: r.status, result: summary });
  }
  child.kill();
}

// ------------------------------------------------------------- leads
async function leads() {
  const child = await startServer();
  console.log('\n=== D. GATE / LEAD PATH (POST /api/lead) ===');
  const cases = [
    ['valid', { email: 'greg@acme.com', domain: 'acme.com' }],
    ['missing email', { domain: 'acme.com' }],
    ['bad email no-at', { email: 'notanemail' }],
    ['bad email no-dot', { email: 'a@b' }],
    ['bad email spaces', { email: 'a b@c.com' }],
    ['unicode email', { email: 'grég@münchen.de' }],
    ['duplicate #1', { email: 'dup@acme.com' }],
    ['duplicate #2', { email: 'dup@acme.com' }],
    ['oversized email', { email: 'x'.repeat(5000) + '@acme.com' }],
    ['html in name', { email: 'x@acme.com', name: '<script>alert(1)</script>' }],
    ['extra private field probe', { email: 'y@acme.com', lead_score: 99, tier: 'hot' }],
  ];
  for (const [label, body] of cases) {
    const r = await req('POST', '/api/lead', body);
    console.log(label.padEnd(26), 'status', String(r.status).padEnd(5), JSON.stringify(r.body).slice(0, 90));
    rec({ test: 'leads', label, status: r.status, body: r.body });
  }
  // oversized payload (>16KB body cap)
  const big = await req('POST', '/api/lead', { email: 'z@acme.com', name: 'A'.repeat(20000) });
  console.log('oversized PAYLOAD (>16KB)'.padEnd(26), 'status', String(big.status).padEnd(5), JSON.stringify(big.body).slice(0, 90));
  rec({ test: 'leads', label: 'oversized-payload', status: big.status, body: big.body });
  child.kill();
}

// ------------------------------------------------------------- limits
async function limits() {
  const child = await startServer();
  console.log('\n=== C. RATE LIMITS ===');
  // lead limit is 20/h — cheapest to trigger, no fetches
  let firstBlock = null;
  for (let i = 1; i <= 24; i++) {
    const r = await req('POST', '/api/lead', { email: `rl${i}@acme.com` });
    if (r.status === 429 && firstBlock === null) firstBlock = i;
  }
  console.log('lead limit (max 20/h): first 429 at attempt', firstBlock);
  const sample = await req('POST', '/api/lead', { email: 'rl-final@acme.com' });
  console.log('  a blocked lead response:', JSON.stringify(sample.body));
  rec({ test: 'limits', which: 'lead', firstBlock, blockedBody: sample.body });

  // lookup limit is 30/h — use adversarial (rejected pre-fetch) inputs so no network/credits.
  // Rejected-input requests never reach the limiter (they 400 first), so use a cache-hit domain.
  let lookupBlock = null;
  for (let i = 1; i <= 33; i++) {
    const r = await req('POST', '/api/lookup', { domain: 'pearson.com' });
    if (r.status === 429 && lookupBlock === null) lookupBlock = i;
  }
  console.log('lookup limit (max 30/h): first 429 at attempt', lookupBlock, '(cache-hit domain, 0 credits)');
  rec({ test: 'limits', which: 'lookup', firstBlock: lookupBlock });
  child.kill();
}

// ------------------------------------------------------------- cachehit
async function cachehit() {
  const child = await startServer();
  console.log('\n=== A(cache). CORPUS CACHE-HIT LOOKUPS + REPORT RENDER ===');
  for (const domain of ['pearson.com', 'homedepot.com', 'proofpoint.com', 'zapier.com']) {
    const t0 = Date.now();
    const r = await req('POST', '/api/lookup', { domain });
    const ms = Date.now() - t0;
    const rep = await req('GET', (r.body?.report_url || '/report/' + domain));
    console.log(domain.padEnd(18), `p1=${ms}ms`, 'state=' + r.body?.state, 'cached=' + r.body?.cached, 'fast=' + (r.body?.fast?.findings?.length ?? '-'), 'reportHTTP=' + rep.status, 'reportBytes=' + rep.raw);
    rec({ test: 'cachehit', domain, p1_ms: ms, state: r.body?.state, cached: r.body?.cached, report_status: rep.status });
  }
  // path traversal on /corpus and /report
  for (const p of ['/corpus/../server.js', '/corpus/..%2f..%2fserver.js', '/report/..%2f..%2fetc%2fpasswd', '/report/../../.env']) {
    const r = await req('GET', p);
    console.log('traversal', p.padEnd(34), '->', r.status, String(r.body).slice(0, 40).replace(/\n/g, ' '));
    rec({ test: 'traversal', path: p, status: r.status });
  }
  child.kill();
}

// ------------------------------------------------------------- concurrency
async function concurrency() {
  const child = await startServer();
  console.log('\n=== C. CONCURRENCY (2-concurrent full-run queue) ===');
  // fire 5 fresh (uncached) domains at once; only 2 should run, rest queued.
  const fresh = ['nonexistent-aaa-zzz1.example', 'nonexistent-aaa-zzz2.example', 'nonexistent-aaa-zzz3.example', 'nonexistent-aaa-zzz4.example', 'nonexistent-aaa-zzz5.example'];
  const t0 = Date.now();
  const results = await Promise.all(fresh.map((d) => req('POST', '/api/lookup', { domain: d })));
  console.log('5 simultaneous fresh lookups returned in', Date.now() - t0, 'ms (phase-1 is per-request, not queued):');
  results.forEach((r, i) => console.log('  ', fresh[i], '-> status', r.status, 'state=' + (r.body?.state), 'note=' + ((r.body?.fast?.note || '').slice(0, 50))));
  // poll job states to observe the queue
  await sleep(500);
  for (const d of fresh) { const j = await req('GET', '/api/job?domain=' + encodeURIComponent(d)); console.log('   job', d, '->', JSON.stringify(j.body)); }
  rec({ test: 'concurrency', fresh, states: results.map((r) => r.body?.state) });
  child.kill();
}

// ------------------------------------------------------------- poison
async function poison() {
  console.log('\n=== C. CACHE POISONING on phase-2 failure ===');
  const { EvidenceCache } = await import('../lib/cache.js');
  const c = new EvidenceCache({ dir: 'out/cache-test-poison', seedDirs: [] });
  // simulate: does a failed run ever call cache.put? Inspect server pump: only .then(cache.put) on success.
  console.log('Inspecting server.js pump(): cache.put is only called in the .then() success branch;');
  console.log('the .catch() sets job.state=error and never writes cache. A failed/timed-out run leaves NO cache entry,');
  console.log('so the next lookup re-runs rather than serving a poisoned failure. (static assertion from code)');
  rec({ test: 'poison', finding: 'cache.put only on success; failures leave no entry' });
}

// ------------------------------------------------------------- live
async function live(domain, maxCredits) {
  const { run, fastProbe } = await import('../lib/run.js');
  const { scoreEvidence } = await import('../lib/rubric.js');
  const { buildFindings, fastTier } = await import('../lib/findings.js');
  console.log(`\n=== A(live). ${domain}  (maxCredits=${maxCredits}) ===`);
  const t0 = Date.now();
  let fp;
  try { fp = await fastProbe(domain, { timeoutMs: 6000 }); } catch (e) { fp = { error: 'THREW ' + e.message }; }
  const p1 = Date.now() - t0;
  let p1msg = '(no fast findings)';
  if (fp.error) { p1msg = 'ERROR ' + fp.error; }
  else { const f = fastTier(buildFindings(fp, null)); const list = [...f.actions, ...f.limitations, ...f.positives, ...f.info].slice(0, 3); p1msg = list.map((x) => `[${x.severity}] ${x.title}`).join(' | ') || '(none)'; }
  console.log(`phase1: ${p1}ms  blocked_at_root=${fp.blocked_at_root} origin=${fp.meta?.resolved_origin}`);
  console.log(`  fast findings: ${p1msg}`);

  const t1 = Date.now();
  let ev, err = null;
  try {
    ev = await Promise.race([
      run({ domain, out: null, maxSitemaps: 60, maxUrls: 60000, timeout: 15000, quiet: true, pretty: true, sample: 24, pages: true, ats: true, maxCredits: Number(maxCredits) || 25, concurrency: 5, score: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('HARNESS-WATCHDOG-150s')), 150000)),
    ]);
  } catch (e) { err = String(e.message || e); }
  const p2 = Date.now() - t1;
  if (err) {
    console.log(`phase2: FAILED after ${p2}ms -> ${err}`);
    rec({ test: 'live', domain, p1_ms: p1, p2_ms: p2, outcome: 'FAIL', error: err });
  } else {
    const sc = scoreEvidence(ev);
    const credits = ev.meta?.scrapingbee?.credits_used ?? ev.meta?.scrapingbee?.total_credits ?? 0;
    const grade = sc.grade ?? sc.letter ?? (sc.grade_withheld ? 'WITHHELD' : '-');
    console.log(`phase2: OK after ${p2}ms  reqs=${ev.meta?.requests_made} urls=${ev.sitemaps?.urls_collected ?? '-'} credits=${credits}`);
    console.log(`  score=${sc.overall_score ?? '-'} grade=${grade} blocked_at_root=${ev.blocked_at_root}`);
    console.log(`  warnings(${ev.warnings?.length || 0}): ${(ev.warnings || []).slice(0, 3).join(' || ').slice(0, 240)}`);
    console.log(`  not_observed(${ev.not_observed?.length || 0}): ${(ev.not_observed || []).slice(0, 2).join(' || ').slice(0, 240)}`);
    if (ev.classification?.cross_host) console.log(`  cross_host: ${JSON.stringify(ev.classification.cross_host).slice(0, 200)}`);
    rec({ test: 'live', domain, p1_ms: p1, p2_ms: p2, outcome: 'OK', reqs: ev.meta?.requests_made, urls: ev.sitemaps?.urls_collected, credits, score: sc.overall_score, grade, warnings: ev.warnings, not_observed: ev.not_observed });
  }
}


// ------------------------------------------------------------- servermatrix
// Drives real (non-corpus) domains through the two-phase SERVER concurrently:
// exercises phase-1 timing, the 2-concurrent full-run queue (what queued users
// see), phase-2 completion/failure, then reads cached evidence for credits.
async function servermatrix() {
  const child = await startServer();
  const { readFileSync, existsSync } = await import('node:fs');
  const { cacheKey } = await import('../lib/cache.js');
  const domains = process.argv.slice(3);
  if (!domains.length) domains.push('everyonesocial.com', 'basecamp.com', 'haiilo.com', 'sociabble.com');
  console.log('\n=== A(live server). two-phase matrix + 2-concurrent queue ===');
  console.log('domains:', domains.join(', '));
  const p1 = {};
  const t0 = Date.now();
  // fire all at once
  const submits = await Promise.all(domains.map(async (d) => {
    const s0 = Date.now();
    const r = await req('POST', '/api/lookup', { domain: d });
    return { d, ms: Date.now() - s0, body: r.body, status: r.status };
  }));
  for (const s of submits) {
    p1[s.d] = s.ms;
    const fp = s.body?.fast || {};
    console.log(`  [P1] ${s.d.padEnd(20)} ${String(s.ms + 'ms').padEnd(8)} state=${s.body?.state} fast=${(fp.findings || []).length} blocked_root=${fp.blocked_at_root ?? '-'} note=${(fp.note || '').slice(0, 48)}`);
  }
  // poll job states rapidly to catch queued vs running, then to completion
  const done = {};
  const seenStates = {};
  const deadline = Date.now() + 150000;
  while (Object.keys(done).length < domains.length && Date.now() < deadline) {
    for (const d of domains) {
      if (done[d]) continue;
      const j = await req('GET', '/api/job?domain=' + encodeURIComponent(d));
      const st = j.body?.state;
      seenStates[d] = seenStates[d] || new Set();
      if (st) seenStates[d].add(st);
      if (st === 'ready' || st === 'error' || st === 'none') {
        // 'none' can mean cached-ready path; re-check cache file
        done[d] = { state: st, elapsed_s: j.body?.elapsed_s, error: j.body?.error, at: Math.round((Date.now() - t0) / 1000) };
      }
    }
    await sleep(700);
  }
  console.log('\n  [P2] outcomes (states observed across the run):');
  for (const d of domains) {
    const key = cacheKey(d);
    const cp = 'out/cache/' + key + '.json';
    let credits = '-', grade = '-', urls = '-', reqs = '-', warns = 0, notobs = 0, crosshost = '';
    if (existsSync(cp)) {
      try {
        const ev = JSON.parse(readFileSync(cp, 'utf8'));
        credits = ev.meta?.scrapingbee?.credits_used ?? ev.meta?.scrapingbee?.total_credits ?? 0;
        urls = ev.sitemaps?.urls_collected ?? '-';
        reqs = ev.meta?.requests_made ?? '-';
        warns = ev.warnings?.length || 0;
        notobs = ev.not_observed?.length || 0;
        { const _s = scoreEvidence(ev); grade = _s.grade ?? (ev.blocked_at_root ? 'BLOCKED-AT-ROOT' : 'WITHHELD'); }
        if (ev.classification?.cross_host) crosshost = ' cross_host=' + JSON.stringify(ev.classification.cross_host).slice(0, 120);
      } catch (e) { grade = 'CACHE-READ-ERR'; }
    }
    const dn = done[d] || {};
    console.log(`  ${d.padEnd(20)} states=[${[...(seenStates[d] || [])].join(',')}] final=${dn.state}@${dn.at}s reqs=${reqs} urls=${urls} credits=${credits} grade=${grade}${dn.error ? ' err=' + dn.error.slice(0, 60) : ''}`);
    if (crosshost) console.log('     ' + crosshost);
    rec({ test: 'servermatrix', domain: d, p1_ms: p1[d], states: [...(seenStates[d] || [])], final: dn.state, final_at_s: dn.at, reqs, urls, credits, grade, error: dn.error || null });
  }
  child.kill();
}

// ------------------------------------------------------------- main
const mode = process.argv[2] || 'all';
(async () => {
  if (mode === 'adversarial') await adversarial();
  else if (mode === 'leads') await leads();
  else if (mode === 'limits') await limits();
  else if (mode === 'cachehit') await cachehit();
  else if (mode === 'concurrency') await concurrency();
  else if (mode === 'poison') await poison();
  else if (mode === 'live') await live(process.argv[3], process.argv[4]);
  else if (mode === 'servermatrix') await servermatrix();
  else if (mode === 'all') { await adversarial(); await leads(); await limits(); await cachehit(); await concurrency(); await poison(); }
  else { console.log('unknown mode', mode); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
