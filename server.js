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
import { renderReport, subScoreGrid, CSS, BRAND, HEAD_ICONS, LIVE_HREF } from './lib/report-html.js';
import { EvidenceCache, cacheKey, CACHE_TTL_MS } from './lib/cache.js';
import { ensureSeed } from './lib/seed.js';
import { RateLimiter } from './lib/ratelimit.js';
import { createLeadStore } from './lib/leads.js';
import { verifyTurnstile, turnstileOutcome } from './lib/turnstile.js';
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
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  // The secret is read from the MERGED env: loadEnv() returns an object and does
  // not populate process.env, so a .env-only key would never reach the verifier's
  // default. On Render the value is in process.env and both paths agree.
  const ts = await verifyTurnstile(body.turnstile_token, ip, { secret: env.TURNSTILE_SECRET_KEY });
  if (!ts.ok) {
    return json(res, 403, {
      error: ts.reason === 'missing-token'
        ? 'The anti-bot check did not finish, so nothing was sent to verify. Give it a moment and try again \u2014 or use the link below, which opens the report with no form at all.'
        : 'Cloudflare did not accept the anti-bot check. Try again, or use the link below, which opens the report with no form at all.',
      turnstile: ts.reason,
    });
  }
  // The teaser form collects first and last separately; the older single `name`
  // field still works, and `name` is always stored so downstream (sheet, email
  // merge) has one field to read whichever form the lead came from.
  const first = String(body.first_name || '').trim().slice(0, 100);
  const last = String(body.last_name || '').trim().slice(0, 100);
  const result = await leadStore.append({
    email,
    first_name: first || null,
    last_name: last || null,
    name: [first, last].filter(Boolean).join(' ') || String(body.name || '').slice(0, 200),
    company: String(body.company || '').slice(0, 200),
    domain: cacheKey(body.domain || ''),
    turnstile: turnstileOutcome(ts),
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
    return html(res, 404, `<!doctype html><meta charset="utf-8"><title>No report</title><style>${CSS}</style><main><h1>No report yet for ${host}</h1><p>Run a lookup from the <a href="${LIVE_HREF}">live tool</a> first.</p></main>`);
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

// ---------------------------------------------------------------- shared UI CSS
// The one stylesheet in lib/report-html.js still rules every surface; this is the
// interactive delta the two server-rendered pages (the live tool and the teaser)
// need on top of it — forms, buttons, the running state. Shared between them on
// purpose: a second copy is how a palette drifts.
const UI_CSS = `
form.lookup{display:flex;gap:.65rem;flex-wrap:wrap;margin:1.4rem 0}
input[type=text],input[type=email]{flex:1;min-width:220px;padding:13px 14px;font-size:16px;font-family:inherit;border:1px solid var(--line-strong);border-radius:var(--r-sm);background:var(--panel);color:var(--ink);box-shadow:var(--sh-xs)}
input::placeholder{color:var(--faint)}
input:focus-visible{outline:none;border-color:var(--accent);box-shadow:var(--ring)}
button,.btn{display:inline-block;padding:13px 22px;font-size:16px;font-family:inherit;border:0;border-radius:var(--r-sm);background:var(--accent);color:var(--accent-ink);cursor:pointer;font-weight:600;letter-spacing:-.01em;text-decoration:none;transition:background .12s}
button:hover,.btn:hover{background:var(--accent-deep);color:var(--accent-ink)}
button:disabled{opacity:.5;cursor:wait}
button:disabled:hover{background:var(--accent)}
#status{margin:.7rem 0;color:var(--muted);font-size:14px}
.lede{font-size:18.5px;line-height:1.55;color:var(--muted);max-width:56ch}
.hide{display:none}
/* The running state. Deliberately loud: the single most common moment on this page
   is waiting ~10 seconds for a full read, and the old 14px grey line under the form
   read as nothing happening. */
.runstate{background:var(--accent-soft);border:1px solid #c7cff7;border-radius:var(--r-lg);padding:1.15rem 1.35rem;margin:1.4rem 0;box-shadow:var(--sh-sm)}
.runline{display:flex;align-items:center;gap:.65rem;margin:0;font-size:24px;font-weight:700;letter-spacing:-.02em;line-height:1.2;color:var(--accent-deep)}
.runsub{margin:.4rem 0 0;font-size:14px;color:var(--muted)}
.spinner{width:19px;height:19px;flex:0 0 auto;border-radius:50%;border:2.5px solid var(--accent);border-right-color:transparent;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spinner{animation-duration:2.6s}}
/* Teaser gate form */
.fieldrow{display:flex;gap:.65rem;flex-wrap:wrap}
.field{display:block;flex:1;min-width:190px;margin:0 0 .7rem}
.field span{display:block;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 .3rem}
.field input{width:100%}
.gatehead{margin:.1rem 0 .5rem;font-size:22px}
/* NO RESERVED HEIGHT HERE — but be clear about what that does and does not buy,
   because the first version of this comment was wrong. Measured on the live page in
   a real browser: with this rule carrying no min-height, Cloudflare's own injected
   container still computes to ~70.7px even though it paints nothing (the widget is
   in MANAGED mode, which resolves silently for most visitors — zero iframes, a
   794-char token, blank on screen). No rule in this stylesheet matches that
   container and it has no inline style: THE FOOTPRINT IS CLOUDFLARE'S, NOT OURS,
   and it cannot be removed from here. What this rule does is stop US asserting a
   height we do not own. The .85rem matches the gap between the fields above it.
   🔴 data-appearance="interaction-only" DOES collapse it to 0 — and produces NO
   token, because it defers the challenge until an interaction. Tested on the live
   page: 0px and an empty response field after 11s, which would make the submit
   handler below refuse every visitor. Adopting it means moving to an explicit
   turnstile.execute() + callback flow first. Do not set it as a one-line tweak. */
.cf-turnstile{margin:0 0 .85rem}
/* This panel has one job — telling a visitor the gate is not real — and as a white
   card among white cards it read as one more paragraph. Amber ground, a 6px rule and
   a kicker at 15px make it the thing you see after the form. */
.demoout{background:var(--band-amber-bg);border:1px solid var(--band-amber-line);
  border-left:6px solid var(--band-amber);box-shadow:var(--sh-md)}
.demoout .kicker{color:var(--band-amber);font-size:15px;letter-spacing:.07em}
.demoout p{color:var(--ink)}
@media (max-width:620px){.runline{font-size:20px}}
`;

// ------------------------------------------------- Turnstile (client half)
// The SITE key is public by design — it is what a site key is for, and it only
// works on the hostnames configured at Cloudflare. The SECRET never appears here
// or anywhere else in a tracked file; it is read from the environment in
// handleLead. With no site key set, all three constants are inert and the gate
// behaves exactly as it did before this existed: soft, and honest about it.
const TURNSTILE_SITE_KEY = String(env.TURNSTILE_SITE_KEY || '').trim();
const TURNSTILE_WIDGET = TURNSTILE_SITE_KEY
  ? `<div class="cf-turnstile" data-sitekey="${esc(TURNSTILE_SITE_KEY)}" data-theme="light" data-action="lead-gate"></div>`
  : '';
const TURNSTILE_SCRIPT = TURNSTILE_SITE_KEY
  ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
  : '';
// The footer of this page claims there is no tracking on it. Loading Cloudflare's
// script makes that claim need a qualifier, exactly as a Google Fonts request would
// (see serveFont). Say what is actually requested rather than quietly leaving a
// sentence that has stopped being true.
const TURNSTILE_NOTE = TURNSTILE_SITE_KEY
  ? 'No analytics and no tracking on this page. The form loads one third-party script \u2014 Cloudflare Turnstile \u2014 which checks that a person is filling it in, and that is the only request on this page that leaves this origin. '
  : 'No tracking on this page. ';

// ---------------------------------------------------------------- landing page
function landingPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Advocacy Grade by justmesocial</title>
${HEAD_ICONS}
<style>${CSS}${UI_CSS}</style>
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
  <div id="running" class="runstate hide" role="status" aria-live="polite">
    <p class="runline"><span class="spinner" aria-hidden="true"></span><span id="runhead">Running the report now</span></p>
    <p class="runsub" id="runsub">The median site takes about 10 seconds; the largest in the corpus took 77.</p>
  </div>
  <p id="status" role="status"></p>
  <div id="fast"></div>

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
  // A lookup can be interrupted by things the browser cannot distinguish: a redeploy
  // draining the instance, a proxy error page where JSON was expected, a dropped
  // connection. All of them land in the same .catch, so the client counts failures
  // and says only what it actually knows rather than blaming the server.
  // Two counters, not one: pollFails counts DROPPED polls, noneTicks counts polls the
  // server answered with "I have no such job". Sharing a counter meant the success path
  // reset it every time and the second case could never trip.
  var pollFails = 0, noneTicks = 0, pollTicks = 0;
  var POLL_MS = 3000, POLL_GIVE_UP = Math.ceil(180000 / POLL_MS);
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
  function stopRunning() { $('running').classList.add('hide'); }
  // Every dead end goes through here. The button is re-enabled unconditionally —
  // a disabled submit with no way forward is the one state this page must never sit in.
  function fail(msg) {
    if (polling) { clearInterval(polling); polling = null; }
    stopRunning();
    $('go').disabled = false;
    $('status').textContent = msg;
  }
  function goToTeaser() {
    $('runhead').textContent = 'Report ready — opening it now';
    location.href = '/teaser/' + encodeURIComponent(domain);
  }
  var LOST = 'Lost contact with the server while the full read was running — it may have restarted. The run often finishes anyway: try the same domain again in a moment and a completed one comes straight back from the cache.';
  function poll() {
    if (++pollTicks > POLL_GIVE_UP) return fail('The full read has been going for three minutes without finishing. The quick findings above are still real. Try again later, or browse a pre-generated report.');
    fetch('/api/job?domain=' + encodeURIComponent(domain)).then(function (r) { return r.json(); }).then(function (j) {
      pollFails = 0;
      if (j.state !== 'none') noneTicks = 0;
      if (j.state === 'ready') {
        clearInterval(polling); polling = null;
        goToTeaser();
      } else if (j.state === 'error') {
        fail(j.error || 'The full read could not finish. The quick findings above are still real.');
      } else if (j.state === 'none') {
        // The server no longer knows about this job — it restarted, and its job map
        // went with it. Silently polling forever is what this used to do.
        if (++noneTicks >= 2) fail(LOST);
      } else if (j.note) { $('runsub').textContent = j.note; }
    }).catch(function () {
      if (++pollFails >= 5) fail(LOST);
    });
  }
  $('lookup').addEventListener('submit', function (e) {
    e.preventDefault();
    domain = $('domain').value.trim();
    $('go').disabled = true;
    $('runhead').textContent = 'Running the report now';
    $('runsub').textContent = 'Reading ' + domain + ' — the quick checks come back in about a second, the full read in about ten.';
    $('running').classList.remove('hide');
    $('status').textContent = '';
    $('fast').textContent = '';
    pollFails = 0; noneTicks = 0; pollTicks = 0;
    sendLookup(1);
  });

  // A lookup is retried ONCE, automatically, on a dropped or unparseable response —
  // which is exactly what a visitor gets if they submit while a deploy is swapping
  // instances. The retry is silent apart from the sub-line, because from the
  // visitor's side nothing has gone wrong yet.
  function sendLookup(attempt) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 40000);
    var opts = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: domain }) };
    if (ctl) opts.signal = ctl.signal;
    fetch('/api/lookup', opts)
      .then(function (r) { clearTimeout(timer); return r.json(); })
      .then(function (j) {
        $('go').disabled = false;
        if (j.error) { stopRunning(); $('status').textContent = j.error; return; }
        domain = j.domain;
        renderFindings((j.fast && j.fast.findings) || []);
        if (j.fast && j.fast.note) $('status').textContent = j.fast.note; else $('status').textContent = '';
        if (j.state === 'ready') { goToTeaser(); return; }
        if (j.state === 'running') {
          $('runsub').textContent = 'Quick checks done — the full read is running. Median 10 seconds; large sites up to a minute. This page moves on by itself.';
          polling = setInterval(poll, POLL_MS);
        } else {
          stopRunning();
          $('status').textContent = j.full_run_note || 'Showing the quick checks only.';
        }
      })
      .catch(function () {
        clearTimeout(timer);
        if (attempt < 2) {
          $('runsub').textContent = 'No answer yet — trying once more.';
          setTimeout(function () { sendLookup(attempt + 1); }, 1500);
          return;
        }
        // Deliberately does NOT claim a server-side fault: from here the only
        // observed fact is that no usable answer came back.
        fail('No answer came back from the server. If the site was mid-deploy it is usually back within a few seconds — try again. The pre-generated reports below work either way.');
      });
  }
})();
</script>
<noscript><p style="max-width:860px;margin:1rem auto;padding:0 1.25rem">This live checker needs JavaScript for the two-phase flow, but the <a href="/corpus/">${CORPUS_COUNT} pre-generated reports</a> work without it.</p></noscript>
</body>
</html>`;
}

// ---------------------------------------------------------------- teaser page
// Shown the moment a run finishes, at its own URL so it can be linked and shown.
//
// 🔴 HONESTY: every number on this page is the REAL scored value, rendered and then
// blurred in CSS. Nothing is substituted with a placeholder, so lifting the blur in
// devtools reveals the truth rather than a lie the page told. The gate is soft by
// design and says so: the escape-hatch button below hands over the full report with
// no email at all, because this is a demo and pretending otherwise would be the one
// dishonest thing on an otherwise honest site.
function teaserPage({ domain, scoring }) {
  const s = scoring;
  const graded = Boolean(s?.gradeable);
  const hero = graded
    ? `<p class="gradeletter g-${s.grade} score-num blurred">${esc(s.grade)}</p>
       <p class="overall"><span class="big score-num blurred">${esc(s.overall_score)}</span>/100 — <span class="tint">advocacy readiness</span></p>`
    : `<p class="withheld-mark blurred">No letter grade — withheld, not failed</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(domain)} — your Advocacy Grade is ready</title>
${HEAD_ICONS}
<style>${CSS}${UI_CSS}</style>
</head>
<body>
<main>
  ${BRAND}
  <h1>Your report for ${esc(domain)} <span class="tint">is ready</span></h1>
  <p class="sub">Read from public pages only, robots.txt honored on every request, every finding cited.</p>

  <div class="panel gradehero">
    ${hero}
    <p class="note">The grade and the four sub-scores are real and already computed — they are just blurred until you say who you are.</p>
  </div>

  ${subScoreGrid(s, { blurScores: true })}

  <div class="panel">
    <h2 class="gatehead">Show me the full report</h2>
    <p>Every finding, ranked by how fixable it is, with the evidence behind each one.</p>
    <form id="leadform">
      <div class="fieldrow">
        <label class="field"><span>First name</span><input type="text" id="first" name="first" autocomplete="given-name" required></label>
        <label class="field"><span>Last name</span><input type="text" id="last" name="last" autocomplete="family-name" required></label>
      </div>
      <label class="field"><span>Email address</span><input type="email" id="email" name="email" autocomplete="email" placeholder="you@yourcompany.com" required></label>
      ${TURNSTILE_WIDGET}
      <button type="submit" id="gogate">Show me the full report</button>
    </form>
    <p class="note" id="gatenote">One email with the report link. No sequence, no resale.</p>
  </div>

  <div class="honest demoout">
    <p class="kicker">This is a demo site</p>
    <p>If you don't care to see whether the form works, skip it. Nothing here is really locked — this is the same report the form would send you.</p>
    <p><a class="btn" href="/report/${encodeURIComponent(domain)}">View the full report now</a></p>
  </div>

  <footer>
    <p class="foot-brand">Advocacy Grade <span class="wm">by <span class="a">justme</span><span class="b">social</span></span>.</p>
    <p class="nav foot-nav"><a href="${LIVE_HREF}">&larr; Run a new report</a></p>
    <p>${TURNSTILE_NOTE}The grade above is computed from public evidence by a deterministic rubric — the same evidence always yields the same result.</p>
  </footer>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var url = '/report/' + ${JSON.stringify(encodeURIComponent(domain))};
  // Whether a Turnstile widget was rendered at all. With no site key configured
  // this is false and every line below that mentions the challenge is skipped.
  var gated = ${TURNSTILE_SITE_KEY ? 'true' : 'false'};
  // Cloudflare injects <input name="cf-turnstile-response"> into the enclosing
  // form once the challenge resolves. Absent or empty means it has not resolved.
  function tokenNow() {
    var el = document.querySelector('[name="cf-turnstile-response"]');
    return el ? el.value : '';
  }
  // A spent token cannot be reused, so every dead end resets the widget. Wrapped
  // because a throw in here would land in the fetch's .catch and be reported to
  // the visitor as a save failure — the exact costume the 2026-08-31 lookup bug wore.
  function resetChallenge() {
    if (!gated || !window.turnstile) return;
    try { window.turnstile.reset(); } catch (err) { /* nothing the visitor can act on */ }
  }
  function fail(msg) { $('gogate').disabled = false; $('gatenote').textContent = msg; resetChallenge(); }
  $('leadform').addEventListener('submit', function (e) {
    e.preventDefault();
    var token = gated ? tokenNow() : '';
    if (gated && !token) {
      // Say what is actually true: the check has not finished. Do not send a
      // request that we already know the server will refuse.
      fail('The anti-bot check has not finished yet — give it a second and press the button again. The link below opens the report with no form at all.');
      return;
    }
    $('gogate').disabled = true;
    fetch('/api/lead', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ first_name: $('first').value, last_name: $('last').value, email: $('email').value, domain: ${JSON.stringify(domain)}, turnstile_token: token })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.ok) { location.href = url; }
        else { fail(j.error || 'Could not save that — try again?'); }
      })
      .catch(function () { fail('Something went wrong saving that. The button below still opens the report.'); });
  });
})();
</script>
${TURNSTILE_SCRIPT}
<noscript><p style="max-width:860px;margin:1rem auto;padding:0 1.25rem">The form needs JavaScript, but <a href="/report/${encodeURIComponent(domain)}">the full report</a> does not.</p></noscript>
</body>
</html>`;
}

async function handleTeaser(req, res, host) {
  host = cacheKey(host);
  const cached = cache.get(host);
  // No evidence, no teaser — never a page implying a run that did not happen.
  if (!cached) { res.writeHead(302, { location: LIVE_HREF }); return res.end(); }
  return html(res, 200, teaserPage({ domain: host, scoring: scoreEvidence(cached.evidence) }));
}

// ---------------------------------------------------------------- server
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // The live tool lives at /es-demo so that / is free for an unrelated
    // Greg-O-Matic landing page later. 302 and NOT 301 on purpose: a permanent
    // redirect would be cached in every visitor's browser and would still be
    // firing after / becomes a different page.
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(302, { location: LIVE_HREF }); return res.end(); }
    if (req.method === 'GET' && (url.pathname === LIVE_HREF || url.pathname === LIVE_HREF + '/')) return html(res, 200, landingPage());
    if (req.method === 'POST' && url.pathname === '/api/lookup') return await handleLookup(req, res);
    if (req.method === 'GET' && url.pathname === '/api/job') return handleJob(req, res, url);
    if (req.method === 'POST' && url.pathname === '/api/lead') return await handleLead(req, res);
    if (req.method === 'GET' && url.pathname.startsWith('/report/')) return await handleReport(req, res, decodeURIComponent(url.pathname.slice(8)));
    if (req.method === 'GET' && url.pathname.startsWith('/teaser/')) return await handleTeaser(req, res, decodeURIComponent(url.pathname.slice(8)));
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
