// Lead-intelligence tests (phase H). Run: npm test
//
// WHY THIS SUITE EXISTS. lib/lead-intel.js is the join between the grader and the
// go-to-market half: it hands n8n a grade, a private lead tier and a "top fix"
// that a follow-up email will state to a stranger as fact. Spec §7 applies to
// anything that leaves the building, so the failure this suite guards against is
// not a crash — it is a field that quietly acquires a plausible value the tool
// never observed.
//
// The two assertions that matter most:
//   - top_fix_* must EQUAL the report's own actions[0], computed independently
//     here. If they ever diverge, the email and the report disagree about what
//     matters most on the same site, and one of them is lying.
//   - a withheld domain must carry a null grade AND a null public_score. Feeding
//     a number into leadScore for a domain the rubric refused to grade would
//     manufacture an opportunity_gap out of a verdict that was never issued.
//
// Fixtures-first, per K2: pinned to fixtures/calib/, never to mutable out/calib/.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoreEvidence } from '../lib/rubric.js';
import { buildFindings } from '../lib/findings.js';
import { leadIntel, LEAD_INTEL_FIELDS } from '../lib/lead-intel.js';
import { lookupIncumbent } from '../lib/incumbent.js';

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('ok - ' + name); }
  else { failed++; console.error('FAIL - ' + name); }
}
const load = (f) => {
  for (const dir of ['../fixtures/calib/', '../out/calib/']) {
    try { return JSON.parse(readFileSync(new URL(dir + f + '.json', import.meta.url))); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  throw new Error('evidence fixture not found: ' + f + '.json');
};
const ORIGIN = 'https://greg-o-matic.com';

// --- a GRADED domain --------------------------------------------------------
{
  const ev = load('zapier');
  const s = scoreEvidence(ev);
  ok(s.gradeable, 'zapier fixture is gradeable (precondition)');
  const i = leadIntel(ev, { domain: 'zapier.com', publicOrigin: ORIGIN });

  ok(i.evidence_available === true, 'graded: evidence_available true');
  ok(i.gradeable === true && i.grade === s.grade, 'graded: grade matches the rubric, not a copy');
  ok(i.public_score === s.overall_score, 'graded: public_score is the rubric overall_score');
  ok(i.withheld_reason === null, 'graded: no withheld_reason on a graded domain');
  ok(i.report_url === ORIGIN + '/report/zapier.com', 'graded: report_url built from the configured origin');

  // The anti-invention assertion.
  const top = buildFindings(ev, s).actions[0];
  ok(i.top_fix_id === top.id, 'top fix id equals the report’s own highest-priority action');
  ok(i.top_fix_title === top.title, 'top fix title is the report’s wording verbatim');
  ok(i.top_fix_action === top.fix, 'top fix action is the report’s fix text verbatim');
  ok(i.top_fix_statement === top.statement, 'top fix statement is the report’s statement verbatim');
}

// --- a GRADE-WITHHELD domain (the modal case: ~2 of every 3 in the corpus) ---
{
  const ev = load('wholefoodsmarket.com');
  const s = scoreEvidence(ev);
  ok(!s.gradeable, 'wholefoodsmarket fixture is grade-withheld (precondition)');
  const i = leadIntel(ev, { domain: 'wholefoodsmarket.com', publicOrigin: ORIGIN });

  ok(i.grade === null, 'withheld: grade is null, never a letter');
  ok(i.public_score === null, 'withheld: public_score is null, never a number');
  ok(typeof i.withheld_reason === 'string' && i.withheld_reason.length > 40,
    'withheld: carries the rubric’s own reason, so an email can say why');
  // The documented consequence of the coverage gate. Recorded as a test so that
  // if phase J ever changes it, the change is deliberate and visible.
  ok(i.opportunity_gap === null && i.lead_tier === 'unranked',
    'withheld: opportunity_gap null and tier "unranked" — the gate’s known side effect');
  // A withheld domain is still a real report with real findings. The follow-up
  // must still have something true to name.
  ok(typeof i.top_fix_title === 'string' && i.top_fix_title.length > 0,
    'withheld: a top fix is still produced — no grade is not no findings');
}

// --- NO EVIDENCE: every derived field must be null, not defaulted ------------
{
  const i = leadIntel(null, { domain: 'example.com', publicOrigin: ORIGIN });
  ok(i.evidence_available === false, 'no evidence: evidence_available false');
  const derived = ['grade', 'public_score', 'withheld_reason', 'lead_tier', 'opportunity_gap',
    'hiring_pressure', 'lead_signal_note', 'incumbent_status',
    'top_fix_id', 'top_fix_title', 'top_fix_statement', 'top_fix_action', 'top_fix_severity'];
  ok(derived.every((k) => i[k] === null), 'no evidence: every derived field is null');
  ok(typeof i.intel_note === 'string' && /no evidence bundle/i.test(i.intel_note),
    'no evidence: intel_note says plainly why, so a template is never left guessing');
  ok(i.report_url === ORIGIN + '/report/example.com', 'no evidence: report_url still resolves');
}

// --- NO PLACEHOLDER STRINGS ANYWHERE ----------------------------------------
// A field reading "N/A" or "unknown" renders in an email exactly like a finding.
// Absence must be null so a merge field is visibly empty.
{
  const bad = /^(n\/?a|none|unknown|null|undefined|-|tbd)$/i;
  for (const [label, i] of [
    ['no evidence', leadIntel(null, { domain: 'x.com', publicOrigin: ORIGIN })],
    ['withheld', leadIntel(load('wholefoodsmarket.com'), { domain: 'w.com', publicOrigin: ORIGIN })],
    ['graded', leadIntel(load('zapier'), { domain: 'z.com', publicOrigin: ORIGIN })],
  ]) {
    ok(!Object.values(i).some((v) => typeof v === 'string' && bad.test(v.trim())),
      label + ': no placeholder string stands in for a missing measurement');
  }
}

// --- SHAPE IS STABLE --------------------------------------------------------
// The Data table has fixed columns; a field that appears only sometimes would
// leave a row silently short.
{
  const a = leadIntel(null, { domain: 'x.com', publicOrigin: ORIGIN });
  const b = leadIntel(load('zapier'), { domain: 'z.com', publicOrigin: ORIGIN });
  ok(LEAD_INTEL_FIELDS.every((k) => k in a) && LEAD_INTEL_FIELDS.every((k) => k in b),
    'every declared field is present in both the empty and the populated shape');
  ok(Object.keys(a).length === Object.keys(b).length,
    'populated and empty results carry the same key set');
}

// --- THE INCUMBENT INDEX: "NOT CHECKED" IS NOT "CHECKED AND FOUND NOTHING" --
// The bug this guards against shipped to production and wrote itself into real
// lead rows. lib/incumbent.js returned status 'no_evidence_in_index' and the
// sentence "Nothing found for X in the incumbent index" in BOTH cases: when the
// index was loaded and the domain was genuinely absent, AND when no index was
// loaded at all. The second is a claim that a search ran. No search ran.
// Spec section 7 rule 3.
//
// The fixture is INVENTED here at run time, not read from data/. data/ is
// gitignored and holds the real scraped index; no part of it is committed, and
// no assertion below depends on it existing.
{
  const dir = mkdtempSync(join(tmpdir(), 'advg-incumbent-'));
  const tiny = {
    schema: 1,
    built_at: '2020-01-01T00:00:00.000Z',
    domains: {
      'known-customer.example': [{
        vendor_name: 'Fictional Advocacy Co', vendor_key: 'fictional', vendor_tier: 'advocacy',
        confidence: 'confirmed', confidence_basis: 'invented for this test',
        evidence: { source: 'test', app_name: 'Test App', bundle_id: 'com.example.test',
                    developer_account: 'Fictional Advocacy Co', app_url: 'https://example.com/app',
                    last_updated: '2025-06-01T00:00:00.000Z' },
      }],
    },
    rows: [], counts: {},
  };
  const plain = join(dir, 'tiny-index.json');
  const gz = join(dir, 'tiny-index.json.gz');
  const b64 = join(dir, 'tiny-index.json.gz.b64');
  const body = JSON.stringify(tiny);
  writeFileSync(plain, body);
  writeFileSync(gz, gzipSync(Buffer.from(body)));
  // Written with embedded newlines on purpose: a value pasted into Render's
  // secret-file textarea can pick up wrapping, and the loader must not care.
  writeFileSync(b64, gzipSync(Buffer.from(body)).toString('base64').replace(/(.{76})/g, '$1\n'));

  const noIndex = lookupIncumbent('anything.example', { indexPath: join(dir, 'does-not-exist.json') });
  const realMiss = lookupIncumbent('anything.example', { indexPath: plain });
  const realHit = lookupIncumbent('known-customer.example', { indexPath: plain });

  ok(noIndex.status === 'no_index_loaded' && noIndex.index_loaded === false,
    'no index loaded: status is "no_index_loaded", not a miss');
  ok(realMiss.status === 'no_evidence_in_index' && realMiss.index_loaded === true,
    'index loaded, domain absent: status is "no_evidence_in_index"');
  ok(noIndex.status !== realMiss.status,
    'the two are DISTINGUISHABLE — this is the whole point of the fix');
  ok(!/nothing found/i.test(noIndex.summary) && /never looked up|no search/i.test(noIndex.summary),
    'no index loaded: the summary never claims a search happened');
  ok(realHit.status === 'evidence_found' && realHit.matches.length === 1 && realHit.index_loaded === true,
    'index loaded, domain present: the found path still works');

  // A .gz index must be inflated on read and produce a byte-identical result.
  // The real index is ~5.2MB uncompressed, over Render's documented 1MB
  // combined secret-file cap; gzipped it fits, which is the only reason the
  // incumbent signal can exist in production at all.
  const gzHit = lookupIncumbent('known-customer.example', { indexPath: gz });
  const gzMiss = lookupIncumbent('anything.example', { indexPath: gz });
  ok(JSON.stringify(gzHit) === JSON.stringify(realHit),
    'a gzipped index yields a byte-identical result to the plain one (hit)');
  ok(JSON.stringify(gzMiss) === JSON.stringify(realMiss),
    'a gzipped index yields a byte-identical result to the plain one (miss)');

  // .gz.b64 is the form that actually reaches production. Render's secret-file
  // UI is a paste-in Contents field for plaintext, so raw gzip bytes cannot
  // survive it; gzip-then-base64 can. Suffixes peel right to left.
  const b64Hit = lookupIncumbent('known-customer.example', { indexPath: b64 });
  ok(JSON.stringify(b64Hit) === JSON.stringify(realHit),
    'a gzip+base64 index yields a byte-identical result, newlines and all');

  // And the value has to survive the whole way out to the lead row, because the
  // Data table column is where the false claim was actually being recorded.
  const withNoIndex = leadIntel(load('zapier'), {
    domain: 'zapier.com', publicOrigin: ORIGIN, incumbentIndex: join(dir, 'does-not-exist.json'),
  });
  const withIndex = leadIntel(load('zapier'), {
    domain: 'zapier.com', publicOrigin: ORIGIN, incumbentIndex: plain,
  });
  ok(withNoIndex.incumbent_status === 'no_index_loaded',
    'lead row records "no_index_loaded" when no index is configured');
  ok(withIndex.incumbent_status === 'no_evidence_in_index',
    'lead row records "no_evidence_in_index" when an index was searched and missed');
}

// --- A BROKEN SCORER MUST NOT COST A LEAD -----------------------------------
{
  let threw = false;
  let i = null;
  try { i = leadIntel({ garbage: true }, { domain: 'x.com', publicOrigin: ORIGIN }); }
  catch { threw = true; }
  ok(!threw, 'malformed evidence never throws out of leadIntel');
  ok(i && i.report_url === ORIGIN + '/report/x.com', 'malformed evidence still yields a usable row');
}

console.log(`\n${passed} tests passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
