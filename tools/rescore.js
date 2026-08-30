// Re-applies the rubric to already-collected evidence. Calibration is a tuning
// loop, and re-fetching twelve sites for every curve tweak would be both slow
// and rude to the targets.
import { readdirSync, existsSync } from 'node:fs';
import { scoreEvidence } from '../lib/rubric.js';
import { leadScore } from '../lib/lead-score.js';

const dir = process.argv[2] || './out/calib';
if (!existsSync(dir)) {
  console.error(`rescore: evidence directory not found: ${dir}`);
  console.error('Pass a directory of evidence JSON files (e.g. `node tools/rescore.js fixtures/calib`).');
  console.error('The full 350-domain calibration cache (out/calib/) is fetched data and is not in the repo.');
  process.exit(1);
}
const rows = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  const ev = (await import(`${process.cwd()}/${dir}/${f}`, { with: { type: 'json' } })).default;
  const s = scoreEvidence(ev);
  const l = leadScore(ev, s.overall_score);
  rows.push({
    name: f.replace('.json', ''), gradeable: s.gradeable, grade: s.grade, overall: s.overall_score,
    cs: s.categories.content_supply.score, sh: s.categories.shareability.score,
    ec: s.categories.employee_culture.score, ai: s.categories.ai_discoverability.score,
    pressure: l.hiring_pressure, gap: l.opportunity_gap, tier: l.tier,
  });
}
rows.sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1));

const p = (v, w) => String(v === null || v === undefined ? '—' : v).padStart(w);
console.log(['domain'.padEnd(15), 'gr'.padStart(3), 'over'.padStart(6), 'cont'.padStart(6), 'shr'.padStart(6), 'cult'.padStart(6), 'ai'.padStart(6), 'press'.padStart(7), 'gap'.padStart(6), '  tier'].join(''));
for (const r of rows) console.log([r.name.padEnd(15), p(r.grade, 3), p(r.overall, 6), p(r.cs, 6), p(r.sh, 6), p(r.ec, 6), p(r.ai, 6), p(r.pressure, 7), p(r.gap, 6), '  ' + r.tier].join(''));

const g = rows.filter((r) => r.gradeable);
const dist = g.reduce((a, r) => { a[r.grade] = (a[r.grade] || 0) + 1; return a; }, {});
console.log('\ngradeable', g.length, '/', rows.length, '| distribution', JSON.stringify(dist));
for (const [k, l] of [['overall', 'OVERALL'], ['cs', 'content'], ['sh', 'share'], ['ec', 'culture'], ['ai', 'ai']]) {
  const v = g.map((r) => r[k]).sort((a, b) => a - b);
  console.log(l.padEnd(8), 'min', p(v[0], 6), 'p25', p(v[Math.floor(v.length * 0.25)], 6), 'med', p(v[Math.floor(v.length / 2)], 6), 'p75', p(v[Math.floor(v.length * 0.75)], 6), 'max', p(v[v.length - 1], 6));
}
