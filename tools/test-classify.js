// Classifier tests against the labelled ground-truth fixture (K1, 2026-08-31).
// Run: npm test
//
// Two things are measured and printed, because "unclassified dropped" is only
// half a result:
//   COVERAGE  — share of labelled URLs the classifier assigns a section.
//   PRECISION — of the URLs the classifier puts in a SHAREABLE section, the
//               share whose label agrees. Shareable sections feed the score,
//               so this is the number the honesty rules care about. It must
//               be 100% on this set.
// The negative cases are the point: tempting-but-unsafe shapes must STAY
// unclassified, because a wrong section is a fabricated observation and
// unclassified is an honest answer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyUrls, SHAREABLE_SECTIONS } from '../lib/classify.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

const fixture = JSON.parse(readFileSync(new URL('../fixtures/classifier-groundtruth.json', import.meta.url), 'utf8'));

// Classify each group's URLs together, as production does, so per-host locale
// sibling evidence (false-friend promotion) is available, then read the URL's
// section out of section_samples.
function sectionOf(url, groupUrls) {
  const all = groupUrls.map((u) => ({ loc: u }));
  const res = classifyUrls(all);
  for (const [section, samples] of Object.entries(res.section_samples || {})) {
    if (samples.includes(url)) return section;
  }
  // The URL was not among the ≤3 samples for its section. Re-run with the url
  // FIRST so it is guaranteed to be sampled: order changes samples only, and
  // classification of each URL is order-independent (promotion is a pre-scan
  // over the whole set).
  const reordered = [url, ...groupUrls.filter((u) => u !== url)].map((u) => ({ loc: u }));
  const res2 = classifyUrls(reordered);
  for (const [section, samples] of Object.entries(res2.section_samples || {})) {
    if (samples.includes(url)) return section;
  }
  throw new Error(`could not locate section for ${url}`);
}

let labelled = 0;
let classified = 0;
let shareableAssigned = 0;
let shareableCorrect = 0;
const failures = [];

for (const group of fixture.groups) {
  const groupUrls = group.urls.map((u) => u.url);
  for (const { url, expect } of group.urls) {
    const got = sectionOf(url, groupUrls);
    labelled++;
    if (got !== 'unclassified') classified++;
    if (SHAREABLE_SECTIONS.includes(got)) {
      shareableAssigned++;
      if (got === expect) shareableCorrect++;
    }
    if (got !== expect) failures.push({ group: group.name, url, expect, got });
  }
}

test('every ground-truth label matches (positive and negative cases)', () => {
  assert.deepEqual(failures, [], `mismatches:\n${failures.map((f) => `  [${f.group}] ${f.url}\n    expected ${f.expect}, got ${f.got}`).join('\n')}`);
});

test('precision on shareable sections is 100% — nothing enters the score wrongly', () => {
  assert.equal(shareableCorrect, shareableAssigned);
});

const expectedClassified = fixture.groups.flatMap((g) => g.urls).filter((u) => u.expect !== 'unclassified').length;
test('coverage matches the labels exactly (no over- OR under-classification)', () => {
  assert.equal(classified, expectedClassified);
});

// ---- ordering guarantee: catalog rules can never shadow a content rule ----
test('catalog rules run after content rules: /recipes never becomes catalog_listing', () => {
  const res = classifyUrls([{ loc: 'https://x.com/recipes/vegan-chili' }]);
  assert.equal(res.sections.recipe, 1);
  assert.equal(res.sections.catalog_listing || 0, 0);
});
test('/stores is locations (locator), /store is catalog (inventory)', () => {
  const res = classifyUrls([{ loc: 'https://x.com/stores/denver' }, { loc: 'https://x.com/store/item-1' }]);
  assert.equal(res.sections.locations, 1);
  assert.equal(res.sections.catalog_listing, 1);
});

// ---- new buckets are not shareable ----
test('catalog_listing, locations and cms_cruft are not shareable sections', () => {
  for (const s of ['catalog_listing', 'locations', 'cms_cruft']) assert.ok(!SHAREABLE_SECTIONS.includes(s));
});
test("'recipe' IS a shareable section (K1 decision: retailer recipe programmes are editorial)", () => {
  assert.ok(SHAREABLE_SECTIONS.includes('recipe'));
});

// ---- rubric agreement: the two SHAREABLE_SECTIONS copies must not drift ----
test('lib/rubric.js and lib/classify.js agree on what is shareable', async () => {
  const rubricSrc = readFileSync(new URL('../lib/rubric.js', import.meta.url), 'utf8');
  const m = /const SHAREABLE_SECTIONS = \[([^\]]+)\]/.exec(rubricSrc);
  assert.ok(m, 'rubric.js SHAREABLE_SECTIONS not found');
  const rubricList = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  assert.deepEqual(rubricList, SHAREABLE_SECTIONS);
});

// ---- gate arithmetic: catalog classification lowers unclassified share ----
test('catalog inventory no longer inflates the unclassified share', () => {
  const urls = [];
  for (let i = 0; i < 60; i++) urls.push({ loc: `https://shop.example.com/store/item-${i}` });
  for (let i = 0; i < 30; i++) urls.push({ loc: `https://shop.example.com/blog/post-${i}` });
  for (let i = 0; i < 10; i++) urls.push({ loc: `https://shop.example.com/mystery/page-${i}` });
  const res = classifyUrls(urls);
  assert.equal(res.sections.catalog_listing, 60);
  assert.equal(res.sections.unclassified, 10);
  assert.equal(res.shareable_url_count, 30);
});

// ---- K1 schema: histograms + deterministic URL sample ----
test('path_prefixes carries complete depth-1/2 histograms with caps recorded', () => {
  const urls = [{ loc: 'https://x.com/a/b/c' }, { loc: 'https://x.com/a/b/d' }, { loc: 'https://x.com/e' }];
  const res = classifyUrls(urls);
  assert.equal(res.path_prefixes.depth1['/a'], 2);
  assert.equal(res.path_prefixes.depth1['/e'], 1);
  assert.equal(res.path_prefixes.depth2['/a/b'], 2);
  assert.equal(res.path_prefixes.depth1_truncated, false);
  assert.equal(res.path_prefixes.cap_per_depth, 1000);
});
test('url_sample is deterministic, capped, and complete when under the cap', () => {
  const urls = Array.from({ length: 10 }, (_, i) => ({ loc: `https://x.com/page-${String(i).padStart(2, '0')}` }));
  const a = classifyUrls(urls);
  const b = classifyUrls([...urls].reverse());
  assert.deepEqual(a.url_sample.urls, b.url_sample.urls, 'sample must not depend on input order');
  assert.equal(a.url_sample.sampled, 10);
  assert.equal(a.url_sample.complete, true);
  assert.equal(a.url_sample.cap, 2000);
});
test('url_sample strides deterministically above the cap', () => {
  const urls = Array.from({ length: 250 }, (_, i) => ({ loc: `https://x.com/p-${String(i).padStart(3, '0')}` }));
  const res = classifyUrls(urls, { urlSampleCap: 100 });
  assert.equal(res.url_sample.stride, 3);
  assert.ok(res.url_sample.sampled <= 100);
  assert.equal(res.url_sample.complete, false);
  assert.equal(res.url_sample.urls[0], 'https://x.com/p-000');
  assert.equal(res.url_sample.urls[1], 'https://x.com/p-003');
});

// ---- localization mechanics ----
test('false-friend promotion is recorded in localization.false_friends_promoted', () => {
  const res = classifyUrls([
    { loc: 'https://www.avetta.com/it/about' },
    { loc: 'https://www.avetta.com/de/about' },
    { loc: 'https://www.avetta.com/fr-ca/about' },
  ]);
  assert.deepEqual(res.localization.false_friends_promoted, { 'www.avetta.com': ['it'] });
});
test('no promotion without sibling or TLD evidence — /it stays a section path', () => {
  const res = classifyUrls([
    { loc: 'https://consulting-example.com/it/managed-services' },
    { loc: 'https://consulting-example.com/blog/post' },
  ]);
  assert.equal(res.localization.false_friends_promoted, null);
  assert.equal(res.sections.unclassified, 1);
});
test('English variant becomes the canonical representative for sampling', () => {
  const res = classifyUrls([
    { loc: 'https://x.com/de/blog/post-1' },
    { loc: 'https://x.com/blog/post-1' },
    { loc: 'https://x.com/en/blog/post-1' },
  ]);
  assert.equal(res.canonical_content.canonical_urls, 1);
  const rep = res.canonicalList.find((c) => c.key.endsWith('/blog/post-1'));
  assert.equal(rep.url, 'https://x.com/en/blog/post-1');
});

console.log(`${n} tests passed`);
const coveragePct = Math.round((classified / labelled) * 1000) / 10;
const precisionPct = shareableAssigned ? Math.round((shareableCorrect / shareableAssigned) * 1000) / 10 : 100;
console.log(`ground truth: ${labelled} labelled URLs | coverage ${classified}/${labelled} classified (${coveragePct}%) | shareable-section precision ${shareableCorrect}/${shareableAssigned} (${precisionPct}%)`);
