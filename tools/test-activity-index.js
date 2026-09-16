// Activity-index resolver tests. Run: npm test (offline — every response is scripted).
//
// The fixtures replay the exact shapes the 2026-09-16 probe returned
// (out/activity-index/): "Gong Israel" for gong.io, 404 for aligntechnology.com,
// and the silent-zero behaviour of search. The failure this suite guards
// against is a resolver that confidently returns the wrong company, or that
// turns "not observed" into 0.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityIndex, assessCandidate, extractLinkedInShorthands, COST } from '../lib/activity-index.js';

let passed = 0, failed = 0;
function ok(cond, name) { if (cond) { passed++; console.log('ok - ' + name); } else { failed++; console.log('NOT OK - ' + name); } }
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name} (got ${JSON.stringify(a)})`);

// ---- scripted API ----
const GONG_IL = { id: 89888525, company_name: 'Gong Israel', website: 'https://www.gong.io', employees_count: 0, size_range: '501-1000 employees' };
const GONG = { id: 11252083, company_name: 'Gong', website: 'https://www.vercel.app', employees_count: 2672, size_range: '1001-5000 employees' };
const ES = { id: 6408815, company_name: 'EveryoneSocial', website: 'https://www.everyonesocial.com', employees_count: 88, size_range: '51-200 employees' };
const ALIGN = { id: 8932173, company_name: 'Align Technology', website: 'https://www.aligntech.com', employees_count: 13471, size_range: null };
const INDEXED = { 89888525: 0, 11252083: 1831, 6408815: 34, 8932173: 9699, 752371: 9903 };

function fakeFetch(log) {
  return async (url, init) => {
    log.push({ url, init });
    const u = new URL(url);
    const reply = (status, body, headers = {}) => ({ status, headers: new Map(Object.entries(headers)), text: async () => JSON.stringify(body) });
    if (u.pathname.endsWith('/company_multi_source/enrich')) {
      const w = u.searchParams.get('website');
      if (w === 'gong.io') return reply(200, GONG_IL);
      if (w === 'everyonesocial.com') return reply(200, ES);
      return reply(404, { detail: 'Company not found' });
    }
    if (u.pathname.includes('/company_multi_source/collect/')) {
      const sh = decodeURIComponent(u.pathname.split('/').pop());
      if (sh === 'gong-io') return reply(200, GONG);
      if (sh === 'align-technology') return reply(200, ALIGN);
      return reply(404, { detail: 'Company not found' });
    }
    if (u.pathname.endsWith('/employee_multi_source/search/es_dsl')) {
      const q = JSON.parse(init.body).query;
      const id = q?.term?.active_experience_company_id ?? q?.bool?.must?.[0]?.term?.active_experience_company_id;
      const n = INDEXED[id] ?? 0;
      return reply(200, n ? [1] : [], { 'x-total-results': String(n) });
    }
    if (u.pathname.endsWith('/employee_post/search/es_dsl')) {
      const q = JSON.parse(init.body).query;
      const flat = JSON.stringify(q).includes('"term":{"reshared_post.company_id"') && !JSON.stringify(q).includes('nested');
      return reply(200, flat ? [] : [1], { 'x-total-results': flat ? '0' : '105' });
    }
    if (u.pathname.endsWith('/company_post/search/es_dsl')) return reply(200, [1], { 'x-total-results': '165' });
    if (u.pathname.endsWith('/search/es_dsl')) return reply(500, { detail: 'boom' }); // no header
    return reply(404, { detail: 'nope' });
  };
}
const make = (opts = {}) => { const log = []; const cs = new ActivityIndex({ apiKey: 'test', baseUrl: 'https://index.example/v2', cacheDir: mkdtempSync(join(tmpdir(), 'cs-')), ledgerPath: null, fetchImpl: fakeFetch(log), ...opts }); return { cs, log }; };

// ---- shorthand extraction ----
const HTML = `<a href="https://www.linkedin.com/company/align-technology/">LinkedIn</a>
  <a href="https://linkedin.com/company/align-technology?trk=x">again</a>
  <a href="https://www.linkedin.com/showcase/invisalign/">showcase</a>
  <a href="https://www.linkedin.com/school/foo/">school</a>
  <a href="https://uk.linkedin.com/company/Other-Co">other</a>
  {"sameAs":["https://www.linkedin.com/company/align-technology"]}`;
eq(extractLinkedInShorthands(HTML), ['align-technology', 'other-co'], 'shorthands: /company/ only, most-linked first, lowercased, query/slash stripped');
eq(extractLinkedInShorthands(''), [], 'shorthands: empty html -> none');
eq(extractLinkedInShorthands(null), [], 'shorthands: null html -> none');

// ---- assessment ----
ok(assessCandidate(ES, { domain: 'everyonesocial.com', employeesIndexed: 34 }).confidence === 'high', 'assess: website match + headcount -> high');
{ const a = assessCandidate(GONG_IL, { domain: 'gong.io', employeesIndexed: 0 });
  ok(a.confidence === 'low' && a.checks.headcount_consistent === false, 'assess: Gong Israel (employees 0 vs size 501-1000) -> low, inconsistency named'); }
ok(assessCandidate(GONG, { domain: 'gong.io', employeesIndexed: 1831, method: 'homepage_linkedin:gong-io' }).confidence === 'medium', 'assess: alias website but homepage-declared -> medium');
{ const { nameMatchesSite, extractTitle } = await import('../lib/activity-index.js');
  const AGENCY = { id: 21740843, company_name: 'MarkUpgrade', website: 'https://www.markupgrade.com', employees_count: 3, size_range: '1-10 employees' };
  const a = assessCandidate(AGENCY, { domain: 'clientsite.fr', employeesIndexed: 1, method: 'homepage_linkedin:markupgrade', siteTitle: 'Client Site — Fabricant de portes' });
  ok(a.confidence === 'low' && a.checks.name_matches_site === false, 'assess: homepage-declared agency link whose name is not on the site -> low (the MarkUpgrade case)');
  ok(nameMatchesSite('Ashurst Perkins Coie', { domain: 'perkinscoie.com' }) && nameMatchesSite('Miroglio Group', { domain: 'mirogliogroup.com' }) && nameMatchesSite('Gong', { domain: 'gong.io', title: 'Gong - Revenue AI' }) && nameMatchesSite('Align Technology', { domain: 'aligntechnology.com' }), 'name check: real alias cases still pass on domain/title tokens');
  ok(!nameMatchesSite('Global Services Group', { domain: 'acme.com', title: 'Acme' }), 'name check: generic tokens alone never match');
  ok(/Acme Widgets/.test(extractTitle('<html><head><title>Acme Widgets | Home</title><meta property="og:site_name" content="Acme"></head>')), 'extractTitle: reads <title> and og:site_name'); }
ok(assessCandidate(GONG, { domain: 'gong.io', employeesIndexed: 1831, method: 'enrich_by_website' }).confidence === 'low', 'assess: alias website via enrich, not declared -> low');
ok(assessCandidate(ALIGN, { domain: 'aligntechnology.com', finalHost: 'www.aligntech.com', employeesIndexed: 9699 }).confidence === 'high', 'assess: finalHost (redirect target) counts as a website match');
eq(assessCandidate(ES, { domain: 'everyonesocial.com', employeesIndexed: null }).coverage, 'unknown', 'assess: coverage unknown when count not observed');
eq(assessCandidate(ES, { domain: 'everyonesocial.com', employeesIndexed: 5 }).coverage, 'thin', 'assess: coverage thin under 20 indexed');
ok(assessCandidate(null, { domain: 'x.com' }).confidence === 'none', 'assess: no record -> none');
{ const KITCHEN = { id: 6490184, company_name: 'Kitchen Store', website: 'https://www.williams-sonoma.com', employees_count: 9, size_range: '1-10 employees' };
  const a = assessCandidate(KITCHEN, { domain: 'williams-sonoma.com', employeesIndexed: 0 });
  ok(a.confidence === 'low' && a.checks.verifiable === false, 'assess: website match but zero indexed employees -> low (the Kitchen Store case)'); }

// ---- resolve flows ----
{ const { cs, log } = make();
  const r = await cs.resolveCompany({ domain: 'everyonesocial.com', html: '' });
  ok(r.status === 'resolved' && r.confidence === 'high' && r.company_id === 6408815 && r.method === 'enrich_by_website', 'resolve: plain website hit');
  eq(r.credits_used, 20, 'resolve: plain hit costs one enrich (20)');
  ok(r.record?.company_name === 'EveryoneSocial' && r.candidates.length === 1, 'resolve: record carried, one candidate');
  const again = await cs.resolveCompany({ domain: 'www.everyonesocial.com' });
  ok(again.from_cache === true && again.credits_used === 0 && again.company_id === 6408815, 'resolve: second call is a cache hit, 0 credits, www-insensitive');
}
{ const { cs } = make();
  const r = await cs.resolveCompany({ domain: 'gong.io', html: '<a href="https://www.linkedin.com/company/gong-io/">x</a>' });
  ok(r.status === 'resolved' && r.company_id === 11252083 && r.method === 'homepage_linkedin:gong-io' && r.confidence === 'medium', 'resolve: Gong Israel rejected, real Gong found via homepage shorthand');
  ok(r.candidates.length === 2 && r.candidates[0].verdict === 'rejected' && r.candidates[1].verdict === 'accepted', 'resolve: both candidates recorded with verdicts');
  eq(r.credits_used, 40, 'resolve: fallback costs two collects (40)');
}
{ const { cs } = make();
  const r = await cs.resolveCompany({ domain: 'gong.io', html: '' });
  ok(r.status === 'unresolved' && /Gong Israel/.test(r.reason) && /contradicts size_range/.test(r.reason), 'resolve: no shorthand -> unresolved, reason names the subsidiary and why');
  ok(cs.cacheGet('gong.io')?.status === 'unresolved', 'resolve: unresolved is cached (so a retry does not silently spend 20 again)');
}
{ const { cs } = make();
  const r = await cs.resolveCompany({ domain: 'aligntechnology.com', finalHost: 'www.aligntechnology.com', html: HTML });
  ok(r.status === 'resolved' && r.company_id === 8932173 && r.confidence === 'medium', 'resolve: 404 on website, recovered via homepage shorthand (alias domain)');
  ok(r.candidates[0].verdict === 'no record' && r.candidates[0].status === 404, 'resolve: the 404 is recorded, not hidden');
}
{ const { cs } = make();
  const r = await cs.resolveCompany({ domain: 'nobody.example', html: '' });
  ok(r.status === 'unresolved' && r.credits_used === 0 && /no record/.test(r.reason), 'resolve: 404 and no shorthand -> unresolved, 0 credits');
}
{ const { cs } = make({ maxCreditsPerRun: 30 });
  const r = await cs.resolveCompany({ domain: 'gong.io', html: '<a href="https://www.linkedin.com/company/gong-io/">x</a>' });
  ok(r.status === 'ceiling' && r.credits_used === 20 && r.candidates.length === 1, 'resolve: ceiling stops the fallback collect and says so');
  ok(cs.cacheGet('gong.io') === null, 'resolve: a ceiling result is NOT cached');
}
{ const cs = new ActivityIndex({ apiKey: null, baseUrl: 'https://index.example/v2', cacheDir: null });
  const r = await cs.resolveCompany({ domain: 'everyonesocial.com' });
  ok(r.status === 'disabled' && r.credits_used === 0, 'resolve: no key -> disabled, never "unresolved"');
}

// ---- counts: null is not zero ----
{ const { cs } = make();
  const c = await cs.companyCounts(752371, { now: Date.parse('2026-09-16T00:00:00Z') });
  eq(c.since, '2026-06-18', 'counts: 90-day window date');
  ok(c.reshares_of_company_posts_in_window === 105, 'counts: reshares use the NESTED query (flat would be 0)');
  ok(c.company_posts_in_window === 165 && c.employees_indexed === 9903 && c.active_poster_rate_pct === 100, 'counts: rate computed from indexed employees (fixture answers the same count to every employee query)');
  const z = await cs.companyCounts(424242, { now: Date.parse('2026-09-16T00:00:00Z') });
  ok(z.employees_indexed === 0 && z.active_poster_rate_pct === null, 'counts: rate is null when the denominator is 0, not 0%');
  ok(/lower bound/.test(c.note), 'counts: carries the coverage caveat');
  const n = await cs.count('historical_headcount', { match_all: {} });
  ok(n === null, 'counts: a non-200 or header-less search is null, never 0');
  ok(cs.creditsUsed === 0, 'counts: searches cost nothing');
}
{ const { cs } = make();
  const t = await cs.selfTest();
  ok(t.ok === true && t.nested_reshares === 105, 'selftest: positive control passes on the scripted index');
}
ok(COST.company_multi_source === 20 && COST.employee_post === 1, 'cost table matches the provider pricing page (verified 2026-09-16)');



// ---- rubric split (Employee & Culture, behind opts.activity_index) ----
{
  const { scoreEvidence, ACTIVITY_INDEX_MIN_INDEXED } = await import('../lib/rubric.js');
  const { readdirSync } = await import('node:fs');
  const fx = 'zapier.json'; // scorable Employee & Culture; the first fixture alphabetically has no sitemap
  const ev = JSON.parse((await import('node:fs')).readFileSync('fixtures/calib/' + fx, 'utf8'));
  const base = scoreEvidence(ev, { activity_index: false });
  // default (no opts) on evidence WITHOUT a block: same numbers as the pure rubric, plus the not-scored note
  const noblock = scoreEvidence(ev);
  ok(noblock.overall_score === base.overall_score && noblock.categories.employee_culture.basis === 'website' && noblock.categories.employee_culture.notes.some((n) => /no activity-index lookup was made/.test(n)), 'rubric: default on block-less evidence -> same numbers, note says no lookup was made');
  const counts = (o) => ({ window_days: 90, since: '2026-06-18', employees_indexed: 1000, employees_posted_in_window: 61, active_poster_rate_pct: 6.1, decision_makers_posted_in_window: 12, company_posts_in_window: 39, company_posts_all_time: 200, reshares_of_company_posts_in_window: 20, ...o });
  const cs = (o = {}, c = {}) => ({ status: 'resolved', confidence: 'high', coverage: 'ok', company_id: 1, company_name: 'X', method: 'enrich_by_website', record: { employees_count: 1200 }, counts: counts(c), ...o });

  // opted out: identical to the pure website rubric, even with a block present
  const off = scoreEvidence({ ...ev, activity_index: cs() }, { activity_index: false });
  ok(off.overall_score === base.overall_score && off.categories.employee_culture.score === base.categories.employee_culture.score && off.categories.employee_culture.basis === 'website', 'rubric: { activity_index: false } -> pure website rubric, block ignored');

  // flag on, corpus-median counts: the index half scores ~15/50 (percentile anchoring)
  const on = scoreEvidence({ ...ev, activity_index: cs() }, { activity_index: true });
  const ec = on.categories.employee_culture;
  const half = ec.score - base.categories.employee_culture.score / 2;
  ok(ec.basis === 'website+index' && half >= 14 && half <= 16, `rubric: median-company counts score ${half.toFixed(1)}/50 on the index half`);
  ok(ec.components.filter((c) => c.group === 'What the site says').length === 5 && ec.components.filter((c) => c.group === 'What employees do').length === 3, 'rubric: 5 website components halved + 3 index components');
  ok(ec.components.filter((c) => c.group === 'What the site says').reduce((n, c) => n + c.max, 0) === 50 && ec.components.filter((c) => c.group === 'What employees do').reduce((n, c) => n + c.max, 0) === 50, 'rubric: both halves max at 50');
  ok(ec.components.every((c) => c.group !== 'What employees do' || /licensed third-party index/.test(c.evidence)), 'rubric: every index line names its source');
  ok(on.categories.content_supply.score === base.categories.content_supply.score && on.categories.shareability.score === base.categories.shareability.score && on.categories.ai_discoverability.score === base.categories.ai_discoverability.score, 'rubric: the other three categories are untouched');

  // top of the scales
  const top = scoreEvidence({ ...ev, activity_index: cs({}, { active_poster_rate_pct: 25, decision_makers_posted_in_window: 60, company_posts_in_window: 200 }) }, { activity_index: true }).categories.employee_culture;
  ok(Math.abs((top.score - base.categories.employee_culture.score / 2) - 50) < 0.11, 'rubric: 25% rate + 6% DM + 200 posts -> full 50');
  const zero = scoreEvidence({ ...ev, activity_index: cs({}, { active_poster_rate_pct: 0, employees_posted_in_window: 0, decision_makers_posted_in_window: 0, company_posts_in_window: 0 }) }, { activity_index: true }).categories.employee_culture;
  ok(Math.abs(zero.score - base.categories.employee_culture.score / 2) < 0.11 && /none in the index, which is not proof/.test(zero.components.find((c) => /cadence/.test(c.name)).evidence), 'rubric: all-zero counts -> 0/50 and "none in the index" wording');

  // thin coverage: reported, not scored; website half at full scale
  const thin = scoreEvidence({ ...ev, activity_index: cs({}, { employees_indexed: ACTIVITY_INDEX_MIN_INDEXED - 1, employees_posted_in_window: 20, active_poster_rate_pct: 83.3 }) }, { activity_index: true }).categories.employee_culture;
  ok(thin.score === base.categories.employee_culture.score && thin.basis === 'website' && thin.notes.some((n) => /minimum 25/.test(n)) && thin.evidence.activity_index.scored === false, 'rubric: under-minimum index -> website-only at full scale, numbers reported in the note');
  // unresolved: same fallback, reason carried
  const unres = scoreEvidence({ ...ev, activity_index: { status: 'unresolved', reason: 'no record for this website' } }, { activity_index: true }).categories.employee_culture;
  ok(unres.score === base.categories.employee_culture.score && unres.notes.some((n) => /no record for this website/.test(n)), 'rubric: unresolved -> website-only, reason in the note');
  // null count (not observed) is not zero
  const nul = scoreEvidence({ ...ev, activity_index: cs({}, { employees_posted_in_window: null, active_poster_rate_pct: null }) }, { activity_index: true }).categories.employee_culture;
  ok(nul.basis === 'website' && /did not answer/.test(nul.notes.join(' ')), 'rubric: a null count is "not observed", never scored as 0');
}
// ---- evidence block, observeActivity, monthly cap ----
{
  const { evidenceBlock, observeActivity } = await import('../lib/activity-index.js');
  const { cs: idx } = make();
  const r = await idx.resolveCompany({ domain: 'everyonesocial.com', html: '' });
  r.record.company_emails = ['someone@example.com']; r.record.company_updates = new Array(100).fill({ description: 'x' });
  const b = evidenceBlock(r, await idx.companyCounts(r.company_id));
  const json = JSON.stringify(b);
  ok(b.status === 'resolved' && b.company_id === 6408815 && b.counts && b.record_summary && !('record' in b), 'block: carries id, counts and a summary, never the raw record');
  ok(!/company_emails|someone@example|company_updates/.test(json) && json.length < 4000, 'block: no emails, no post bodies, small');
  ok(b.source === 'licensed third-party index' && !/Coresig/i.test(json), 'block: source is generic and the provider is not named');
  const o = await observeActivity(idx, { domain: 'nobody.example', html: '' });
  ok(o.block.status === 'unresolved' && o.not_observed.length === 1 && /could not be matched/.test(o.not_observed[0]), 'observe: unresolved -> block says so, one not_observed line');
  const off = await observeActivity(new ActivityIndex({ apiKey: null, baseUrl: null, cacheDir: null, ledgerPath: null }), { domain: 'x.com' });
  ok(off.block.status === 'disabled' && /no licensed activity index configured/.test(off.not_observed[0]), 'observe: not configured -> disabled, says so');
  const boom = await observeActivity({ enabled: true, resolveCompany: async () => { throw new Error('socket hang up'); } }, { domain: 'x.com' });
  ok(boom.block.status === 'error' && /lookup failed/.test(boom.not_observed[0]), 'observe: a thrown lookup never throws out — error block + not_observed');
}
{
  const { writeFileSync } = await import('node:fs');
  const ledger = join(mkdtempSync(join(tmpdir(), 'led-')), 'credits.json');
  writeFileSync(ledger, JSON.stringify({ month: new Date().toISOString().slice(0, 7), used: 39990 }));
  const log = []; const idx = new ActivityIndex({ apiKey: 'test', baseUrl: 'https://index.example/v2', cacheDir: null, ledgerPath: ledger, monthlyCap: 40000, fetchImpl: fakeFetch(log) });
  const r = await idx.resolveCompany({ domain: 'everyonesocial.com', useCache: false });
  ok(r.status === 'ceiling' && idx.creditsUsed === 0 && log.length === 0, 'monthly cap: a 20-credit call over the cap is refused before any request is made');
  ok((await idx.count('company_post', { match_all: {} })) === 165, 'monthly cap: free searches still work at the cap');
  writeFileSync(ledger, JSON.stringify({ month: '1999-01', used: 999999 }));
  const r2 = await idx.resolveCompany({ domain: 'everyonesocial.com', useCache: false });
  ok(r2.status === 'resolved' && idx.monthlyUsed === 20, 'monthly cap: a stale month resets; the charge is recorded');
}
// ---- findings + lead intel on the new block ----
{
  const { buildFindings } = await import('../lib/findings.js');
  const { leadIntel } = await import('../lib/lead-intel.js');
  const { readFileSync } = await import('node:fs');
  const ev = JSON.parse(readFileSync('fixtures/calib/zapier.json', 'utf8'));
  const block = (c) => ({ source: 'licensed third-party index', status: 'resolved', confidence: 'high', coverage: 'ok', company_id: 1, record_employees_count: 1000, counts: { window_days: 90, since: '2026-06-18', employees_indexed: 803, employees_posted_in_window: 3, active_poster_rate_pct: 0.4, decision_makers_posted_in_window: 0, company_posts_in_window: 0, company_posts_all_time: 0, reshares_of_company_posts_in_window: 0, ...c } });
  const quiet = buildFindings({ ...ev, activity_index: block({}) }, null);
  const ids = quiet.actions.map((f) => f.id);
  ok(ids.includes('employees_quiet') && ids.includes('company_page_quiet'), 'findings: chk.com-shaped counts fire both findings');
  const q = quiet.actions.find((f) => f.id === 'employees_quiet');
  ok(/3 of 803/.test(q.statement) && /median is 6.1%/.test(q.statement) && /lower bound/.test(q.statement) && /third-party/.test(q.statement), 'findings: employees_quiet cites counts, the corpus median and the caveat');
  ok(/prompt to check, not a verdict/.test(quiet.actions.find((f) => f.id === 'company_page_quiet').statement), 'findings: company_page_quiet never calls a zero a verdict');
  const active = buildFindings({ ...ev, activity_index: block({ employees_posted_in_window: 160, active_poster_rate_pct: 19.9, company_posts_in_window: 40 }) }, null).actions.map((f) => f.id);
  ok(!active.includes('employees_quiet') && !active.includes('company_page_quiet'), 'findings: active company fires neither');
  const thin = buildFindings({ ...ev, activity_index: block({ employees_indexed: 20, employees_posted_in_window: 0, active_poster_rate_pct: 0 }) }, null).actions.map((f) => f.id);
  ok(!thin.includes('employees_quiet'), 'findings: under the 25-employee floor, no quiet finding');
  ok(!buildFindings({ ...ev, activity_index: { status: 'unresolved' } }, null).actions.some((f) => /quiet/.test(f.id)), 'findings: unresolved -> nothing');
  const li = leadIntel({ ...ev, activity_index: block({}) }, { domain: 'zapier.com', publicOrigin: 'https://x' });
  ok(li.advocacy_baseline_status === 'measured' && li.advocacy_baseline_rate_pct === 0.4 && li.advocacy_baseline_indexed === 803 && /cleanest advocacy pitch|needs both/.test(li.advocacy_baseline_note), 'lead intel: baseline measured, rep note present');
  const li2 = leadIntel({ ...ev, activity_index: { status: 'unresolved', reason: 'no record' } }, { domain: 'zapier.com', publicOrigin: 'https://x' });
  ok(li2.advocacy_baseline_status === 'unresolved' && li2.advocacy_baseline_rate_pct === null && /not "nobody posts"/.test(li2.advocacy_baseline_note), 'lead intel: unresolved -> null rate, note says so');
  const li3 = leadIntel(ev, { domain: 'zapier.com', publicOrigin: 'https://x' });
  ok(li3.advocacy_baseline_status === 'not_looked_up' && li3.advocacy_baseline_rate_pct === null, 'lead intel: no block -> not_looked_up');
}
console.log(`\n${passed} passed, ${failed} failed (incl. rubric split, findings, lead intel)`);
process.exit(failed ? 1 : 0);
