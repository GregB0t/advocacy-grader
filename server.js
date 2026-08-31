#!/usr/bin/env node
// Live lookup server — two-phase, latency-aware, no dependencies.
//
// The latency numbers this is designed around (measured across all 350
// calibration domains, not guessed):
//   FAST tier (robots + llms + homepage)  median 721ms · p90 1.9s · p99 15s
//   FULL run                              median 10.3s · p90 37.6s · max 77s
//   (only 24.6% of full runs finish under 5s; 64.6% under 15s)
//
// So the flow is: Phase 1 answers the submit with real fast-tier findings
// inside a hard 15s cap (degrading to a waiting state, never hanging), while
// Phase 2 — sitemaps, classification, page sampling — continues in the
// background behind the email gate. A 30-day evidence cache (seeded by the
// 350-domain corpus) makes repeat lookups instant, and scoring always
// re-applies the live rubric at read time.
//
// Works today with zero external services: no API key (narrative layer
// degrades to deterministic prose), no Turnstile secret (challenge skipped,
// stated in the result), no Sheet (leads land in out/leads.jsonl).
import { createServer } from 'node:http';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize, basename } from 'node:path';
import { run, fastProbe, normalizeDomain, DEFAULT_OPTS } from './lib/run.js';
import { scoreEvidence } from './lib/rubric.js';
import { buildFindings, fastTier } from './lib/findings.js';
import { narrateFindings } from './lib/narrate.js';
import { renderReport, CSS, BRAND, HEAD_ICONS } from './lib/report-html.js';
import { EvidenceCache, cacheKey, CACHE_TTL_MS } from './lib/cache.js';
import { ensureSeed } from './lib/seed.js';
import { RateLimiter } from './lib/ratelimit.js';
import { createLeadStore } from './lib/leads.js';
import { verifyTurnstile } from './lib/turnstile.js';
import { loadEnv } from './lib/scrapingbee.js';
import { hostPreCheck } from './lib/ssrf.js';

const env = { ...loadEnv(new URL('./.env', import.meta.url).pathname), ...process.env };
const PORT = Number(env.PORT || 8787);
const FAST_CAP_MS = 15000;   // p99 of the measured fast tier
const FULL_CAP_MS = 150000;  // max observed full run was 77s; double it, then say so honestly

// out/ is gitignored, so a git deploy lands with an empty cache. Unpack the
// shipped corpus before the cache is read, so the very first lookup of a
// corpus domain is instant on a brand-new instance.
ensureSeed();
const cache = new EvidenceCache({});
// Every user-visible mention of the cache window derives from CACHE_TTL_MS so the
// page can never claim a TTL the code does not actually enforce.
const CACHE_TTL_DAYS = Math.round(CACHE_TTL_MS / 86400000);
// Corpus figures are DERIVED, never written down. A hardcoded count goes stale
// the moment the corpus changes, and a stale number about this tool's own
// coverage is exactly the class of false claim the report promises not to make.
// CORPUS_COUNT = what is actually published (the committed site/reports tree).
const CORPUS_COUNT = (() => {
  try { return readdirSync(join('site', 'reports')).filter((f) => f.endsWith('.html')).length; }
  catch { return 0; }
})();
// CORPUS_STATS = coverage, scored at boot with the LIVE rubric over the evidence
// corpus (never read out of a stale `scoring` block). Measured at 0.39s across
// the full corpus, so this is invisible at startup. null when the corpus is absent —
// and null means the "for scale" sentence is omitted, never filled with a guess.
const CORPUS_STATS = (() => {
  try {
    const dir = join('out', 'calib');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (!files.length) return null;
    let graded = 0;
    for (const f of files) {
      if (scoreEvidence(JSON.parse(readFileSync(join(dir, f), 'utf8'))).gradeable) graded++;
    }
    return { total: files.length, graded, withheld: files.length - graded };
  } catch { return null; }
})();
const leadStore = createLeadStore(env);
const fastLimit = new RateLimiter({ windowMs: 3600e3, max: 30 });
const fullLimit = new RateLimiter({ windowMs: 3600e3, max: 10 });
const leadLimit = new RateLimiter({ windowMs: 3600e3, max: 20 });

// ---------------------------------------------------------------- jobs
const jobs = new Map(); // host -> { state: 'running'|'ready'|'error', started_at, error }
let running = 0;
const queue = [];
const MAX_CONCURRENT = 2;

function startFullRun(host) {
  if (jobs.get(host)?.state === 'running' || cache.get(host)) return;
  jobs.set(host, { state: 'queued', started_at: Date.now() });
  queue.push(host);
  pump();
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const host = queue.shift();
    running++;
    const job = jobs.get(host);
    job.state = 'running';
    const work = run({ ...DEFAULT_OPTS, domain: host })
      .then((evidence) => { cache.put(host, evidence); job.state = 'ready'; })
      .catch((err) => { job.state = 'error'; job.error = String(err.message || err); });
    const watchdog = new Promise((r) => setTimeout(r, FULL_CAP_MS)).then(() => {
      if (job.state === 'running') { job.state = 'error'; job.error = `The full read did not finish within ${FULL_CAP_MS / 1000}s. Large or slow sites can exceed this tool's patience budget; the fast-tier findings above are still real.`; }
    });
    Promise.race([work, watchdog]).finally(() => { running--; pump(); });
  }
}

// ---------------------------------------------------------------- helpers
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const html = (res, code, body) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

function readBody(req, cap = 16384) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > cap) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

const findingsForClient = (list) => list.map((f) => ({ severity: f.severity, title: f.title, statement: f.narrative || f.statement, fix: f.narrative_fix || f.fix, evidence_source: f.evidence?.source ?? null }));

// ---------------------------------------------------------------- routes
async function handleLookup(req, res) {
  const ip = clientIp(req);
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
  const norm = normalizeDomain(body.domain);
  if (!norm) return json(res, 400, { error: `Could not parse "${body.domain}" as a domain.` });
  const pc = hostPreCheck(norm.host);
  if (pc.blocked) return json(res, 400, { error: `Only public websites can be graded: ${pc.reason}.` });
  const host = cacheKey(norm.host);

  const cached = cache.get(host);
  if (cached) {
    const scoring = scoreEvidence(cached.evidence);
    const f = buildFindings(cached.evidence, scoring);
    return json(res, 200, {
      state: 'ready', domain: host, cached: true, cached_at: cached.cached_at,
      report_url: `/report/${host}`,
      fast: { findings: findingsForClient([...f.actions, ...f.positives].slice(0, 3)) },
    });
  }

  const rl = fastLimit.check(ip);
  if (!rl.allowed) return json(res, 429, { error: 'Rate limit reached for lookups from this address.', retry_after_s: rl.retry_after_s });

  const frl = fullLimit.check(ip);
  if (frl.allowed) startFullRun(host);

  // Phase 1: fast probe with a hard cap. Degrade to a waiting state, never hang.
  let fast = null, capped = false;
  try {
    fast = await Promise.race([
      fastProbe(host, { timeoutMs: 6000 }),
      new Promise((r) => setTimeout(() => r(null), FAST_CAP_MS)),
    ]);
    if (!fast) capped = true;
  } catch { capped = true; }

  let fastPayload;
  if (fast && !fast.error) {
    const f = fastTier(buildFindings(fast, null));
    fastPayload = {
      findings: findingsForClient([...f.actions, ...f.limitations, ...f.positives, ...f.info].slice(0, 3)),
      elapsed_ms: fast.meta?.elapsed_ms,
      blocked_at_root: Boolean(fast.blocked_at_root),
    };
  } else {
    fastPayload = { findings: [], note: capped ? 'Your site is answering slowly; the quick checks did not finish in 15 seconds. The full read is still running in the background.' : (fast?.error || 'The quick checks could not reach the site; the full read may still succeed.') };
  }

  return json(res, 200, {
    state: frl.allowed ? 'running' : 'fast-only',
    domain: host,
    report_url: `/report/${host}`,
    full_run_note: frl.allowed ? null : 'Full-run rate limit reached for this address; showing quick checks only.',
    fast: fastPayload,
  });
}

function handleJob(req, res, url) {
  const host = cacheKey(url.searchParams.get('domain') || '');
  if (!host) return json(res, 400, { error: 'missing domain' });
  if (cache.get(host)) return json(res, 200, { state: 'ready', report_url: `/report/${host}` });
  const job = jobs.get(host);
  if (!job) return json(res, 200, { state: 'none' });
  const elapsed = Math.round((Date.now() - job.started_at) / 1000);
  return json(res, 200, { state: job.state, elapsed_s: elapsed, error: job.error || null,
    note: job.state === 'running' && elapsed > 20 ? 'Still reading — the median site takes 10 seconds, but large sites have taken up to 77. It keeps at it for 150 before giving up honestly.' : null });
}

async function handleLead(req, res) {
  const ip = clientIp(req);
  const rl = leadLimit.check(ip);
  if (!rl.allowed) return json(res, 429, { error: 'rate limited', retry_after_s: rl.retry_after_s });
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
  const email = String(body.email || '').trim().slice(0, 200);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'a valid email is required' });
  const ts = await verifyTurnstile(body.turnstile_token, ip);
  if (!ts.ok) return json(res, 403, { error: 'challenge failed' });
  const result = await leadStore.append({
    email,
    name: String(body.name || '').slice(0, 200),
    company: String(body.company || '').slice(0, 200),
    domain: cacheKey(body.domain || ''),
    turnstile: ts.skipped ? 'not-enforced' : 'passed',
    ip,
  });
  return json(res, 200, { ok: result.ok });
}

async function handleReport(req, res, host) {
  host = cacheKey(host);
  const cached = cache.get(host);
  if (!cached) {
    // fall back to a pre-built corpus page if one exists
    const p = join('site', 'reports', host + '.html');
    if (existsSync(p)) return html(res, 200, readFileSync(p, 'utf8'));
    return html(res, 404, `<!doctype html><meta charset="utf-8"><title>No report</title><style>${CSS}</style><main><h1>No report yet for ${host}</h1><p>Run a lookup from the <a href="/">front page</a> first.</p></main>`);
  }
  const scoring = scoreEvidence(cached.evidence); // live rubric, never the stored block
  let findings = buildFindings(cached.evidence, scoring);
  findings = await narrateFindings(findings, { domain: host }); // no-op without ANTHROPIC_API_KEY
  const preGenerated = cached.source.includes('calib');
  return html(res, 200, renderReport({ domain: host, ev: cached.evidence, scoring, findings, preGenerated, backHref: '/corpus/', corpusStats: CORPUS_STATS }));
}

// Fonts are vendored under site/fonts/ and served from this origin on purpose:
// the footer claims these pages hold no tracking, and a Google Fonts request
// would quietly make that false. Immutable caching — the filenames are pinned.
function serveFont(res, urlPath) {
  const name = basename(urlPath);
  if (!/^[A-Za-z0-9._-]+\.woff2$/.test(name)) return html(res, 404, 'not found');
  const p = join('site', 'fonts', name);
  if (!existsSync(p) || !statSync(p).isFile()) return html(res, 404, 'not found');
  res.writeHead(200, {
    'content-type': 'font/woff2',
    'cache-control': 'public, max-age=31536000, immutable',
    'access-control-allow-origin': '*',
  });
  return res.end(readFileSync(p));
}

function serveStatic(req, res, urlPath) {
  const rel = normalize(urlPath.replace(/^\/corpus\/?/, '')).replace(/^([.][.][/\\])+/, '');
  const p = join('site', !rel || rel === '.' ? 'index.html' : rel);
  if (!p.startsWith('site') || !existsSync(p) || !statSync(p).isFile()) return html(res, 404, 'not found');
  return html(res, 200, readFileSync(p, 'utf8'));
}

// Icons and logo files live at the origin root so one set of <link> tags works
// from /, /corpus/ and /corpus/reports/ alike. Explicit allowlist rather than a
// directory server: site/ also holds 350 report pages and the font files, which
// are already routed, and nothing else here should be reachable by guessing.
const ASSETS = {
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/favicon.ico': ['favicon.ico', 'image/x-icon'],
  '/favicon-16.png': ['favicon-16.png', 'image/png'],
  '/favicon-32.png': ['favicon-32.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/logo.svg': ['logo.svg', 'image/svg+xml'],
  '/logo-mark.svg': ['logo-mark.svg', 'image/svg+xml'],
  '/logo-stacked.svg': ['logo-stacked.svg', 'image/svg+xml'],
  '/logo-reversed.svg': ['logo-reversed.svg', 'image/svg+xml'],
};
function serveAsset(res, urlPath) {
  const [name, type] = ASSETS[urlPath];
  const p = join('site', name);
  if (!existsSync(p) || !statSync(p).isFile()) return html(res, 404, 'not found');
  res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400' });
  return res.end(readFileSync(p));
}

// ---------------------------------------------------------------- landing page
function landingPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Advocacy Grade by justmesocial</title>
${HEAD_ICONS}
<style>${CSS}
form.lookup{display:flex;gap:.65rem;flex-wrap:wrap;margin:1.4rem 0}
input[type=text],input[type=email]{flex:1;min-width:220px;padding:13px 14px;font-size:16px;font-family:inherit;border:1px solid var(--line-strong);border-radius:var(--r-sm);background:var(--panel);color:var(--ink);box-shadow:var(--sh-xs)}
input::placeholder{color:var(--faint)}
input:focus-visible{outline:none;border-color:var(--accent);box-shadow:var(--ring)}
button{padding:13px 22px;font-size:16px;font-family:inherit;border:0;border-radius:var(--r-sm);background:var(--accent);color:var(--accent-ink);cursor:pointer;font-weight:600;letter-spacing:-.01em;transition:background .12s}
button:hover{background:var(--accent-deep)}
button:disabled{opacity:.5;cursor:wait}
button:disabled:hover{background:var(--accent)}
#status{margin:.7rem 0;color:var(--muted);font-size:14px}
.lede{font-size:18.5px;line-height:1.55;color:var(--muted);max-width:56ch}
.hide{display:none}
</style>
</head>
<body>
<main>
  ${BRAND}
  <h1>What does your website <span class="tint">hand your employees to share?</span></h1>
  <p class="lede">Enter your company's domain. This reads only public pages — sitemap, share tags, structured data, robots.txt — politely and honestly, and shows you what it finds, with the evidence cited. The first findings appear in seconds, free.</p>

  <form class="lookup" id="lookup">
    <input type="text" id="domain" name="domain" placeholder="yourcompany.com" autocomplete="off" required>
    <button id="go" type="submit">Check my site</button>
  </form>
  <p id="status" role="status"></p>
  <div id="fast"></div>

  <div id="gate" class="panel hide">
    <p><b>The full report is being prepared</b> — content supply, shareability page-by-page, culture surface, AI discoverability, each finding cited and ranked by fixability. Leave an email and it's yours when it's done (usually under a minute).</p>
    <form id="leadform">
      <input type="email" id="email" placeholder="you@yourcompany.com" required style="width:100%;max-width:340px">
      <button type="submit" style="margin-top:.5rem">Send me the report</button>
    </form>
    <p class="note">One email with the report link. No sequence, no resale.</p>
  </div>
  <div id="ready" class="hide panel"></div>

  <div class="honest">
    <p class="kicker">Straight talk, before you type anything</p>
    <p>I built this tool in a few days, on a stack of assumptions — without the inside knowledge to be sure these are the exact metrics that matter for employee advocacy. The four categories and their weights are editorial judgment; nobody has proven they cause employees to post.</p>
    <p>I chose to strictly adhere to LinkedIn's Terms of Service, so no direct or indirect scraping of LinkedIn went into any of these results. The only LinkedIn signal I read is whether your own pages carry a LinkedIn share link — that's your HTML, not theirs.</p>
    <p>To prioritize report generation speed, reports are cached for ${CACHE_TTL_DAYS} days. There are currently ${CORPUS_COUNT} pre-generated reports cached — <a href="/corpus/">you can view those reports here</a>.</p>
    <p>What you can hold me to: every claim cites its public evidence, robots.txt is honored on every request, and when this tool can't read a site it says so instead of inventing a grade.</p>
  </div>

  <p>Browse the <a href="/corpus/">${CORPUS_COUNT} pre-generated company reports</a> to see what one looks like.</p>

  <footer><p>No tracking on this page. Lookups are rate-limited per address; results are cached for ${CACHE_TTL_DAYS} days.</p></footer>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var domain = null, polling = null;
  var sev = { critical: 'Broken', issue: 'Issue', opportunity: 'Opportunity', positive: 'Working', limitation: 'Not visible', info: 'Note' };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }
  function renderFindings(list) {
    var box = $('fast'); box.textContent = '';
    list.forEach(function (f) {
      var d = el('div', 'finding f-' + f.severity);
      d.appendChild(el('span', 'chip c-' + f.severity, sev[f.severity] || f.severity));
      d.appendChild(el('h3', null, f.title));
      d.appendChild(el('p', null, f.statement));
      if (f.fix) { var p = el('p', 'fix'); var b = el('b', null, 'The fix: '); p.appendChild(b); p.appendChild(document.createTextNode(f.fix)); d.appendChild(p); }
      box.appendChild(d);
    });
  }
  function poll() {
    fetch('/api/job?domain=' + encodeURIComponent(domain)).then(function (r) { return r.json(); }).then(function (j) {
      if (j.state === 'ready') {
        clearInterval(polling);
        $('status').textContent = 'Full report ready.';
        showReady();
      } else if (j.state === 'error') {
        clearInterval(polling);
        $('status').textContent = j.error || 'The full read could not finish. The quick findings above are still real.';
      } else if (j.note) { $('status').textContent = j.note; }
    }).catch(function () {});
  }
  function showReady() {
    var r = $('ready'); r.classList.remove('hide'); r.textContent = '';
    var a = el('a', null, 'View the full report for ' + domain);
    a.href = '/report/' + domain;
    r.appendChild(a);
  }
  $('lookup').addEventListener('submit', function (e) {
    e.preventDefault();
    domain = $('domain').value.trim();
    $('go').disabled = true;
    $('status').textContent = 'Running the quick checks (usually about a second)…';
    $('fast').textContent = ''; $('ready').classList.add('hide');
    fetch('/api/lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: domain }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        $('go').disabled = false;
        if (j.error) { $('status').textContent = j.error; return; }
        domain = j.domain;
        renderFindings((j.fast && j.fast.findings) || []);
        if (j.fast && j.fast.note) $('status').textContent = j.fast.note; else $('status').textContent = '';
        if (j.state === 'ready') { $('status').textContent = 'Report ready' + (j.cached ? ' (from the ${CACHE_TTL_DAYS}-day cache)' : '') + '.'; showReady(); }
        else { $('gate').classList.remove('hide'); if (j.state === 'running') { $('status').textContent = 'Quick checks done. The full read is running — median 10 seconds, large sites up to a minute.'; polling = setInterval(poll, 3000); } }
      })
      .catch(function () { $('go').disabled = false; $('status').textContent = 'Something went wrong on the server side. Try again in a moment.'; });
  });
  $('leadform').addEventListener('submit', function (e) {
    e.preventDefault();
    fetch('/api/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('email').value, domain: domain }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.ok) { $('gate').innerHTML = '<p>Thanks — the report link will be waiting here, and I saved your address for exactly one email.</p>'; }
        else { $('status').textContent = j.error || 'Could not save that — try again?'; }
      });
  });
})();
</script>
<noscript><p style="max-width:860px;margin:1rem auto;padding:0 1.25rem">This live checker needs JavaScript for the two-phase flow, but the <a href="/corpus/">${CORPUS_COUNT} pre-generated reports</a> work without it.</p></noscript>
</body>
</html>`;
}

// ---------------------------------------------------------------- server
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') return html(res, 200, landingPage());
    if (req.method === 'POST' && url.pathname === '/api/lookup') return await handleLookup(req, res);
    if (req.method === 'GET' && url.pathname === '/api/job') return handleJob(req, res, url);
    if (req.method === 'POST' && url.pathname === '/api/lead') return await handleLead(req, res);
    if (req.method === 'GET' && url.pathname.startsWith('/report/')) return await handleReport(req, res, decodeURIComponent(url.pathname.slice(8)));
    if (req.method === 'GET' && url.pathname.startsWith('/fonts/')) return serveFont(res, url.pathname);
    if (req.method === 'GET' && ASSETS[url.pathname]) return serveAsset(res, url.pathname);
    if (req.method === 'GET' && (url.pathname === '/corpus' || url.pathname.startsWith('/corpus/'))) return serveStatic(req, res, url.pathname);
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });
    return html(res, 404, 'not found');
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, () => console.log(`advocacy-grader server on http://localhost:${PORT}  (fast cap ${FAST_CAP_MS}ms, full cap ${FULL_CAP_MS / 1000}s, cache ${cache.dir})`));
