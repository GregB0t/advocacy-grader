// Lead intelligence for the go-to-market half (phase H). PRIVATE — none of this
// is ever rendered to the visitor.
//
// WHY THIS FILE EXISTS AT ALL. The n8n workflow needs the private lead score and
// the report's own top fix, and it CANNOT fetch them: the evidence bundle lives
// in server.js's in-process cache, and no HTTP route exposes it. Adding one would
// publish private lead scoring over the open internet, which is a new leak rather
// than a fix. So the values are computed at capture time, in-process, and travel
// out with the lead itself.
//
// It lives in lib/ rather than inside server.js on purpose: `npm test` does not
// import server.js, so anything in there is untested by construction — and this
// is precisely the code where a number could quietly start being invented.
//
// 🔴 THE RULE (spec §7). Every field below is either something this tool actually
// observed for THIS domain, or null. No placeholder, no default, no "N/A" string
// that an email template could render as if it were a finding. In particular:
// when the tool produced no top fix, top_fix_* are null and the 48h follow-up has
// nothing to claim — which is the correct outcome, not a failure to handle.
import { scoreEvidence } from './rubric.js';
import { buildFindings } from './findings.js';
import { leadScore } from './lead-score.js';

// Shape is fixed whether or not evidence was available, so the receiving Data
// table always gets the same columns. Absence is expressed as null, never as a
// value that reads like a measurement.
const EMPTY = {
  evidence_available: false,
  gradeable: false,
  grade: null,
  public_score: null,
  withheld_reason: null,
  lead_tier: null,
  opportunity_gap: null,
  hiring_pressure: null,
  lead_signal_note: null,
  incumbent_status: null,
  top_fix_id: null,
  top_fix_title: null,
  top_fix_statement: null,
  top_fix_action: null,
  top_fix_severity: null,
  report_url: null,
  intel_note: null,
};

export function leadIntel(evidence, { domain = null, publicOrigin = null } = {}) {
  const reportUrl = domain && publicOrigin
    ? publicOrigin.replace(/\/+$/, '') + '/report/' + encodeURIComponent(domain)
    : null;

  if (!evidence) {
    return {
      ...EMPTY,
      report_url: reportUrl,
      intel_note: 'No evidence bundle was in cache when this lead was captured, so no score, grade or fix could be computed for it. Nothing here is estimated.',
    };
  }

  try {
    const scoring = scoreEvidence(evidence);
    // leadScore takes the PUBLIC score, and null when no grade was earned. Passing
    // a number here for a withheld domain would manufacture an opportunity_gap out
    // of a grade the tool declined to issue.
    const publicScore = scoring.gradeable ? scoring.overall_score : null;
    const ls = leadScore(evidence, publicScore, { domain });
    // actions[0] is the report's own highest-priority finding, sorted by
    // priority = impact * (6 - effort). The follow-up email names THIS, so the
    // email and the report can never disagree about what matters most.
    const top = buildFindings(evidence, scoring).actions[0] || null;

    return {
      evidence_available: true,
      gradeable: Boolean(scoring.gradeable),
      grade: scoring.gradeable ? scoring.grade : null,
      public_score: scoring.gradeable ? scoring.overall_score : null,
      withheld_reason: scoring.gradeable ? null : scoring.withheld_reason,
      lead_tier: ls.tier,
      opportunity_gap: ls.opportunity_gap,
      hiring_pressure: ls.hiring_pressure,
      // Says which signals were absent, in the lead-score module's own words.
      // null when every signal fired, which is the honest reading of "no caveat".
      lead_signal_note: ls.signal_completeness?.note ?? null,
      incumbent_status: ls.incumbent?.status ?? null,
      top_fix_id: top?.id ?? null,
      top_fix_title: top?.title ?? null,
      top_fix_statement: top?.statement ?? null,
      top_fix_action: top?.fix ?? null,
      top_fix_severity: top?.severity ?? null,
      report_url: reportUrl,
      intel_note: null,
    };
  } catch (err) {
    // A thrown scorer must never take the lead down with it. The lead is the
    // irreplaceable part; the score is not.
    return {
      ...EMPTY,
      evidence_available: true,
      report_url: reportUrl,
      intel_note: 'Lead intelligence could not be computed: ' + String(err?.message || err) + '. The lead itself was captured normally.',
    };
  }
}

export const LEAD_INTEL_FIELDS = Object.keys(EMPTY);
