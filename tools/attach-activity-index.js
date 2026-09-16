// Attach the cached activity-index resolution + counts to the corpus evidence
// files, so the seed tarball and the static site carry the same block a live
// run would. Reads out/activity-index-cache/<domain>.json (written by
// tools/activity-index-resolve.js) and writes ev.activity_index in place.
// Domains with no cache entry get an explicit not_looked_up block — the key is
// never silently absent. Nothing else in the evidence file is touched.
//   node tools/attach-activity-index.js [out/calib]
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { evidenceBlock } from '../lib/activity-index.js';
import { registrableDomain } from '../lib/domain.js';

const dir = process.argv[2] || 'out/calib';
const cacheDir = 'out/activity-index-cache';
const tally = { resolved: 0, unresolved: 0, not_looked_up: 0, unchanged: 0 };
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  const path = `${dir}/${f}`;
  let ev; try { ev = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
  const host = registrableDomain(ev.meta?.normalized_host || f.slice(0, -5));
  const cp = `${cacheDir}/${host}.json`;
  let block;
  if (existsSync(cp)) {
    const r = JSON.parse(readFileSync(cp, 'utf8'));
    block = evidenceBlock(r, r.counts || null);
    tally[r.status === 'resolved' ? 'resolved' : 'unresolved']++;
  } else {
    block = { source: 'licensed third-party index', status: 'not_looked_up', reason: 'no lookup has been run for this domain', fetched_at: new Date().toISOString() };
    tally.not_looked_up++;
  }
  const before = JSON.stringify(ev.activity_index || null);
  const { fetched_at: _a, ...cmpNew } = block; const { fetched_at: _b, ...cmpOld } = ev.activity_index || {};
  if (JSON.stringify(cmpNew) === JSON.stringify(cmpOld)) { tally.unchanged++; continue; }
  ev.activity_index = block;
  const nos = new Set(ev.not_observed || []);
  for (const x of [...nos]) if (/^Employee posting activity:/.test(x)) nos.delete(x);
  if (block.status !== 'resolved') nos.add(block.status === 'not_looked_up'
    ? 'Employee posting activity: not looked up for this pre-generated report, so Employee & Culture is scored on website evidence alone.'
    : `Employee posting activity: this domain could not be matched to a company in the licensed index (${block.reason || block.status}), so Employee & Culture is scored on website evidence alone.`);
  ev.not_observed = [...nos];
  writeFileSync(path, JSON.stringify(ev)); // compact, like score.js writes them — the seed tarball triples otherwise
}
console.log(JSON.stringify(tally));
