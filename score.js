#!/usr/bin/env node
// Advocacy Readiness Grader — PHASE 1: evidence collection only.
//
// This script observes. It does not score, does not call an AI model, and does
// not assert anything it did not fetch. Spec §7:
//   1. Never fabricate a signal      -> everything here traces to fetch_log
//   2. Cite the evidence             -> counts carry their source URLs
//   4. Degrade gracefully            -> missing inputs are recorded, not fatal
//   5. Respect robots.txt            -> every URL is checked before it is fetched
//
// Usage: node score.js <domain> [options]

import { writeFileSync } from 'node:fs';
import { run, normalizeDomain, stripDerived } from './lib/run.js';
export { normalizeDomain };

function parseArgs(argv) {
  const opts = { domain: null, out: null, maxSitemaps: 60, maxUrls: 60000, timeout: 15000, quiet: false, pretty: true,
    sample: 24, pages: true, ats: true, maxCredits: 150, concurrency: 5, score: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--max-sitemaps') opts.maxSitemaps = Number(argv[++i]);
    else if (a === '--max-urls') opts.maxUrls = Number(argv[++i]);
    else if (a === '--timeout') opts.timeout = Number(argv[++i]);
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--compact') opts.pretty = false;
    else if (a === '--sample') opts.sample = Number(argv[++i]);
    else if (a === '--no-pages') opts.pages = false;
    else if (a === '--no-ats') opts.ats = false;
    else if (a === '--max-credits') opts.maxCredits = Number(argv[++i]);
    else if (a === '--concurrency') opts.concurrency = Number(argv[++i]);
    else if (a === '--no-score') opts.score = false;
    else if (!a.startsWith('-')) opts.domain = a;
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.domain) {
  console.error('Usage: node score.js <domain> [--out file.json] [--sample N] [--no-pages] [--no-ats]\n                       [--max-credits N] [--concurrency N] [--max-urls N] [--max-sitemaps N] [--timeout ms] [--compact]');
  process.exit(2);
}
try {
  const result = await run(opts);
  const json = JSON.stringify(stripDerived(result), null, opts.pretty ? 2 : 0);
  if (opts.out) { writeFileSync(opts.out, json); if (!opts.quiet) console.error(`wrote ${opts.out} (${json.length} bytes)`); }
  else console.log(json);
} catch (err) {
  console.error(JSON.stringify({ schema: 'advocacy-grader/evidence', phase: 1, fatal_error: String(err.message || err), input: opts.domain }, null, 2));
  process.exit(1);
}
