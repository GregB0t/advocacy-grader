// Resolve domains to activity-index company records and print the free aggregate counts.
//   node tools/activity-index-resolve.js everyonesocial.com gong.io [--no-cache] [--no-counts] [--max-credits 60] [--concurrency 6] [--selftest]
// Counts are written back into the cache record so tools/rescore-activity-index.js can read one file per domain.
// Fetches each homepage ONCE (origin probe, same as score.js) so the resolver can
// see the LinkedIn /company/ link the site declares. Raw resolution goes to
// out/activity-index-cache/<domain>.json; a run log to out/activity-index/_resolve-<ts>.jsonl.
import { appendFileSync, mkdirSync } from 'node:fs';
import { ActivityIndex } from '../lib/activity-index.js';
import { Fetcher } from '../lib/http.js';
import { loadEnv } from '../lib/scrapingbee.js';
import { registrableDomain } from '../lib/domain.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const domains = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--max-credits' && args[i - 1] !== '--concurrency');
const CONC = Math.max(1, Number(opt('--concurrency', 6)));
const env = loadEnv(new URL('../.env', import.meta.url).pathname);
const cs = new ActivityIndex({ apiKey: process.env.ACTIVITY_INDEX_API_KEY || env.ACTIVITY_INDEX_API_KEY || null, baseUrl: process.env.ACTIVITY_INDEX_BASE_URL || env.ACTIVITY_INDEX_BASE_URL || null, maxCreditsPerRun: Number(opt('--max-credits', 60)) * Math.max(1, domains.length) });
if (!cs.enabled) { console.error('ACTIVITY_INDEX_API_KEY and ACTIVITY_INDEX_BASE_URL are both required (.env)'); process.exit(1); }
mkdirSync('out/activity-index', { recursive: true });
const logPath = `out/activity-index/_resolve-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;

if (flag('--selftest')) {
  const t = await cs.selfTest();
  console.log('selftest', t.ok ? 'PASS' : 'FAIL', JSON.stringify(t));
  if (!t.ok) { console.error('Positive control failed — do not trust any count until this passes.'); process.exit(2); }
}

const fetcher = new Fetcher({ timeoutMs: 15000 });
async function one(raw) {
  const domain = registrableDomain(raw);
  const out = [`\n=== ${raw}${domain !== raw ? ` (${domain})` : ''} ===`];
  let html = null, finalHost = null;
  const cached = flag('--no-cache') ? null : cs.cacheGet(domain);
  if (!cached) {
    for (const origin of [`https://${domain}`, `https://www.${domain}`]) {
      const res = await fetcher.get(origin + '/', { note: 'origin probe', accept: 'text/html' });
      if (res.ok) { html = res.body; try { finalHost = new URL(res.finalUrl).hostname; } catch {} break; }
    }
    out.push(`  homepage: ${html ? `${html.length} chars, final host ${finalHost}` : 'not fetched'}`);
  }
  const r = await cs.resolveCompany({ domain, finalHost, html, useCache: !flag('--no-cache') });
  const line = { domain, ...r, record: r.record ? { id: r.record.id, company_name: r.record.company_name, website: r.record.website, employees_count: r.record.employees_count, size_range: r.record.size_range } : null };
  out.push(`  ${r.status.toUpperCase()}${r.from_cache ? ' (cache)' : ''} ${r.status === 'resolved' ? `id=${r.company_id} "${r.company_name}" confidence=${r.confidence} coverage=${r.coverage} via ${r.method}` : r.reason || ''}  credits=${r.credits_used}`);
  for (const c of r.candidates || []) out.push(`    - ${c.method}: ${c.verdict}${c.id ? ` id=${c.id} "${c.name}" website=${c.website} employees=${c.employees_count} size=${c.size_range} indexed=${c.employees_indexed} -> ${c.confidence}` : c.status ? ` (HTTP ${c.status})` : ''}`);
  for (const n of r.notes || []) out.push(`    note: ${n}`);
  if (r.status === 'resolved' && !flag('--no-counts')) {
    const c = await cs.companyCounts(r.company_id);
    line.counts = c;
    out.push(`  counts (${c.window_days}d since ${c.since}): employees_indexed=${c.employees_indexed} posted=${c.employees_posted_in_window} rate=${c.active_poster_rate_pct}% 12+/yr=${c.employees_posting_12plus_per_year} dm_posted=${c.decision_makers_posted_in_window} company_posts=${c.company_posts_in_window}/${c.company_posts_all_time} reshares=${c.reshares_of_company_posts_in_window}`);
    // persist counts beside the resolution so rescoring reads one file per domain
    const { from_cache, credits_used, ...rest } = r;
    cs.cachePut(domain, { ...rest, counts: c, counts_at: new Date().toISOString() });
  }
  else if (r.status === 'unresolved' && !r.from_cache) {
    // --no-cache skips the resolver's own write; record the failure so a stale
    // earlier resolution cannot outlive the evidence that it was wrong.
    const { from_cache, credits_used, ...rest } = r;
    cs.cachePut(domain, rest);
  }
  appendFileSync(logPath, JSON.stringify(line) + '\n');
  console.log(out.join('\n'));
}
// Concurrency: the plan allows 50 req/s; each domain is ~10 calls, so 6 in flight is far under it.
const queue = [...domains];
await Promise.all(Array.from({ length: Math.min(CONC, queue.length) }, async () => { while (queue.length) await one(queue.shift()); }));
console.log(`\ncredits used this run: ${cs.creditsUsed}  (${cs.calls.length} API calls)  log: ${logPath}`);
