// Regression tests for the 2026-08-29 audit fixes. Run: npm test
// Guards: the classification-coverage gate (a site the classifier could not
// read must never receive a letter grade), the single-count rule for
// shareability signals, the junk-filtered floor test, the unqualified lead
// tier, and the kind-keyed robots contradiction.
import assert from 'node:assert/strict';
import { scoreEvidence, COVERAGE_GATE, MIN_VIABLE_SHAREABLE } from '../lib/rubric.js';
import { leadScore } from '../lib/lead-score.js';
import { parseRobots, aiPosture } from '../lib/robots.js';

function evidence({ total = 1000, unclassified = 100, shareable = 400, poolSize = undefined, blocked = false } = {}) {
  const canonical = total - 5;
  return {
    blocked_at_root: blocked,
    classification: {
      total_urls_classified: total,
      sections: { unclassified, blog: shareable },
      shareable_url_count: shareable,
      canonical_content: {
        canonical_urls: canonical,
        sections: { unclassified, blog: shareable },
        shareable_url_count: shareable,
        shareable_share_pct: canonical ? Math.round((shareable / canonical) * 1000) / 10 : 0,
      },
      section_samples: { culture: [] },
    },
    sitemaps: { recency: { recency_measurable: false } },
    shareability: {
      pages_attempted: 24,
      pages_retrieved: 24,
      sampling: { method: 'deterministic_stratified', pool_size: poolSize ?? shareable, allocation: { blog: 24 } },
      aggregates: {
        og_image: { n: 20, pct: 83.3 }, og_title: { n: 22, pct: 91.7 }, og_description: { n: 21, pct: 87.5 },
        og_complete: { n: 18, pct: 75 }, share_affordance: { n: 6, pct: 25 }, twitter_card: { n: 12, pct: 50 },
        canonical: { n: 24, pct: 100 }, article_schema: { n: 10, pct: 41.7 }, named_author: { n: 8, pct: 33.3 },
      },
    },
    lead_signals: { careers_pages_checked: [{ ok: true }] },
    homepage: { json_ld_types: ['Organization', 'WebSite'] },
    llms_txt: { present: false },
    robots: {
      present: true,
      ai_posture: {
        agents: [
          { user_agent: 'GPTBot', vendor: 'OpenAI', kind: 'train', root_allowed: true },
          { user_agent: 'OAI-SearchBot', vendor: 'OpenAI', kind: 'search', root_allowed: true },
        ],
        content_signals: [], contradictions: [], blocked_count: 0, blocked_agents: [],
        matches_cloudflare_default_blocklist: false,
      },
    },
  };
}

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

// ---- Task A: the coverage gate ----
test('readable site with all categories observable gets a letter grade', () => {
  const s = scoreEvidence(evidence({ total: 1000, unclassified: 100, shareable: 400 }));
  assert.equal(s.gradeable, true);
  assert.ok(s.grade && s.overall_score !== null);
});

test('unreadable site (majority unclassified) is withheld, names the numbers, does not blame the company', () => {
  const s = scoreEvidence(evidence({ total: 7238, unclassified: 7175, shareable: 6 }));
  assert.equal(s.gradeable, false);
  assert.equal(s.grade, null);
  assert.equal(s.overall_score, null);
  assert.match(s.withheld_reason, /7238/);
  assert.match(s.withheld_reason, /7175/);
  assert.match(s.withheld_reason, /99\.1%/);
  assert.match(s.withheld_reason, /not evidence that the company lacks content/);
  assert.equal(s.classification_coverage.insufficient, true);
});

test('withheld site still reports what IS observable, at reduced confidence', () => {
  const s = scoreEvidence(evidence({ total: 7238, unclassified: 7175, shareable: 6 }));
  assert.equal(s.categories.ai_discoverability.scorable, true);
  assert.ok(s.categories.ai_discoverability.score > 0);
  assert.equal(s.categories.content_supply.confidence, 'reduced');
  assert.ok(s.categories.content_supply.notes.some((t) => /Low-coverage caveat/.test(t)));
  assert.equal(s.confidence, 'reduced');
});

test('threshold: exactly at max_unclassified_share_pct withholds; just under does not', () => {
  const at = scoreEvidence(evidence({ total: 1000, unclassified: 500, shareable: 300 }));
  assert.equal(at.gradeable, false);
  const under = scoreEvidence(evidence({ total: 1000, unclassified: 499, shareable: 300 }));
  assert.equal(under.gradeable, true);
  assert.equal(COVERAGE_GATE.max_unclassified_share_pct, 50);
});

test('small shareable pool + moderate unclassified share withholds (the floor test cannot be trusted)', () => {
  const s = scoreEvidence(evidence({ total: 1000, unclassified: 350, shareable: 10 }));
  assert.equal(s.gradeable, false);
  assert.match(s.withheld_reason, /10 page\(s\) could be confirmed/);
});

test('control: a well-read, genuinely thin site keeps its low grade (Home Depot logic)', () => {
  // 8% unclassified: the classifier read the site; thin content is a finding.
  const s = scoreEvidence(evidence({ total: 5000, unclassified: 400, shareable: 40 }));
  assert.equal(s.gradeable, true);
  assert.ok(s.grade);
});

test('blocked_at_root still withholds exactly as before', () => {
  const s = scoreEvidence(evidence({ blocked: true }));
  assert.equal(s.gradeable, false);
  assert.match(s.withheld_reason, /disallows our user-agent/);
});

// ---- Task B1/B2: single-count shareability ----
test('named_author, article_schema and og_complete no longer appear in Shareability', () => {
  const s = scoreEvidence(evidence({}));
  const names = s.categories.shareability.components.map((c) => c.name).join(' | ');
  assert.doesNotMatch(names, /author|Article|Complete Open Graph/i);
});

test('shareability weights sum to 100 and dead weight is near-zero', () => {
  const s = scoreEvidence(evidence({}));
  const comps = s.categories.shareability.components;
  assert.equal(comps.reduce((a, c) => a + c.max, 0), 100);
  const dead = comps.filter((c) => /Twitter|Canonical/i.test(c.name)).reduce((a, c) => a + c.max, 0);
  assert.ok(dead <= 5, `twitter+canonical carry ${dead} points`);
});

test('named_author still counts once, in Employee & Culture', () => {
  const s = scoreEvidence(evidence({}));
  const ec = s.categories.employee_culture.components.find((c) => /author/i.test(c.name));
  assert.ok(ec && ec.max === 25);
});

// ---- Task B3: floor test agrees with the sampler ----
test('volume floor uses the junk-filtered sampler pool, not the raw section count', () => {
  // Classifier counted 45 "shareable" URLs but 20 were junk paths the sampler pruned.
  const s = scoreEvidence(evidence({ total: 1000, unclassified: 100, shareable: 45, poolSize: 25 }));
  assert.equal(s.categories.content_supply.floor_failed, true, `pool 25 < ${MIN_VIABLE_SHAREABLE} must fail the floor`);
  const noJunk = scoreEvidence(evidence({ total: 1000, unclassified: 100, shareable: 45, poolSize: 45 }));
  assert.equal(noJunk.categories.content_supply.floor_failed, false);
});

// ---- Task B4: unqualified lead tier ----
test('no hiring data yields tier unqualified, never cold', () => {
  const l = leadScore(evidence({}), 55);
  assert.equal(l.tier, 'unqualified');
});

test('measured hiring data with a low gap is still cold; no public score is unranked', () => {
  const ev = evidence({});
  ev.lead_signals.hiring = { open_reqs: 2, posted_last_30d: 0, buyer_in_seat_roles: [] };
  assert.equal(leadScore(ev, 90).tier, 'cold');
  assert.equal(leadScore(evidence({}), null).tier, 'unranked');
});

// ---- Task B5: contradiction keys on the blocked agent's kind ----
test('blocking only training bots with search=yes is coherent, not a contradiction', () => {
  const robots = parseRobots(['User-agent: GPTBot', 'Disallow: /', '', 'User-agent: CCBot', 'Disallow: /', '', 'User-agent: *', 'Content-Signal: search=yes, ai-train=no', 'Disallow:'].join('\n'));
  const p = aiPosture(robots);
  assert.ok(p.blocked_count >= 2, 'training bots are blocked');
  assert.equal(p.contradictions.length, 0);
});

test('blocking a search-kind agent while declaring search=yes IS a contradiction', () => {
  const robots = parseRobots(['User-agent: OAI-SearchBot', 'Disallow: /', '', 'User-agent: *', 'Content-Signal: search=yes', 'Disallow:'].join('\n'));
  const p = aiPosture(robots);
  assert.equal(p.contradictions.length, 1);
  assert.deepEqual(p.contradictions[0].blocked_agents.includes('OAI-SearchBot'), true);
  assert.ok(!p.contradictions[0].blocked_agents.includes('GPTBot'));
});

console.log(`\n${n} tests passed`);
