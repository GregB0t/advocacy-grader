// PRIVATE lead score (spec §4). Never rendered to the visitor.
//
// The design point: hiring pressure is a NEED signal, not a QUALITY signal.
// Grading a company down for growing would be wrong and would read as sloppy,
// so none of this touches the public grade. The two scores share a run and
// nothing else.
//
// The inversion that matters: low grade + high hiring pressure = best prospect.
// Rank on the gap, not the grade.

import { lookupIncumbent } from './incumbent.js';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const r1 = (n) => Math.round(n * 10) / 10;
function scale(value, points) {
  if (value <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1], [x1, y1] = points[i];
    if (value <= x1) return y0 + ((value - x0) / (x1 - x0)) * (y1 - y0);
  }
  return points[points.length - 1][1];
}

export function leadScore(ev, publicScore, { domain = null, incumbentIndex = null } = {}) {
  const L = ev.lead_signals;
  const hiring = L?.hiring || null;
  const self = L?.self_hosted_board || null;
  const cc = ev.classification?.canonical_content;

  const reqs = hiring?.open_reqs ?? self?.approximate_open_reqs ?? null;
  const reqSource = hiring ? 'ATS API' : self ? 'self-hosted careers page (approximate)' : null;
  const velocity = hiring?.posted_last_30d ?? null;

  const components = [];
  let pressure = 0;

  if (reqs === null) {
    components.push({ name: 'Hiring volume', points: 0, max: 35, evidence: 'No open-req count could be observed. Scored zero rather than estimated — absence of a signal is not a low signal.' });
  } else {
    const p = scale(reqs, [[0, 0], [3, 8], [10, 16], [30, 24], [100, 31], [400, 35]]);
    pressure += p;
    components.push({ name: 'Hiring volume', points: r1(p), max: 35, evidence: `${reqs} open req(s) via ${reqSource}` });
  }

  if (velocity === null) {
    components.push({ name: 'Posting velocity', points: 0, max: 20, evidence: hiring ? 'Posting dates were unavailable on these reqs.' : 'No posting dates available from this source.' });
  } else {
    const p = scale(velocity, [[0, 0], [2, 6], [8, 12], [25, 17], [80, 20]]);
    pressure += p;
    components.push({ name: 'Posting velocity', points: r1(p), max: 20, evidence: `${velocity} req(s) posted in the last 30 days` });
  }

  // The strongest single trigger in the category.
  const buyerRoles = hiring?.buyer_in_seat_roles || self?.buyer_in_seat_roles || [];
  const buyerPts = buyerRoles.length ? Math.min(30, 20 + buyerRoles.length * 5) : 0;
  pressure += buyerPts;
  components.push({ name: 'Buyer-in-seat trigger', points: buyerPts, max: 30, evidence: buyerRoles.length
    ? `Hiring for ${buyerRoles.length} role(s) that arrive with an advocacy mandate and no vendor: ${buyerRoles.map((b) => b.title).join('; ')}`
    : 'No employer-brand, talent-brand, internal-comms, corporate-comms or social-media role observed in the open reqs.' });

  const size = scale(cc?.canonical_urls || 0, [[0, 0], [200, 4], [1000, 8], [5000, 12], [20000, 15]]);
  pressure += size;
  components.push({ name: 'Company size proxy', points: r1(size), max: 15, evidence: `${cc?.canonical_urls ?? 0} canonical pages${ev.classification?.localization?.distinct_locales ? `, ${ev.classification.localization.distinct_locales} locales` : ''}` });

  pressure = r1(clamp(pressure));

  const mentions = hiring?.competitor_mentions || [];

  // Incumbent vendor, from the cached white-label app index. Reported, not
  // scored: we have no calibration data on whether an incumbent makes a lead
  // better (proven budget, a programme already sold internally) or worse
  // (locked in a contract), and inventing a weight would be a fabricated
  // finding. It changes the SALES MOTION, which is what the rep needs.
  const incumbent = lookupIncumbent(domain || ev.meta?.normalized_host || ev.meta?.input || null, { indexPath: incumbentIndex });
  const displacement = mentions.length > 0 || incumbent.sales_motion === 'displacement';

  // The inversion. A company scoring F with heavy hiring pressure is the most
  // qualified lead the tool can produce; an A with no hiring is not a prospect.
  const gap = publicScore === null ? null : r1(clamp(pressure * ((100 - publicScore) / 100)));

  // Phase-3 decision, restored 2026-08-29 (the code had drifted from it):
  // absence of hiring data is reported as UNQUALIFIED, never as cold. "Cold"
  // is a judgment about a company we measured; "unqualified" says we could not
  // measure it. With no req source, pressure is just the site-size proxy, so a
  // low gap here describes our visibility, not their need.
  const tier = gap === null ? 'unranked'
    : reqs === null ? 'unqualified'
    : gap >= 45 ? 'hot'
    : gap >= 28 ? 'warm'
    : gap >= 14 ? 'watch'
    : 'cold';

  return {
    visibility: 'PRIVATE — never shown to the visitor. Hiring pressure is a need signal, not a quality signal (spec §4).',
    hiring_pressure: pressure,
    public_score_used: publicScore,
    opportunity_gap: gap,
    tier,
    components,
    displacement_target: displacement,
    displacement_basis: [
      mentions.length ? `${mentions.length} competitor mention(s) in open job descriptions` : null,
      incumbent.status === 'evidence_found' ? `incumbent index: ${incumbent.summary}` : null,
    ].filter(Boolean),
    incumbent,
    competitor_mentions: mentions,
    buyer_in_seat_roles: buyerRoles,
    signal_completeness: {
      req_count_source: reqSource,
      jd_text_available: Boolean(hiring?.reqs_with_full_description),
      displacement_grep_possible: Boolean(hiring?.reqs_with_full_description),
      note: !hiring && self
        ? 'Reqs came from a self-hosted careers page, so there is no job-description text and the competitor/displacement grep could not run. Absence of a competitor mention here is not evidence of absence.'
        : reqs === null ? 'No hiring data at all: no ATS and no readable self-hosted board. The tier is "unqualified" — this company was not measured, not measured-and-found-cold.' : null,
    },
    ranking_note: 'Rank on opportunity_gap, not on grade. Low grade with high hiring pressure is the best prospect the tool can produce.',
    incumbent_note: incumbent.status === 'evidence_found'
      ? `Deliberately NOT folded into opportunity_gap. It changes the pitch, not the priority: ${incumbent.sales_motion === 'displacement' ? 'this is a displacement conversation against a named competitor, not a greenfield one' : 'an adjacent platform is already in place, which proves budget and an internal owner but is not a competing product'}.`
      : incumbent.status === 'no_index_loaded'
      ? 'NOT CHECKED. No incumbent index is loaded in this environment, so no lookup happened. This is not "no incumbent found" -- it is "no search ran". Do not tell a rep anything about this company\'s tooling on the strength of this field.'
      : 'No incumbent found in the index, which is not the same as no incumbent. Do not tell a rep this company has no tooling.',
  };
}
