// Side-by-side: current "Employee & Culture Surface" vs proposed "Employee Voice".
// Both scored from the SAME cached evidence so the comparison is apples to apples.
import { readdirSync, readFileSync } from 'node:fs';
import { scoreEvidence } from '../lib/rubric.js';

const clamp = (n) => Math.max(0, Math.min(100, n));
const r1 = (n) => Math.round(n * 10) / 10;
function scale(v, pts) {
  if (v <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) { const [x0,y0]=pts[i-1],[x1,y1]=pts[i]; if (v <= x1) return y0+((v-x0)/(x1-x0))*(y1-y0); }
  return pts[pts.length-1][1];
}

export function authorStats(ev) {
  const pages = ev.shareability?.pages || [];
  const counts = new Map();
  for (const p of pages) for (const n of (p.author?.names || [])) {
    const k = String(n).trim().toLowerCase().replace(/^author:\s*/, '');
    if (k) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const withAuthor = pages.filter((p) => p.author?.named_human_author).length;
  const vals = [...counts.values()].sort((a, b) => b - a);
  return {
    distinct: counts.size,
    withAuthor,
    sampled: pages.length,
    topShare: withAuthor ? Math.round((vals[0] / withAuthor) * 100) : 0,
    namedPct: pages.length ? Math.round((withAuthor / pages.length) * 100) : 0,
    names: [...counts.keys()],
  };
}

// PROPOSED: Employee Voice
function employeeVoice(ev) {
  const a = authorStats(ev);
  const cc = ev.classification?.canonical_content;
  const cultureUrls = cc?.sections?.culture || 0;
  const careersUrls = cc?.sections?.careers || 0;
  const careersOk = (ev.lead_signals?.careers_pages_checked || []).some((c) => c.ok);
  const authorPages = cc?.sections?.author_tag_taxonomy || 0;

  // How many different people publish under their own name — the difference between
  // "a content team" and "a company where people write".
  const diversity = scale(a.distinct, [[0,0],[1,5],[3,14],[6,24],[12,32],[24,35]]);
  // How concentrated those bylines are. One person writing everything is a
  // content operation, not an advocacy culture.
  const spread = a.withAuthor === 0 ? 0 : scale(100 - a.topShare, [[0,0],[30,6],[50,12],[70,18],[92,20]]);
  const coverage = (a.namedPct / 100) * 15;
  const culture = scale(cultureUrls, [[0,0],[1,4],[3,9],[10,14],[30,15]]);
  const careers = (careersOk ? 8 : 0) + scale(careersUrls, [[0,0],[1,2],[5,5],[20,7]]);
  const authorInfra = scale(authorPages, [[0,0],[1,3],[10,6],[50,8]]);

  return {
    score: r1(clamp(diversity + spread + coverage + culture + careers + authorInfra)),
    parts: { diversity: r1(diversity), spread: r1(spread), coverage: r1(coverage), culture: r1(culture), careers: r1(careers), authorInfra: r1(authorInfra) },
    stats: a,
  };
}

const rows = [];
for (const f of readdirSync('./out/calib').filter((x) => x.endsWith('.json'))) {
  const ev = JSON.parse(readFileSync('./out/calib/' + f, 'utf8'));
  const s = scoreEvidence(ev);
  if (!s.gradeable) continue;
  const ec = s.categories.employee_culture.score;
  const ev2 = employeeVoice(ev);
  // Recompute overall with the new category swapped in.
  const overall2 = r1(s.categories.content_supply.score * 0.30 + s.categories.shareability.score * 0.25 + ev2.score * 0.25 + s.categories.ai_discoverability.score * 0.20);
  const band = (n) => n >= 85 ? 'A' : n >= 70 ? 'B' : n >= 55 ? 'C' : n >= 40 ? 'D' : 'F';
  rows.push({ n: f.replace('.json',''), ec, ev: ev2.score, o1: s.overall_score, o2: overall2, g1: s.grade, g2: band(overall2), st: ev2.stats, parts: ev2.parts });
}
rows.sort((a,b) => b.o2 - a.o2);

const p = (v,w) => String(v).padStart(w);
console.log(['domain'.padEnd(15),'cat3-now'.padStart(9),'cat3-new'.padStart(9),'  ','over-now'.padStart(9),'over-new'.padStart(9),'  now','  new','   authors','  top%'].join(''));
for (const r of rows) console.log([r.n.padEnd(15),p(r.ec,9),p(r.ev,9),'  ',p(r.o1,9),p(r.o2,9),p(r.g1,5),p(r.g2,5),p(r.st.distinct,10),p(r.st.topShare+'%',7)].join(''));

const d1 = rows.reduce((a,r)=>{a[r.g1]=(a[r.g1]||0)+1;return a},{});
const d2 = rows.reduce((a,r)=>{a[r.g2]=(a[r.g2]||0)+1;return a},{});
console.log('\ndistribution now:', JSON.stringify(d1));
console.log('distribution new:', JSON.stringify(d2));
const sp = (k) => { const v = rows.map(r=>r[k]).sort((a,b)=>a-b); return `min ${v[0]} med ${v[Math.floor(v.length/2)]} max ${v[v.length-1]} spread ${r1(v[v.length-1]-v[0])}`; };
console.log('cat3 now :', sp('ec'));
console.log('cat3 new :', sp('ev'));
