# Advocacy Grade

Give it a company domain and it produces an evidence-cited report on how ready that
company's public web presence is for an employee-advocacy program — whether there is
anything worth sharing, whether shared links render properly, whether employees are
visible on the content, and whether AI crawlers can read any of it.

Advocacy leaderboards rank companies on the *outcome* (how many employees posted on
LinkedIn last month). This tool measures the *inputs*: the publicly observable,
fixable conditions on the company's own website. It never touches LinkedIn and it
cannot tell you whether anyone will actually post — see [Honest limitations](#honest-limitations).

## What a report contains

1. **Findings first.** Concrete, cited, ranked by fixability × impact — "31 of your
   pages have a literal `/undefined` og:image URL", not "improve your social presence".
   Every finding carries the evidence counts and the URLs it came from.
2. **A letter grade, only when it is earned.** Four categories: Content Supply (30%),
   Shareability (25%), Employee & Culture (25%), AI Discoverability (20%). Scoring is
   deterministic code (`lib/rubric.js`), not a model call — the same domain always
   gets the same grade, and every point traces to fetched evidence.

**The grade is withheld most of the time, on purpose.** In the 350-domain calibration
corpus only 91 domains (26%) receive a letter grade. The main reason is us, not them:
the URL classifier keys on common English content-path shapes (`/blog/`,
`/resources/`, …) and cannot yet read enterprise-CMS or non-English sitemaps. When
more than half of a site's URLs are unclassified, a grade computed from the sliver we
did read would report our reading gap as their failure — so the report says "we could
not read enough of your site", names the unread paths, and withholds the letter.
Withheld is not failed; the findings still ship.

## Honest limitations

- **The weights are editorial judgment.** Nobody has demonstrated that these four
  categories cause employees to post. They are the conditions we can observe and you
  can fix — presented as exactly that, never as a validated model of advocacy.
- **LinkedIn (the actual advocacy outcome) is not measured.** Readiness ≠ reach.
- **The classifier is English-first and modern-SaaS-shaped.** Enterprise CMS paths
  (`/corp/en/about.html`), locale prefixes, and non-English sections mostly land in
  "unclassified" — which is why the coverage gate exists and why the no-grade rate is
  ~74% on a cross-sector corpus. Reading these sites better is the top of the roadmap.
- **~36% of a grade rides on 24 sampled pages** (deterministic, stratified — but a
  sample).
- **Employee & Culture partly measures where HR content is hosted**, not culture
  itself (a company whose handbook lives on a subdomain outside its sitemap is
  understated).
- **AI Discoverability rarely goes low** — most sites don't block AI crawlers, so its
  observed floor across the corpus is ~48/100. It differentiates less than the other
  categories.
- **No AI assigns any number.** With an `ANTHROPIC_API_KEY` present, Claude rephrases
  the findings prose (rejected if it introduces numbers that weren't there); without
  one, deterministic prose ships. The scores are identical either way.

## Running it

Requires Node 20+. **Zero runtime dependencies** — `npm install` has nothing to do.

```
git clone <repo> && cd advocacy-grader
npm test                      # 65 offline assertions, no network, no key needed
node score.js example.com     # collect evidence + score one domain (writes JSON)
npm run serve                 # live server on :8787 — lookup UI, cached corpus, API
npm run setup                 # optional: prompt for a ScrapingBee key, verify, write .env
```

- **No key needed for most sites.** Fetches are direct, with an honest identifying
  User-Agent, and robots.txt is checked before every URL. A ScrapingBee key
  (`.env.example`) is used only to retry sites that 403 honest direct fetches; if a
  site's robots.txt disallows us, we stop and say so — the report then covers
  robots.txt only. No spoofed browser UAs anywhere.
- `npm run rescore` re-derives scores for a directory of stored evidence files —
  scores are always computed at read time from evidence, never persisted, so rubric
  changes propagate everywhere instantly.
- `site/` holds 350 pre-built static reports (`tools/build-site.js`). Rebuilding them
  needs the calibration evidence cache (`out/calib/`, not in the repo — it is ~350
  fetched-evidence files); three sample evidence files live in `fixtures/calib/` so
  the test suite runs from a fresh clone.

## Architecture in brief

```
score.js / server.js / tools/build-site.js
        └── lib/run.js         one collection pipeline for CLI, server and builder
              ├── lib/http.js  fetch layer: honest UA, SSRF-guarded at socket connect
              │                (lib/ssrf.js), manual re-validated redirects
              ├── lib/robots.js + robots-registry.js   per-host robots + AI-crawler posture
              ├── lib/sitemap.js → lib/classify.js → lib/sample.js → lib/page.js
              │                sitemap discovery → URL sectioning → deterministic
              │                stratified sample (n=24) → per-page evidence
              ├── lib/homepage.js, lib/ats.js          homepage + public careers surface
              └── evidence JSON (fetch-logged, no scores inside)
        └── lib/rubric.js      deterministic scoring + the coverage gate (read-time)
        └── lib/findings.js    ranked, cited findings — works on full, partial,
                               grade-withheld and blocked-at-root evidence
        └── lib/narrate.js     optional Claude seam: rephrase-only, guarded, falls
                               back to deterministic prose
server.js adds: two-phase lookup (~1s fast probe, full run queued), 30-day evidence
cache, per-IP rate limits, Turnstile-optional email gate, lead capture to
out/leads.jsonl + optional webhook.
```

`data/` is a separate research artifact: an index of which companies appear as
customers on advocacy/comms vendors' own public marketing pages and app-store
listings, with per-row evidence tiers. It deliberately refuses to score "incumbency"
without outcome data, and it never enters any grade.

`data/` is **not distributed with this repository** — it is gitignored, and it feeds
only the private lead score, never the public grade, findings or reports. A fresh
clone has no index; `lib/incumbent.js` then reports it missing and the lead score
carries no incumbent signal. Everything else runs unchanged. Set `INCUMBENT_INDEX`
to point at a copy if you have one (see `.env.example`).

Evidence files carry a private `lead_signals` block (public careers-page
reachability, detected ATS). It never renders in any public report — that separation
is enforced by tests.

## Tests

`npm test` runs 65 assertions, fully offline: coverage-gate boundaries, withheld-grade
wording, the single-count rule for shareability signals, floor/sampler agreement, lead
tiers, robots contradiction logic, findings on graded / withheld / blocked / partial
evidence, a no-leak check that private lead data never reaches findings, and the URL
classifier against a labelled ground-truth fixture (`fixtures/classifier-groundtruth.json`)
— including negative cases asserting that tempting-but-unsafe URL shapes stay
unclassified, and a printed coverage + shareable-section precision summary.
