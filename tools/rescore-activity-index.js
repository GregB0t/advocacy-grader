// Before/after for the Employee & Culture split. Reads out/calib evidence, attaches
// the cached activity-index resolution+counts (out/activity-index-cache/<domain>.json) as
// ev.activity_index, scores with and without opts.activity_index, and prints every domain
// whose letter grade moves. Nothing is written back to the evidence files.
//   node tools/rescore-activity-index.js [out/calib] [--all]
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { scoreEvidence } from '../lib/rubric.js';
import { registrableDomain } from '../lib/domain.js';

const dir = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'out/calib';
const showAll = process.argv.includes('--all');
const cacheDir = 'out/activity-index-cache';
const rows = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  let ev; try { ev = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')); } catch { continue; }
  const host = ev.meta?.normalized_host || f.slice(0, -5);
  const cp = `${cacheDir}/${registrableDomain(host)}.json`;
  const cs = existsSync(cp) ? JSON.parse(readFileSync(cp, 'utf8')) : null;
  const before = scoreEvidence(ev, { activity_index: false });
  const after = scoreEvidence({ ...ev, activity_index: cs });
  const ec = after.categories.employee_culture;
  rows.push({ host, gradeable: before.gradeable, g0: before.grade, s0: before.overall_score, g1: after.grade, s1: after.overall_score,
    ec0: before.categories.employee_culture.score, ec1: ec.score, basis: ec.basis,
    rate: ec.evidence?.activity_index?.active_poster_rate_pct ?? null, dm: ec.evidence?.activity_index?.decision_maker_rate_pct ?? null, posts: ec.evidence?.activity_index?.company_posts_90d ?? null, idx: ec.evidence?.activity_index?.employees_indexed ?? null, why: ec.evidence?.activity_index?.why ?? null });
}
const g = rows.filter((r) => r.gradeable);
const pad = (v, w) => String(v ?? '—').padStart(w);
const dist = (k) => g.reduce((a, r) => { a[r[k]] = (a[r[k]] || 0) + 1; return a; }, {});
const med = (a) => { a = a.filter((x) => x !== null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
console.log(`gradeable ${g.length}/${rows.length}   scored with index half: ${g.filter((r) => r.basis === 'website+index').length}   website-only fallback: ${g.filter((r) => r.basis === 'website').length}`);
console.log('distribution before', JSON.stringify(dist('g0')), ' after', JSON.stringify(dist('g1')));
console.log('median overall before', med(g.map((r) => r.s0)), ' after', med(g.map((r) => r.s1)), '| median culture before', med(g.map((r) => r.ec0)), ' after', med(g.map((r) => r.ec1)));
const movers = g.filter((r) => r.g0 !== r.g1);
console.log(`\nLETTER GRADE MOVES: ${movers.length}  (up ${movers.filter((r) => r.s1 > r.s0).length}, down ${movers.filter((r) => r.s1 < r.s0).length})`);
const hdr = ['domain'.padEnd(28), 'before'.padStart(8), 'after'.padStart(8), 'cult0'.padStart(6), 'cult1'.padStart(6), 'rate%'.padStart(6), 'dm%'.padStart(5), 'posts'.padStart(6), 'idx'.padStart(7), '  basis'].join('');
console.log(hdr);
const line = (r) => console.log([r.host.padEnd(28), pad(`${r.g0} ${r.s0}`, 8), pad(`${r.g1} ${r.s1}`, 8), pad(r.ec0, 6), pad(r.ec1, 6), pad(r.rate, 6), pad(r.dm, 5), pad(r.posts, 6), pad(r.idx, 7), '  ' + (r.basis === 'website' ? 'website-only: ' + (r.why || '') : r.basis)].join(''));
for (const r of movers.sort((a, b) => (b.s1 - b.s0) - (a.s1 - a.s0))) line(r);
if (showAll) { console.log('\nALL GRADEABLE'); for (const r of g.sort((a, b) => b.s1 - a.s1)) line(r); }
const fallback = g.filter((r) => r.basis === 'website');
if (fallback.length) { console.log(`\nWEBSITE-ONLY FALLBACKS (${fallback.length}):`); for (const r of fallback) console.log(`  ${r.host}: ${r.why}`); }
writeFileSync('out/activity-index/_rescore.json', JSON.stringify(rows, null, 1));
