# Landing page: the "isn't this just a leaderboard?" section

Placement: directly under the domain input and the grade reveal, above the email gate.
A visitor who knows the category will have this objection within ten seconds of landing.
Answering it before they ask is what buys the rest of the page.

Rewritten 2026-08-29 after audit. Two changes from the first draft, both deliberate:
the causal claim is gone (we observe conditions; we have never linked them to posting
outcomes, so we don't say they "decide" anything), and every figure now comes from this
project's own 350-company scoring run rather than any competitor's published data.
Numbers marked `[PLACEHOLDER: ...]` must be filled from a fresh `node tools/rescore.js`
at launch — the distribution moved when the coverage gate landed and may move again.

---

## Headline — pick one

A. Leaderboards tell you the score. This shows you what's on the table.
B. You already know your number is low. This shows you what your company gives people to work with.

Recommend A. It concedes the leaderboard genre's value in four words and takes the next
sentence for itself, which is a stronger move than arguing.

---

## Body

Employee advocacy leaderboards rank companies by the share of their employees who post.
They're genuinely useful and you should read them. But a ranking can't tell you what to
change on Monday.

That's the gap this fills. A leaderboard measures the outcome — did your people post.
This looks at something different and more modest: the conditions we can actually
observe on your public website, every one of them something you can fix.

- **Content supply.** Is there anything worth sharing?
- **Shareability.** When someone does share it, does it survive the trip?
- **Employee and culture surface.** Are there pages a person would put their own name on?
- **AI discoverability.** Can machines find, read, and cite you?

To be straight about what this is: nobody has proven these four things cause employees
to post — no such study exists, and we haven't run one. They are the observable,
fixable inputs an advocacy program draws on, weighted by editorial judgment about what
matters most, not by measurement. Every score cites the specific public evidence it
came from, so you can check any of it yourself.

We've run this grader against [PLACEHOLDER: total, currently 350] real companies across
sectors. Most striking finding: [PLACEHOLDER: pct C or below among graded, currently
86%] of the companies we could fully read graded C or below — almost nobody's public
site is set up for this. And for [PLACEHOLDER: withheld count, currently 259 of 350]
we refused to issue a grade at all, mostly because our reader couldn't parse the site's
content structure — we'd rather say "we couldn't read you" than dress a reading gap up
as your failure.

One thing this deliberately does not do: claim to measure your employees' posting.
LinkedIn doesn't permit that access, and a free tool that says otherwise is either
paying an enrichment vendor or estimating and hoping you don't ask. What I can see is
what your company has handed its people to work with — and so can you, which is the
point.

---

## Short version — for the results page or a meta description

Leaderboards rank you on how many employees post. This grades what you've given them to
post about — content supply, shareability, culture surface, and AI discoverability, with
the evidence cited.

---

## Figure discipline

- Every number in this section must come from this project's own scoring run
  (`tools/rescore.js` over `out/calib/`), be dated, and be phrased as what it is: a
  cross-sector sample we assembled, not an industry census.
- No competitor's published statistics anywhere in this copy, quoted or paraphrased.
  Their outcome data is not an input to this project — not in scores, not in marketing.
- State the denominator honestly. "X of the N companies we could fully read" — never
  let a percentage quietly drop the sites we withheld grades on; the withheld share IS
  one of the findings.
- Re-run the numbers before launch and replace every `[PLACEHOLDER]`. If the rubric or
  the coverage gate changes after that, re-run them again.
