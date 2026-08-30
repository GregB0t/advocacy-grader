#!/usr/bin/env node
// Resumable batch pre-warmer for the evidence cache.
//
// WHY THIS EXISTS
// The TTL is evaluated at READ time against meta.started_at, so evidence
// collected tonight is warm for the full TTL window from the moment it was
// fetched. Pre-warming a large domain list ahead of launch is therefore never
// wasted work — it converts a 10-77s cold live run into a ~20ms cache hit for
// every domain a visitor is likely to type.
//
// RUN IT FROM YOUR OWN TERMINAL, NOT FROM A COWORK SHELL.
// The Cowork device shell is started with --die-with-parent: it kills
// backgrounded children when the call returns, so nohup does not survive there.
// This script is built to be interrupted and re-run instead: every domain is
// checkpointed to disk the moment it completes, and a re-run skips everything
// already fresh. Run it until it prints DONE.
//
//   node tools/prewarm.js domains.txt
//   node tools/prewarm.js domains.txt --concurrency 16 --out out/calib
//   node tools/prewarm.js domains.txt --minutes 45      # stop cleanly, then re-run
//
// CONCURRENCY IS A CORRECTNESS SETTING, NOT A SPEED SETTING.
// Past ~18 simultaneous outbound requests, healthy hosts time out and get
// recorded as "no site" — a fabricated finding, which spec §7 forbids. The
// number that matters is total in-flight sockets, which is (domains in
// parallel) x (page fetches per domain), so this script sets a GLOBAL cap in
// lib/http.js rather than trusting either loop on its own. Values above 18 are
// refused.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run, normalizeDomain, stripDerived, DEFAULT_OPTS } from '../lib/run.js';
import { EvidenceCache, cacheKey } from '../lib/cache.js';
import { setGlobalConcurrency } from '../lib/http.js';

const MAX_SAFE_CONCURRENCY = 18;

function parseArgs(argv) {
  const o = {
    file: null,
    outDir: 'out/calib',
    concurrency: 16,
    minutes: 0,             // 0 = no time budget
    timeout: DEFAULT_OPTS.timeout,
    sample: DEFAULT_OPTS.sample,
    maxCredits: DEFAULT_OPTS.maxCredits,
    pages: true,
    ats: true,
    force: false,
    retryFailed: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--concurrency' || a === '-c') o.concurrency = Number(argv[++i]);
    else if (a === '--out') o.outDir = argv[++i];
    else if (a === '--minutes') o.minutes = Number(argv[++i]);
    else if (a === '--timeout') o.timeout = Number(argv[++i]);
    else if (a === '--sample') o.sample = Number(argv[++i]);
    else if (a === '--max-credits') o.maxCredits = Number(argv[++i]);
    else if (a === '--no-pages') o.pages = false;
    else if (a === '--no-ats') o.ats = false;
    else if (a === '--force') o.force = true;
    else if (a === '--retry-failed') o.retryFailed = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (!a.startsWith('-')) o.file = a;
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.file) {
  console.error(`Usage: node tools/prewarm.js <domains.txt> [options]

  <domains.txt>        one domain per line; blank lines and # comments ignored
  --concurrency N      domains in parallel (default 16, hard max ${MAX_SAFE_CONCURRENCY})
  --out DIR            evidence directory (default out/calib)
  --minutes N          stop cleanly after N minutes; re-run to continue
  --force              refetch even domains that are already cached and fresh
  --retry-failed       also refetch domains whose cached evidence resolved no origin
  --dry-run            report what would be fetched, fetch nothing
  --timeout MS         per-request timeout (default ${DEFAULT_OPTS.timeout})
  --sample N           pages sampled per domain (default ${DEFAULT_OPTS.sample})
  --no-pages --no-ats  skip page sampling / careers discovery

Resumable: re-run until it prints DONE.`);
  process.exit(2);
}
if (!existsSync(opts.file)) {
  console.error(`prewarm: domain file not found: ${opts.file}`);
  process.exit(2);
}
if (!Number.isFinite(opts.concurrency) || opts.concurrency < 1) {
  console.error('prewarm: --concurrency must be a positive integer.');
  process.exit(2);
}
if (opts.concurrency > MAX_SAFE_CONCURRENCY) {
  console.error(`prewarm: refusing --concurrency ${opts.concurrency}.`);
  console.error(`Above ~${MAX_SAFE_CONCURRENCY} simultaneous requests, healthy hosts time out and are recorded as`);
  console.error('"no site" — that is a fabricated finding, not a slow one. Use 15-18.');
  process.exit(2);
}

mkdirSync(opts.outDir, { recursive: true });
const logPath = join(opts.outDir, '..', 'prewarm.log');

// Read the domain list, normalize, and de-duplicate on the same key the cache
// uses — so "www.acme.com", "acme.com" and "https://acme.com/x" are one job.
const raw = readFileSync(opts.file, 'utf8').split(/\r?\n/);
const seen = new Map();
const unparseable = [];
for (const line of raw) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const norm = normalizeDomain(t);
  if (!norm || !norm.host || !norm.host.includes('.')) { unparseable.push(t); continue; }
  const key = cacheKey(norm.host);
  if (!seen.has(key)) seen.set(key, norm.host);
}
const domains = [...seen.values()];

// Resume: a domain is done if the server would get a cache hit for it.
//
// That last clause is the whole subtlety. EvidenceCache gives a SHORT
// (1-hour) TTL to failure envelopes it finds in its own writable dir, so a
// temporarily-down site self-heals, but the full TTL to anything in a seed
// dir. The server reads this directory as a SEED dir, so freshness here is
// measured the same way — by passing outDir as the seed. Measuring it the
// other way makes every permanently-unreachable domain look stale on every
// pass, and the runner never converges on DONE.
//
// The cost of that choice is that a domain which genuinely failed stays
// failed for the full TTL. --retry-failed re-attempts exactly those.
// The scratch dir is only there because EvidenceCache needs a writable dir;
// nothing is ever written to it. It lives outside outDir so it can never end
// up inside the shipped seed tarball.
const SCRATCH = join(tmpdir(), 'advocacy-grader-prewarm-scratch');
const cache = new EvidenceCache({ dir: SCRATCH, seedDirs: [opts.outDir] });
const todo = [];
const already = [];
let cachedFailures = 0;
for (const host of domains) {
  const hit = opts.force ? null : cache.get(host);
  const isFailure = hit && !hit.evidence?.meta?.resolved_origin && !hit.evidence?.blocked_at_root;
  if (hit && isFailure) cachedFailures++;
  if (hit && !(isFailure && opts.retryFailed)) already.push(host);
  else todo.push(host);
}

console.log(`prewarm: ${domains.length} unique domains from ${opts.file}` +
  (unparseable.length ? ` (${unparseable.length} unparseable lines skipped)` : ''));
console.log(`prewarm: ${already.length} already cached and fresh, ${todo.length} to fetch`);
if (cachedFailures) {
  console.log(`prewarm: ${cachedFailures} of the cached entries resolved NO ORIGIN — they are stored as` +
    ` failures, not as findings.${opts.retryFailed ? ' Retrying them (--retry-failed).' : ' Use --retry-failed to re-attempt them.'}`);
}
if (unparseable.length) console.log(`prewarm: skipped -> ${unparseable.slice(0, 5).join(', ')}${unparseable.length > 5 ? ' …' : ''}`);

if (opts.dryRun) {
  console.log(`prewarm: dry run, nothing fetched. ${todo.length} would be fetched.`);
  console.log(todo.length === 0 ? 'DONE' : 'NOT DONE — re-run without --dry-run');
  process.exit(0);
}
if (todo.length === 0) {
  console.log('prewarm: nothing to do — every domain is cached and fresh.');
  console.log('DONE');
  process.exit(0);
}

// The global cap counts real sockets, so per-domain page fetching is set to 1
// and the parallelism lives in the domain loop. domains x 1 = the cap.
const GLOBAL_CAP = opts.concurrency;
setGlobalConcurrency(GLOBAL_CAP);
console.log(`prewarm: global HTTP cap ${GLOBAL_CAP} in-flight (${opts.concurrency} domains x 1 request each)`);
if (opts.minutes) console.log(`prewarm: time budget ${opts.minutes} min — will stop cleanly and can be re-run`);

const deadline = opts.minutes ? Date.now() + opts.minutes * 60000 : Infinity;
let stopping = false;
const onSignal = (sig) => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log(`\nprewarm: ${sig} received — finishing in-flight domains, then stopping. Re-run to continue.`);
};
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

let done = 0, ok = 0, failed = 0, skippedForTime = 0;
const started = Date.now();
const failures = [];

async function fetchOne(host) {
  const t0 = Date.now();
  const dest = join(opts.outDir, cacheKey(host) + '.json');
  try {
    const evidence = await run({
      ...DEFAULT_OPTS,
      domain: host,
      quiet: true,
      concurrency: 1,          // parallelism belongs to the domain loop; see GLOBAL_CAP
      timeout: opts.timeout,
      sample: opts.sample,
      maxCredits: opts.maxCredits,
      pages: opts.pages,
      ats: opts.ats,
    });
    // Written through stripDerived like every other cache write: evidence is
    // stored, scores never are. A stored scoring block has caused false claims
    // in this project before.
    const tmp = dest + '.tmp';
    writeFileSync(tmp, JSON.stringify(stripDerived(evidence)));
    // Rename is atomic on the same filesystem, so an interrupted run can never
    // leave a half-written evidence file that a later run would trust as fresh.
    const { renameSync } = await import('node:fs');
    renameSync(tmp, dest);
    ok++;
    return { host, ok: true, ms: Date.now() - t0, origin: evidence?.meta?.resolved_origin || null };
  } catch (err) {
    failed++;
    failures.push({ host, error: String(err.message || err) });
    return { host, ok: false, ms: Date.now() - t0, error: String(err.message || err) };
  }
}

async function main() {
  let next = 0;
  const workers = Array.from({ length: Math.min(opts.concurrency, todo.length) }, async () => {
    while (true) {
      if (stopping || Date.now() > deadline) { skippedForTime += todo.length - next; next = todo.length; return; }
      const i = next++;
      if (i >= todo.length) return;
      const host = todo[i];
      const r = await fetchOne(host);
      done++;
      const rate = done / ((Date.now() - started) / 1000);
      const remaining = todo.length - done;
      const eta = rate > 0 ? Math.round(remaining / rate) : 0;
      const status = r.ok ? (r.origin ? 'ok' : 'ok (no origin resolved)') : `FAILED ${r.error}`;
      console.log(`[${String(done).padStart(4)}/${todo.length}] ${host.padEnd(34)} ${String(r.ms + 'ms').padStart(8)}  ${status}   eta ${Math.floor(eta / 60)}m${eta % 60}s`);
      try {
        appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...r }) + '\n');
      } catch { /* logging is best-effort */ }
    }
  });
  await Promise.all(workers);
}

await main();

const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(`\nprewarm: ${done} attempted in ${mins} min — ${ok} written, ${failed} failed` +
  (skippedForTime ? `, ${skippedForTime} not reached (stopped early)` : ''));
if (failures.length) {
  console.log('prewarm: failures (these are recorded as failures, NOT as findings):');
  for (const f of failures.slice(0, 20)) console.log(`  ${f.host}: ${f.error}`);
  if (failures.length > 20) console.log(`  … and ${failures.length - 20} more (see ${logPath})`);
}

// Re-check against the cache rather than trusting the counters above: DONE
// means the cache actually satisfies every domain in the list.
const recheck = new EvidenceCache({ dir: SCRATCH, seedDirs: [opts.outDir] });
const stillMissing = domains.filter((h) => !recheck.get(h));
console.log(`prewarm: ${domains.length - stillMissing.length}/${domains.length} domains now cached and fresh.`);
if (stillMissing.length === 0) {
  console.log('DONE');
} else {
  console.log(`NOT DONE — ${stillMissing.length} remaining. Re-run the same command to continue.`);
  console.log(`  e.g. ${stillMissing.slice(0, 5).join(', ')}${stillMissing.length > 5 ? ' …' : ''}`);
  process.exitCode = 1;
}
