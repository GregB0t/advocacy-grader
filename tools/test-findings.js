// Proves the findings layer yields concrete, cited findings for BOTH a graded
// and a grade-withheld domain (the withheld state is 74% of visitors), plus a
// blocked-at-root domain and a fast-tier partial probe. Runs entirely on the
// cached calibration evidence — no network.
import { readFileSync } from 'node:fs';
import { scoreEvidence } from '../lib/rubric.js';
import { buildFindings, fastTier } from '../lib/findings.js';

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('ok - ' + name); }
  else { failed++; console.error('FAIL - ' + name); }
}
// Evidence is loaded from out/calib/ (the full 350-domain calibration cache,
// gitignored) when present, falling back to the three committed copies in
// fixtures/calib/ so `npm test` passes on a fresh clone.
const load = (f) => {
  for (const dir of ['../out/calib/', '../fixtures/calib/']) {
    try { return JSON.parse(readFileSync(new URL(dir + f + '.json', import.meta.url))); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  throw new Error(`evidence fixture not found: ${f}.json (looked in out/calib/ and fixtures/calib/)`);
};

// --- grade-withheld domain (the modal case) --------------------------------
{
  const ev = load('wholefoodsmarket.com');
  const s = scoreEvidence(ev);
  ok(!s.gradeable, 'wholefoodsmarket is grade-withheld (precondition)');
  const r = buildFindings(ev, s);
  ok(r.actions.length >= 3, 'withheld domain still yields multiple actionable findings');
  const broken = r.actions.find((f) => f.id === 'broken_og_images');
  ok(broken && broken.severity === 'critical', 'broken og:image detected as critical');
  ok(broken.evidence.urls.some((u) => u.includes('/undefined')), 'broken og:image cites the literal broken URL');
  ok(r.actions[0].id === 'broken_og_images', 'broken og:image ranks first (fixability x impact beats abstractions)');
  const cov = r.limitations.find((f) => f.id === 'classification_coverage');
  ok(cov, 'coverage-gate limitation finding present when the gate fires');
  ok(/limit of this tool's reading/.test(cov.statement) && /not evidence you lack content/.test(cov.statement), "coverage finding is phrased as THIS TOOL's reading limitation, not the company's failure");
  ok(Object.keys(cov.evidence.top_unclassified_prefixes || {}).length > 0, 'coverage finding cites the unread path prefixes');
  ok(r.all.every((f) => f.title && f.statement && f.evidence && typeof f.priority === 'number'), 'every finding carries title, statement, evidence, priority');
  ok(r.actions.every((f) => f.fix), 'every actionable finding carries a fix');
  const dump = JSON.stringify(r);
  ok(!/hiring_pressure|opportunity_gap|buyer_in_seat|approximate_open_reqs/.test(dump), 'no private lead-signal data leaks into findings');
}

// --- graded domain ---------------------------------------------------------
{
  const ev = load('zapier');
  const s = scoreEvidence(ev);
  ok(s.gradeable && s.grade === 'B', 'zapier is graded B (precondition)');
  const r = buildFindings(ev, s);
  ok(r.actions.length >= 2, 'graded domain yields actionable findings too');
  ok(!r.limitations.some((f) => f.id === 'classification_coverage'), 'no coverage finding when the site was actually read');
  ok(r.positives.some((f) => f.id === 'named_authors_present'), 'positives are reported when earned (named authors)');
  ok(r.actions.some((f) => f.id === 'no_culture_pages'), 'zero culture pages surfaces as an opportunity on a well-read site');
}

// --- blocked at root -------------------------------------------------------
{
  const ev = load('consumerportfolioservices.com');
  const s = scoreEvidence(ev);
  const r = buildFindings(ev, s);
  ok(r.limitations.some((f) => f.id === 'blocked_at_root'), 'blocked-at-root yields the balanced-tradeoff limitation finding');
  ok(!r.actions.some((f) => ['no_og_image', 'no_named_authors', 'no_culture_pages'].includes(f.id)), 'no content findings are fabricated for a site we never read');
}

// --- fast-tier partial evidence (what the live phase-1 probe produces) -----
{
  const full = load('wholefoodsmarket.com');
  const partial = { meta: full.meta, robots: full.robots, llms_txt: full.llms_txt, homepage: full.homepage, blocked_at_root: false };
  const r = buildFindings(partial, null); // no scoring on a fast probe
  ok(r.all.length > 0, 'fast-tier partial evidence yields findings without scoring or sitemap data');
  ok(r.all.every((f) => f.tier === 'fast'), 'partial evidence yields only fast-tier findings (nothing fabricated from missing sources)');
  const ft = fastTier(buildFindings(full, scoreEvidence(full)));
  ok([...ft.actions, ...ft.positives, ...ft.limitations, ...ft.info].every((f) => f.tier === 'fast'), 'fastTier() filters a full result down to fast-safe findings');
}

// --- unreachable homepage is a finding, not silence ------------------------
{
  const r = buildFindings({ meta: { resolved_origin: null, origin_attempts: [{ origin: 'https://example.test', status: 403 }] }, blocked_at_root: false }, null);
  ok(r.limitations.some((f) => f.id === 'homepage_unreachable'), 'a source that did not return is itself a finding');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
