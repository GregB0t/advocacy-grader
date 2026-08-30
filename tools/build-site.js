// Builds the static corpus: one self-contained report page per cached
// evidence file in out/calib/, plus an index. This is the owner's safety net
// for Wednesday — no server, no latency, no API key. Deploy the site/
// directory anywhere static.
//
// Usage: node tools/build-site.js [evidence-dir] [out-dir]
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { scoreEvidence } from '../lib/rubric.js';
import { buildFindings } from '../lib/findings.js';
import { renderReport, renderIndex } from '../lib/report-html.js';

const srcDir = process.argv[2] || 'out/calib';
const outDir = process.argv[3] || 'site';
if (!existsSync(srcDir)) {
  console.error(`build-site: evidence directory not found: ${srcDir}`);
  console.error('Pass a directory of evidence JSON files (e.g. `node tools/build-site.js fixtures/calib out-sample`).');
  console.error('The full 350-domain calibration cache (out/calib/) is fetched data and is not in the repo;');
  console.error('the committed site/ directory is the pre-built output of this script over that cache.');
  process.exit(1);
}
mkdirSync(join(outDir, 'reports'), { recursive: true });

const rows = [];
let failures = 0;
for (const f of readdirSync(srcDir).filter((x) => x.endsWith('.json')).sort()) {
  const slug = f.replace(/\.json$/, '').replace(/[^a-z0-9.-]/gi, '_');
  try {
    const ev = JSON.parse(readFileSync(join(srcDir, f), 'utf8'));
    const scoring = scoreEvidence(ev); // ALWAYS the live rubric; d.scoring is stale first-pass output
    const findings = buildFindings(ev, scoring);
    const domain = ev.meta?.normalized_host || slug;
    const html = renderReport({ domain, ev, scoring, findings, preGenerated: true });
    writeFileSync(join(outDir, 'reports', slug + '.html'), html);
    rows.push({ slug, domain, grade: scoring.grade, overall: scoring.overall_score, actions: findings.actions.length });
  } catch (err) {
    failures++;
    console.error(`FAILED ${f}: ${err.message}`);
  }
}

rows.sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1) || a.domain.localeCompare(b.domain));
const graded = rows.filter((r) => r.grade).length;
writeFileSync(join(outDir, 'index.html'), renderIndex({ rows, stats: { total: rows.length, graded, withheld: rows.length - graded } }));

console.log(`built ${rows.length} reports (${graded} graded, ${rows.length - graded} withheld), ${failures} failures -> ${outDir}/`);
