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
import { readFileSync } from 'node:fs';
import { scoreEvidence } from '../lib/rubric.js';
import { buildFindings } from '../lib/findings.js';
import { leadIntel, LEAD_INTEL_FIELDS } from '../lib/lead-intel.js';

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
