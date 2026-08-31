// Renders one self-contained report page per domain, plus the corpus index.
// The report is the product: findings first, grade only when coverage earned
// it. No external assets, no JavaScript required (native <details> only),
// light and dark via prefers-color-scheme. Real companies are named here, so
// the tone is factual and specific — state what was checked, what was found,
// and what to change. Never mocking.
//
// PRIVACY: lead_signals / lead_score are never passed in and never rendered.
// Findings are built by lib/findings.js, which excludes them by construction.

import { CACHE_TTL_MS } from './cache.js';

// Every user-visible mention of the cache window derives from CACHE_TTL_MS so a
// page can never claim a TTL the code does not actually enforce.
const CACHE_TTL_DAYS = Math.round(CACHE_TTL_MS / 86400000);

// Dates are formatted in UTC on purpose. meta.started_at is a UTC ISO string, and
// a bare toLocaleDateString() formats in the HOST timezone — so the static build
// (built on a Mac in UTC-6) and the live server (UTC on Render) would print
// different dates for the SAME evidence. Pinning UTC keeps them identical.
const longDate = (d) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SEV_LABEL = { critical: 'Broken', issue: 'Issue', opportunity: 'Opportunity', info: 'Note', positive: 'Working', limitation: 'Not visible' };

export const CSS = `
:root{
  --bg:#faf9f7; --panel:#ffffff; --ink:#1e2126; --muted:#5b6470; --line:#e3e0da;
  --accent:#0d5c63; --accent-ink:#ffffff;
  --crit:#a8323a; --crit-bg:#fbeef0; --issue:#8a5a12; --issue-bg:#fbf3e4;
  --opp:#28618f; --opp-bg:#eaf2f9; --pos:#2e6b46; --pos-bg:#ecf5ef;
  --lim:#5b6470; --lim-bg:#f1f0ed;
  --grade-a:#2e6b46; --grade-b:#3a7a54; --grade-c:#8a5a12; --grade-d:#a05c2c; --grade-f:#a8323a;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#15171b; --panel:#1d2026; --ink:#e6e4df; --muted:#9aa2ad; --line:#31353d;
    --accent:#5cb8bf; --accent-ink:#10262a;
    --crit:#e08790; --crit-bg:#332326; --issue:#d8ab5e; --issue-bg:#302a1e;
    --opp:#7fb3dd; --opp-bg:#1f2a35; --pos:#84c29d; --pos-bg:#1f2e25;
    --lim:#9aa2ad; --lim-bg:#23262c;
    --grade-a:#84c29d; --grade-b:#84c29d; --grade-c:#d8ab5e; --grade-d:#dd9a6a; --grade-f:#e08790;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:860px;margin:0 auto;padding:2rem 1.25rem 4rem}
a{color:var(--accent)}
h1{font-size:1.9rem;line-height:1.2;margin:.25rem 0 .1rem;overflow-wrap:anywhere}
h2{font-size:1.25rem;margin:2.2rem 0 .8rem;border-bottom:1px solid var(--line);padding-bottom:.35rem}
.kicker{font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.kicker.brand{letter-spacing:.02em}
.wm{text-transform:none;letter-spacing:.04em;white-space:nowrap}
.wm .a{color:var(--ink);font-weight:500}
.wm .b{color:var(--muted);font-weight:400}
.nav{margin:.5rem 0}
.nav.topnav{margin:.6rem 0 0}
.foot-brand{font-size:1.25em}
.nav.foot-nav{font-size:1.25em;margin:.4em 0 0}
.sub{color:var(--muted);font-size:.9rem;margin:0}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:1.1rem 1.25rem;margin:1rem 0}
.gradebox{display:flex;gap:1.25rem;align-items:center;flex-wrap:wrap}
.gradeletter{font-size:3.4rem;font-weight:700;line-height:1;min-width:4.2rem;text-align:center}
.g-A{color:var(--grade-a)}.g-B{color:var(--grade-b)}.g-C{color:var(--grade-c)}.g-D{color:var(--grade-d)}.g-F{color:var(--grade-f)}
.withheld-mark{font-size:1.5rem;font-weight:700;color:var(--lim)}
.finding{background:var(--panel);border:1px solid var(--line);border-left-width:4px;border-radius:8px;padding:.9rem 1.1rem;margin:.7rem 0}
.finding h3{margin:.1rem 0 .4rem;font-size:1.05rem}
.finding p{margin:.4rem 0}
.f-critical{border-left-color:var(--crit)} .f-issue{border-left-color:var(--issue)}
.f-opportunity{border-left-color:var(--opp)} .f-positive{border-left-color:var(--pos)}
.f-limitation{border-left-color:var(--lim)} .f-info{border-left-color:var(--lim)}
.chip{display:inline-block;font-size:.72rem;font-weight:600;letter-spacing:.05em;text-transform:uppercase;border-radius:99px;padding:.15rem .6rem;margin-bottom:.2rem}
.c-critical{color:var(--crit);background:var(--crit-bg)} .c-issue{color:var(--issue);background:var(--issue-bg)}
.c-opportunity{color:var(--opp);background:var(--opp-bg)} .c-positive{color:var(--pos);background:var(--pos-bg)}
.c-limitation,.c-info{color:var(--lim);background:var(--lim-bg)}
.fix{border-top:1px dashed var(--line);margin-top:.6rem;padding-top:.5rem}
.fix b{color:var(--accent)}
details{margin:.4rem 0 0}
summary{cursor:pointer;color:var(--muted);font-size:.85rem}
.ev{font-size:.85rem;color:var(--muted);overflow-x:auto}
.ev ul{margin:.4rem 0;padding-left:1.2rem}
.ev li{overflow-wrap:anywhere}
table{border-collapse:collapse;width:100%;font-size:.9rem}
.tablewrap{overflow-x:auto}
th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:.8rem;text-transform:uppercase;letter-spacing:.05em}
.honest{border-left:4px solid var(--accent);background:var(--panel);border-radius:8px;padding:1rem 1.25rem;margin:1.4rem 0}
.honest p{margin:.5rem 0}
.note{font-size:.85rem;color:var(--muted)}
footer{margin-top:3rem;border-top:1px solid var(--line);padding-top:1rem;font-size:.8rem;color:var(--muted)}
.score-num{font-variant-numeric:tabular-nums}
.catscore{font-weight:700}
.conf{font-size:.75rem;color:var(--muted)}
`;

function findingCard(f) {
  const ev = f.evidence || {};
  const urls = ev.urls || ev.missing_examples || [];
  const extra = ev.urls_truncated || ev.missing_truncated || 0;
  const attempts = ev.attempts || [];
  const rawExcerpt = ev.raw_excerpt || [];
  const prefixes = ev.top_unclassified_prefixes ? Object.entries(ev.top_unclassified_prefixes).slice(0, 8) : [];
  const hasDetail = urls.length || attempts.length || rawExcerpt.length || prefixes.length;
  return `<div class="finding f-${f.severity}">
  <span class="chip c-${f.severity}">${SEV_LABEL[f.severity] || f.severity}</span>
  <h3>${esc(f.title)}</h3>
  <p>${esc(f.narrative || f.statement)}</p>
  ${hasDetail ? `<details><summary>Evidence — ${esc(ev.source || 'observed')}</summary><div class="ev"><ul>
    ${urls.map((u) => `<li>${esc(u)}</li>`).join('')}
    ${extra ? `<li>… and ${extra} more in the sample</li>` : ''}
    ${attempts.map((a) => `<li>${esc(a.url || a.origin)} — ${a.skipped ? esc(a.skipped) : a.status != null ? 'HTTP ' + esc(a.status) : esc(a.error || 'no response')}</li>`).join('')}
    ${prefixes.map(([p, n]) => `<li>${esc(p)} — ${n} URL(s) that could not be classified</li>`).join('')}
    ${rawExcerpt.map((l) => `<li><code>${esc(l)}</code></li>`).join('')}
  </ul></div></details>` : ev.source ? `<p class="note">Evidence: ${esc(ev.source)}${ev.n != null && ev.of != null ? ` — ${ev.n} of ${ev.of} sampled pages` : ''}.</p>` : ''}
  ${f.fix ? `<p class="fix"><b>The fix:</b> ${esc(f.narrative_fix || f.fix)}</p>` : ''}
</div>`;
}

const CAT_LABEL = {
  content_supply: 'Content Supply', shareability: 'Shareability',
  employee_culture: 'Employee & Culture Surface', ai_discoverability: 'AI Discoverability',
};

function categorySection(scoring) {
  if (!scoring) return '';
  const rows = Object.entries(scoring.categories).map(([key, c]) => {
    if (!c.scorable) {
      return `<div class="panel"><h3 style="margin:.1rem 0">${CAT_LABEL[key]} — <span class="conf">not scored</span></h3><p class="note">${esc(c.reason)}</p></div>`;
    }
    return `<div class="panel">
      <h3 style="margin:.1rem 0">${CAT_LABEL[key]} — <span class="catscore score-num">${c.score}</span>/100 ${c.confidence === 'reduced' ? '<span class="conf">(reduced confidence)</span>' : ''}</h3>
      <div class="tablewrap"><table><thead><tr><th>Signal</th><th>Points</th><th>What was observed</th></tr></thead><tbody>
      ${(c.components || []).map((cp) => `<tr><td>${esc(cp.name)}</td><td class="score-num">${cp.points}/${cp.max}</td><td>${esc(cp.evidence)}</td></tr>`).join('')}
      </tbody></table></div>
      ${(c.notes || []).map((nx) => `<p class="note">${esc(nx)}</p>`).join('')}
    </div>`;
  });
  return `<h2>How the numbers break down</h2>
  <p class="note">Weights: Content Supply 30% · Shareability 25% · Employee &amp; Culture 25% · AI Discoverability 20%. The weights are editorial judgment about what an advocacy program draws on — not the result of a study. Every row cites the observation behind it.</p>
  ${rows.join('\n')}`;
}

function honestPanel({ preGenerated, collectedDate }) {
  return `<div class="honest">
  <p class="kicker">Read this before the numbers</p>
  <p><b>This tool was built in a few days, on a stack of stated assumptions.</b> I didn't have the time — or the inside knowledge of what buyers in this category actually optimize for — to be certain these are the metrics that matter most. The four categories and their weights are editorial judgment, not measurement: nobody has proven that these things cause employees to post, and I don't claim otherwise.</p>
  <p>What isn't measured, on purpose: your employees' actual posting. I chose to strictly adhere to LinkedIn's Terms of Service, so no direct or indirect scraping of LinkedIn went into this report. The only LinkedIn signal here is whether your own pages carry a LinkedIn share link — that's your HTML, not theirs. This report reads only what your company has published on its own public site, which is also the part you can fix.</p>
  ${preGenerated ? `<p>To prioritize speed, this particular report was loaded using cached data; it was generated from evidence originally collected on ${collectedDate} rather than live. Reports are cached for ${CACHE_TTL_DAYS} days. Every observation below is dated and cited.</p>` : ''}
  <p>What you can hold me to: every number cites its public evidence, nothing unseen is guessed at, robots.txt is respected on every fetch, and when this tool can't read a site it says so instead of issuing a grade.</p>
</div>`;
}

export function renderReport({ domain, ev, scoring, findings, generatedAt = new Date(), preGenerated = true, backHref = '../index.html', corpusStats = null }) {
  const s = scoring;
  const graded = Boolean(s?.gradeable);
  const checkedAt = ev.meta?.started_at ? new Date(ev.meta.started_at) : generatedAt;
  const collectedDate = longDate(checkedAt);

  const gradeBlock = graded
    ? `<div class="panel gradebox">
        <div class="gradeletter g-${s.grade} score-num">${s.grade}</div>
        <div>
          <p style="margin:.1rem 0"><b class="score-num">${s.overall_score}</b>/100 — advocacy readiness${s.confidence === 'reduced' ? ' <span class="conf">(reduced confidence: parts of the evidence were unobservable — see below)</span>' : ''}</p>
          <p class="note" style="margin:.2rem 0">Graded because the reader classified enough of this site to trust the measurement.${corpusStats ? ` For scale: of the ${corpusStats.total} companies in this corpus, only ${corpusStats.graded} earned a grade — for the rest I withheld it rather than grade a site the reader could not read.` : ''}</p>
        </div>
      </div>`
    : `<div class="panel">
        <p class="withheld-mark">No letter grade — withheld, not failed</p>
        <p>${esc(s?.withheld_reason || 'Too little of this site was observable to grade honestly.')}</p>
      </div>`;

  const sections = [];
  if (findings.actions.length) {
    sections.push(`<h2>What was found — most fixable first</h2>
    <p class="note">Ranked by impact × ease of fixing, not by category. Counts describe the pages actually read, and each finding cites them.</p>
    ${findings.actions.map(findingCard).join('\n')}`);
  } else {
    sections.push(`<h2>What was found</h2><p>No actionable issues surfaced in what was observable. The limitations below say what could not be checked.</p>`);
  }
  if (findings.positives.length) sections.push(`<h2>What's already working</h2>${findings.positives.map(findingCard).join('\n')}`);
  if (findings.limitations.length) sections.push(`<h2>What could not be seen</h2>
  <p class="note">Anything the reader could not observe is listed here rather than guessed at or silently skipped.</p>
  ${findings.limitations.map(findingCard).join('\n')}`);
  if (findings.info.length) sections.push(`<h2>For the record</h2>${findings.info.map(findingCard).join('\n')}`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(domain)} — Advocacy Grade by justmesocial</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <p class="kicker brand">Advocacy Grade <span class="wm">by <span class="a">justme</span><span class="b">social</span></span></p>
  <h1>${esc(domain)}</h1>
  <p class="sub">Evidence collected ${collectedDate} · ${ev.meta?.requests_made ?? '?'} polite, robots.txt-respecting requests · every claim cites what it saw</p>
  <p class="nav topnav"><a href="${esc(backHref)}">&larr; Browse all reports</a></p>
  ${gradeBlock}
  ${honestPanel({ preGenerated, collectedDate })}
  ${sections.join('\n')}
  ${categorySection(s)}
  <footer>
    <p class="foot-brand">Advocacy Grade <span class="wm">by <span class="a">justme</span><span class="b">social</span></span>.</p>
    <p class="nav foot-nav"><a href="${esc(backHref)}">&larr; Browse all reports</a></p>
    <p>Method: deterministic rubric in code — the same evidence always yields the same result; no model assigns numbers. User-agent: ${esc(ev.meta?.user_agent || '')}. This page renders without JavaScript and holds no tracking.</p>
    <p>This report reads only public pages, identifies itself honestly, and honors robots.txt on every request — including the ones that would have made it look better.</p>
  </footer>
</main>
</body>
</html>`;
}

export function renderIndex({ rows, generatedAt = new Date(), stats }) {
  const rowsHtml = rows.map((r) => `<tr>
    <td><a href="reports/${esc(r.slug)}.html">${esc(r.domain)}</a></td>
    <td>${r.grade ? `<b class="g-${r.grade} score-num">${r.grade}</b> <span class="score-num note">${r.overall}</span>` : '<span class="note">grade withheld — report available</span>'}</td>
    <td class="score-num">${r.actions}</td>
  </tr>`).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Advocacy Grade by justmesocial — ${stats.total} company reports</title>
<style>${CSS}
.searchnote{margin:.4rem 0 1rem}
</style>
</head>
<body>
<main>
  <p class="kicker brand">Advocacy Grade <span class="wm">by <span class="a">justme</span><span class="b">social</span></span></p>
  <h1>What ${stats.total} companies hand their employees to share</h1>
  <p class="sub">Pre-generated reports from public evidence — sitemaps, share tags, structured data, robots.txt AI posture. Generated ${generatedAt.toISOString().slice(0, 10)}.</p>

  <div class="panel">
    <p><b>The honest headline:</b> of ${stats.total} companies, I issued a letter grade to ${stats.graded}. For the other ${stats.withheld} I <i>withheld</i> the grade — mostly because the reader could not classify the site's content structure, and grading the readable sliver would report a gap in this tool as their failure. Every report still lists what was observed, cited and ranked by fixability.</p>
  </div>

  ${honestIndexPanel()}

  <h2>Reports</h2>
  <div class="tablewrap"><table>
    <thead><tr><th>Domain</th><th>Grade</th><th>Findings</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table></div>

  <footer>
    <p>Every report reads only public pages, identifies itself honestly, and honors robots.txt on every request. No tracking on any page.</p>
  </footer>
</main>
</body>
</html>`;
}

function honestIndexPanel() {
  return `<div class="honest">
  <p class="kicker">What this is — and isn't</p>
  <p>Employee-advocacy leaderboards rank companies by how many employees post. They're useful, and this isn't one. A ranking can't tell you what to change on Monday; this looks at the conditions that can actually be observed on your public website — every one of them something you can fix: <b>content supply</b> (is there anything worth sharing?), <b>shareability</b> (does a shared link survive the trip?), <b>employee &amp; culture surface</b> (are there pages a person would put their name on?), and <b>AI discoverability</b> (can machines find, read, and cite you?).</p>
  <p>To be straight about it: nobody has proven these four things cause employees to post — no such study exists and I haven't run one. The weights are editorial judgment. LinkedIn activity is not measured because I chose to strictly adhere to LinkedIn's Terms of Service, so no direct or indirect scraping of LinkedIn went into any of these results. And I built this in a few days on a stack of assumptions, without the inside knowledge to be sure these are the metrics that matter most — the reports are pre-generated because I spent the time on reading sites honestly rather than on making the live run fast.</p>
  <p>What survives all those caveats: every claim cites the public evidence behind it, and when this tool can't read a site it says so instead of grading it.</p>
</div>`;
}
