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
const make = (opts = {}) => { const log = []; const cs = new ActivityIndex({ apiKey: 'test', baseUrl: 'https://index.example/v2', cacheDir: mkdtempSync(join(tmpdir(), 'cs-')), fetchImpl: fakeFetch(log), ...opts }); return { cs, log }; };

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



console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
