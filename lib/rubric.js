// Deterministic scoring. Every component is a pure function of the evidence
// bundle, so the same domain always produces the same grade — the same
// requirement that forced deterministic sampling (decision 3).
//
// The model does NOT assign numbers here. R5 warns that open-ended judgment
// drifts between runs, and a grade that moves when the model changes is a grade
// nobody can defend to the person being graded. Claude's job is the qualitative
// careers-page read and the findings prose, on top of these numbers.
//
// Weights follow spec §3 as revised: Content Supply 30, Shareability 25,
// Employee & Culture 25, AI Discoverability 20.

export const WEIGHTS = { content_supply: 0.30, shareability: 0.25, employee_culture: 0.25, ai_discoverability: 0.20 };
export const BANDS = [['A', 85], ['B', 70], ['C', 55], ['D', 40], ['F', 0]];

export const MIN_VIABLE_SHAREABLE = 30; // below this a program has nothing to run on

// Classification-coverage gate. The classifier keys off common content path
// shapes and silently buckets everything else as "unclassified". On enterprise
// CMS, non-English and retail sites that bucket can be most of the sitemap —
// wholefoodsmarket.com had 7,175 of 7,238 URLs unclassified while its sitemap
// held thousands of recipes. A letter grade computed from the sliver we could
// read reports OUR reading gap as THEIR failure, which §7 forbids. Thresholds
// were chosen from a sweep over all 350 calibration evidence files (see
// tools/rescore.js and the 2026-08-29 build notes): at >=50% unclassified the
// unread majority is overwhelmingly real content the classifier missed, not
// transactional noise; below 30% the classifier demonstrably read the site and
// a thin result is a real finding (staffmark.com: 8% unclassified, 2 shareable
// pages — a true low grade). Between those, a sub-floor shareable pool means
// the floor test itself is untrustworthy.
export const COVERAGE_GATE = {
  max_unclassified_share_pct: 50,
  small_pool_unclassified_share_pct: 30,
  small_pool: MIN_VIABLE_SHAREABLE,
};

// The sampler draws from the junk-filtered canonical list (NON_SHAREABLE_PATH
// pruned), while classification counts shareable sections before that filter.
// The sampler's pool is the honest "shareable" number, so wherever it was
// recorded it wins; the two disagree on 14 of the 350 calibration domains.
function effectiveShareable(ev) {
  const cc = ev.classification?.canonical_content;
  const counted = cc?.shareable_url_count || 0;
  const pool = ev.shareability?.sampling?.pool_size;
  return typeof pool === 'number' ? Math.min(counted, pool) : counted;
}

export function classificationCoverage(ev) {
  const c = ev.classification;
  const total = c?.total_urls_classified || 0;
  if (!total) return null;
  const unclassified = c.sections?.unclassified || 0;
  const sharePct = Math.round((unclassified / total) * 1000) / 10;
  const pool = effectiveShareable(ev);
  const insufficient =
    sharePct >= COVERAGE_GATE.max_unclassified_share_pct ||
    (pool < COVERAGE_GATE.small_pool && sharePct >= COVERAGE_GATE.small_pool_unclassified_share_pct);
  return { total_urls: total, unclassified_urls: unclassified, unclassified_share_pct: sharePct, shareable_pool: pool, insufficient };
}

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const r1 = (n) => Math.round(n * 10) / 10;

// Piecewise-linear band scale. Explicit and inspectable, unlike a tuned curve.
function scale(value, points) {
  if (value <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1], [x1, y1] = points[i];
    if (value <= x1) return y0 + ((value - x0) / (x1 - x0)) * (y1 - y0);
  }
  return points[points.length - 1][1];
}

const SHAREABLE_SECTIONS = ['blog', 'case_study', 'resource', 'guide_ebook', 'news_press', 'event_webinar', 'podcast_video', 'culture'];

// ---------------------------------------------------------------- 1. Content Supply
function contentSupply(ev) {
  const cc = ev.classification?.canonical_content;
  if (!cc) return { score: null, scorable: false, reason: 'No sitemap URLs were retrieved, so content volume could not be measured.', components: [], evidence: {} };

  // 2026-08-29 audit fix: the sampler prunes NON_SHAREABLE_PATH junk (event
  // terms, sweepstakes, registration pages) before drawing, but the classifier
  // counts those paths in shareable_url_count. The floor test and the sampler
  // must agree on what "shareable" means, so the junk-filtered pool wins here.
  const shareable = effectiveShareable(ev);
  const junkExcluded = (cc.shareable_url_count || 0) - shareable;
  const sectionsPresent = SHAREABLE_SECTIONS.filter((s) => (cc.sections?.[s] || 0) > 0);
  const sharePct = junkExcluded > 0 && cc.canonical_urls
    ? Math.round((shareable / cc.canonical_urls) * 1000) / 10
    : cc.shareable_share_pct || 0;

  // Decision 1: volume is a floor test, not a linear scale.
  const volume = scale(shareable, [[0, 0], [10, 3], [30, 10], [100, 18], [400, 26], [1500, 33], [5000, 40]]);
  const diversity = scale(sectionsPresent.length, [[0, 0], [1, 4], [2, 9], [3, 14], [4, 19], [5, 24], [6, 27], [8, 30]]);
  const share = scale(sharePct, [[0, 0], [10, 4], [25, 10], [45, 16], [65, 23], [85, 30]]);

  let base = volume + diversity + share;
  const components = [
    { name: 'Volume floor', points: r1(volume), max: 40, evidence: `${shareable} shareable pages after collapsing localized duplicates${junkExcluded > 0 ? ` and excluding ${junkExcluded} non-shareable page(s) (terms, sweepstakes, registration and similar)` : ''}` },
    { name: 'Section diversity', points: r1(diversity), max: 30, evidence: `${sectionsPresent.length} shareable section(s): ${sectionsPresent.join(', ') || 'none'}` },
    { name: 'Shareable share', points: r1(share), max: 30, evidence: `${sharePct}% of the canonical inventory is shareable content` },
  ];

  // Recency only participates when it can be trusted (see phase-1 findings).
  const rec = ev.sitemaps?.recency;
  let recencyNote, confidence = 'full';
  if (rec?.recency_measurable) {
    const fresh = rec.urls_with_lastmod ? (rec.updated_last_365d / rec.urls_with_lastmod) * 100 : 0;
    const adj = scale(fresh, [[0, -8], [10, -4], [25, 0], [50, 4], [80, 8]]);
    base += adj;
    components.push({ name: 'Recency adjustment', points: r1(adj), max: 8, evidence: `${rec.updated_last_365d} of ${rec.urls_with_lastmod} dated URLs updated in the last year (${Math.round(fresh)}%)` });
    recencyNote = null;
  } else {
    confidence = 'reduced';
    recencyNote = rec?.lastmod_looks_machine_generated
      ? 'Recency was not scored: this site publishes lastmod dates, but they look machine-generated rather than edit history, so they cannot be read as freshness.'
      : 'Recency was not scored: this sitemap carries no lastmod dates at all. Content freshness is not observable here and has not been guessed at.';
  }

  const belowFloor = shareable < MIN_VIABLE_SHAREABLE;
  let score = clamp(base);
  if (belowFloor) score = Math.min(score, 25);

  return {
    score: r1(score), scorable: true, confidence, components,
    floor_failed: belowFloor,
    notes: [recencyNote, belowFloor ? `Fewer than ${MIN_VIABLE_SHAREABLE} shareable pages: there is not enough material for an advocacy program to run on, which caps this category regardless of quality.` : null].filter(Boolean),
    evidence: { canonical_shareable: shareable, canonical_total: cc.canonical_urls, shareable_share_pct: sharePct, sections_present: sectionsPresent, collapsed_by_localization: cc.collapsed_by_localization },
  };
}

// ---------------------------------------------------------------- 2. Shareability
// Each signal is measured in exactly one category (2026-08-29 audit fix):
// named_author moved wholly to Employee & Culture (it measures whether
// employees are visible as humans on content, and it already carried 25 there —
// counting it here too put 11.25% of the whole grade on one measurement).
// article_schema moved wholly to AI Discoverability (it measures machine
// parseability, and structured data is where that category's discrimination
// lives). og_complete was dropped: it re-counted og_image plus title and
// description, which are now measured once each from their own stored
// aggregates. The freed weight stays inside this category, on the two things
// that decide how a shared link actually renders and whether sharing is
// invited: the OG card fields and a visible share control.
// twitter_card and canonical are kept at token weight only: the project's own
// signal research found no evidence either affects whether an employee shares
// a page (X falls back to OG tags; canonical is an SEO hygiene signal). They
// are reported because they are observed, but they no longer move the grade.
const SHARE_WEIGHTS = [
  ['og_image', 35, 'Open Graph image — without one, a shared link renders as a bare grey box'],
  ['og_title', 15, 'Open Graph title on the shared card'],
  ['og_description', 15, 'Open Graph description on the shared card'],
  ['share_affordance', 30, 'A visible share control on the page'],
  ['twitter_card', 3, 'Twitter/X card tags (near-zero weight: X falls back to Open Graph)'],
  ['canonical', 2, 'Canonical URL (near-zero weight: SEO hygiene, not a sharing condition)'],
];

function shareability(ev) {
  const sh = ev.shareability;
  if (!sh?.aggregates || !sh.pages_retrieved) {
    return { score: null, scorable: false, components: [],
      reason: sh ? `None of the ${sh.pages_attempted ?? 0} sampled content pages could be retrieved, so this category was not scored.` : 'No content pages were sampled.',
      evidence: {} };
  }
  const a = sh.aggregates;
  let score = 0;
  const components = SHARE_WEIGHTS.map(([key, weight, label]) => {
    const pct = a[key]?.pct ?? 0;
    const pts = (pct / 100) * weight;
    score += pts;
    return { name: label, points: r1(pts), max: weight, evidence: `${a[key]?.n ?? 0} of ${sh.pages_retrieved} sampled pages (${pct}%)` };
  });

  const partial = sh.pages_retrieved < sh.pages_attempted;
  return {
    score: r1(clamp(score)), scorable: true,
    confidence: partial ? 'reduced' : 'full',
    components,
    notes: partial ? [`${sh.pages_retrieved} of ${sh.pages_attempted} sampled pages were retrieved; these percentages describe only the pages actually read.`] : [],
    evidence: { sample_method: sh.sampling?.method, sample_size: sh.pages_retrieved, pool_size: sh.sampling?.pool_size, allocation: sh.sampling?.allocation },
  };
}

// ---------------------------------------------------------------- 3. Employee & Culture Surface
const EMPLOYEE_STORY_RE = /(life-at|life_at|employee-(story|stories|spotlight|profile)|meet-the-team|our-people|team-member|culture|day-in-the-life|why-i-joined|inside-)/i;

function employeeCulture(ev) {
  const cc = ev.classification?.canonical_content;
  if (!cc) return { score: null, scorable: false, reason: 'No sitemap URLs were retrieved.', components: [], evidence: {} };

  const cultureUrls = cc.sections?.culture || 0;
  const careersUrls = cc.sections?.careers || 0;
  const careersOk = (ev.lead_signals?.careers_pages_checked || []).some((c) => c.ok);
  const cultureSamples = ev.classification?.section_samples?.culture || [];
  const storyUrls = cultureSamples.filter((u) => EMPLOYEE_STORY_RE.test(u)).length;
  const authorPct = ev.shareability?.aggregates?.named_author?.pct ?? null;

  const cultureScore = scale(cultureUrls, [[0, 0], [1, 8], [3, 16], [10, 24], [30, 30]]);
  const careersScore = careersOk ? 15 : 0;
  const careersDepth = scale(careersUrls, [[0, 0], [1, 5], [5, 10], [20, 15]]);
  const authorScore = authorPct === null ? 0 : (authorPct / 100) * 25;
  const storyScore = scale(storyUrls, [[0, 0], [1, 8], [3, 15]]);

  const components = [
    { name: 'Culture / life-at pages', points: r1(cultureScore), max: 30, evidence: `${cultureUrls} culture page(s) in the canonical inventory` },
    { name: 'Careers page reachable', points: careersScore, max: 15, evidence: careersOk ? 'A careers page was found and retrieved' : 'No careers page could be retrieved' },
    { name: 'Careers depth', points: r1(careersDepth), max: 15, evidence: `${careersUrls} careers URL(s) in the sitemap` },
    { name: 'Named authors on content', points: r1(authorScore), max: 25, evidence: authorPct === null ? 'Not measured — no content pages were retrieved' : `${authorPct}% of sampled pages carry a named author` },
    { name: 'Employee-story signals', points: r1(storyScore), max: 15, evidence: cultureSamples.length
      ? `${storyUrls} of ${cultureSamples.length} sampled culture URL(s) match employee-story patterns (life-at, employee spotlight, meet-the-team)`
      : 'No culture URLs existed to sample, so no employee-story signal could be checked' },
  ];

  const unscored = authorPct === null;
  return {
    score: r1(clamp(cultureScore + careersScore + careersDepth + authorScore + storyScore)),
    scorable: true,
    confidence: unscored ? 'reduced' : 'full',
    components,
    notes: [
      unscored ? 'Named-author coverage could not be measured because no content pages were retrieved; that component scored zero rather than being estimated.' : null,
      'A qualitative read of the careers page (boilerplate vs. real human stories) is not included in this number.',
    ].filter(Boolean),
    evidence: { culture_urls: cultureUrls, careers_urls: careersUrls, careers_retrieved: careersOk, employee_story_matches: storyUrls, culture_urls_sampled: cultureSamples.length, named_author_pct: authorPct },
  };
}

// ---------------------------------------------------------------- 4. AI Discoverability
// R2 order of real weight: crawler access, then Content-Signal coherence, then
// structured data. llms.txt is detected and reported at weight ZERO.
const AI_ACCESS_WEIGHTS = { search: 3, 'user-fetch': 3, train: 1, render: 1 };

function aiDiscoverability(ev) {
  const posture = ev.robots?.ai_posture;
  if (!ev.robots?.present) {
    return { score: null, scorable: false, components: [],
      reason: 'No usable robots.txt was retrieved, so AI-agent posture is unknown for this domain. Unknown is not the same as open, and it has not been scored as open.',
      evidence: {} };
  }

  let got = 0, total = 0;
  for (const a of posture.agents) {
    const w = AI_ACCESS_WEIGHTS[a.kind] ?? 1;
    total += w;
    if (a.root_allowed) got += w;
  }
  const accessPct = total ? (got / total) * 100 : 0;
  const access = (accessPct / 100) * 45;

  const signals = posture.content_signals || [];
  const contradictions = posture.contradictions || [];
  let coherence, coherenceEvidence;
  if (!signals.length) { coherence = 9; coherenceEvidence = 'No Content-Signal declared. Neither a grant nor a restriction — scored neutrally.'; }
  else if (contradictions.length) { coherence = 3; coherenceEvidence = `Content-Signal "${contradictions[0].signal ?? signals[0].raw}" grants a use that requires reading the site, while ${(contradictions[0].blocked_agents || posture.blocked_agents || []).length} AI user-agent(s) of exactly the kind that grant depends on are disallowed from reading it: ${(contradictions[0].blocked_agents || []).join(', ')}.`; }
  else { coherence = 15; coherenceEvidence = `Content-Signal "${signals[0].raw}" is consistent with the crawl directives.`; }

  const homeTypes = ev.homepage?.json_ld_types?.length || 0;
  const articlePct = ev.shareability?.aggregates?.article_schema?.pct ?? null;
  const homeSchema = scale(homeTypes, [[0, 0], [1, 4], [3, 8], [6, 12], [10, 15]]);
  const artSchema = articlePct === null ? 0 : (articlePct / 100) * 25;
  const structured = homeSchema + artSchema;

  const components = [
    { name: 'AI crawler access', points: r1(access), max: 45, evidence: posture.blocked_count ? `${posture.blocked_count} of ${posture.agents.length} tracked AI user-agents are disallowed at the site root: ${posture.blocked_agents.join(', ')}` : `All ${posture.agents.length} tracked AI user-agents are permitted at the site root` },
    { name: 'Content-Signal coherence', points: coherence, max: 15, evidence: coherenceEvidence },
    { name: 'Structured data', points: r1(structured), max: 40, evidence: `${homeTypes} schema.org type(s) on the homepage; ${articlePct === null ? 'article schema not measured' : `${articlePct}% of sampled content pages carry Article schema`}` },
    { name: 'llms.txt', points: 0, max: 0, evidence: ev.llms_txt?.present ? 'Present. Scored at zero weight deliberately: Google has said it does not support llms.txt, no major AI vendor has confirmed consuming it, and large-scale studies found no correlation with AI citations.' : 'Not present. This costs nothing — the evidence that llms.txt affects anything is weak.' },
  ];

  return {
    score: r1(clamp(access + coherence + structured)), scorable: true,
    confidence: articlePct === null ? 'reduced' : 'full',
    components,
    notes: [
      'robots.txt compliance is voluntary and advisory. This reports the declared policy; it is not a claim that any crawler was actually blocked.',
      posture.matches_cloudflare_default_blocklist ? 'The blocked-agent list exactly matches Cloudflare’s one-click "block AI bots" default, which often means a toggle was flipped rather than a policy decided.' : null,
    ].filter(Boolean),
    evidence: { blocked_agents: posture.blocked_agents, blocked_count: posture.blocked_count, content_signals: signals.map((s) => s.raw), contradictions: contradictions.length, llms_txt_present: Boolean(ev.llms_txt?.present), matches_cloudflare_default: posture.matches_cloudflare_default_blocklist },
  };
}

export function scoreEvidence(ev) {
  const categories = {
    content_supply: contentSupply(ev),
    shareability: shareability(ev),
    employee_culture: employeeCulture(ev),
    ai_discoverability: aiDiscoverability(ev),
  };

  const scorable = Object.entries(categories).filter(([, c]) => c.scorable);
  const unscorable = Object.entries(categories).filter(([, c]) => !c.scorable);

  // Decision 4: when we were blocked at the root, or too little is observable,
  // no letter grade is issued. An F earned by being unreadable is a fabricated
  // verdict, not a finding.
  const blocked = Boolean(ev.blocked_at_root);
  const coverage = classificationCoverage(ev);
  const unreadable = Boolean(coverage?.insufficient);
  const gradeable = !blocked && !unreadable && scorable.length === 4;

  // Coverage gate: the classification-derived categories were computed from a
  // sliver of the site, so they are floors, not measurements. Say so on each.
  if (unreadable) {
    for (const key of ['content_supply', 'shareability', 'employee_culture']) {
      const cat = categories[key];
      if (!cat.scorable) continue;
      cat.confidence = 'reduced';
      (cat.notes ??= []).push(
        `Low-coverage caveat: ${coverage.unclassified_urls} of ${coverage.total_urls} sitemap URLs (${coverage.unclassified_share_pct}%) could not be classified, so this score describes only the ${coverage.shareable_pool} page(s) that could be read and section-sorted. It is a floor, not a measurement of the whole site.`
      );
    }
  }

  let overall = null, grade = null;
  if (gradeable) {
    overall = r1(scorable.reduce((n, [k, c]) => n + c.score * WEIGHTS[k], 0));
    grade = BANDS.find(([, min]) => overall >= min)[0];
  }

  return {
    gradeable,
    overall_score: overall,
    grade,
    bands: Object.fromEntries(BANDS),
    weights: WEIGHTS,
    categories,
    unscorable_categories: unscorable.map(([k, c]) => ({ category: k, reason: c.reason })),
    classification_coverage: coverage,
    withheld_reason: gradeable ? null : blocked
      ? 'This site disallows this crawler at the root, so only its robots.txt could be read. A letter grade would be an invented verdict rather than a measurement, so none is issued.'
      : unreadable
      ? `No letter grade is issued because this tool could not read this site's content structure: of the ${coverage.total_urls} URLs in its sitemap, ${coverage.unclassified_urls} (${coverage.unclassified_share_pct}%) could not be classified into content sections by the reader${coverage.shareable_pool < COVERAGE_GATE.small_pool ? `, and only ${coverage.shareable_pool} page(s) could be confirmed as shareable content` : ''}. That is a limit of this tool's reading, not evidence that the company lacks content — a grade computed from the readable sliver would report a gap in this tool as their failure. What could be observed is scored below at reduced confidence.`
      : `No letter grade is issued because ${unscorable.length} of 4 categories could not be observed. The categories that were measurable are scored below.`,
    confidence: scorable.some((c) => c[1].confidence === 'reduced') ? 'reduced' : 'full',
    method_note: 'Scores are computed by a fixed rubric in code, not by a language model, so the same evidence always yields the same grade. Every component cites the observation behind it.',
  };
}
