// Optional narrative layer over the deterministic findings.
//
// Detection is code; phrasing MAY go through Claude. This module is the seam:
// narrateFindings() returns the findings unchanged when no API key is
// configured (the deterministic statements are complete sentences and ship as
// the product), and when a key exists it asks Claude to rewrite ONLY the
// prose — never to add, remove, reorder or re-rank findings, and never to
// introduce a number or URL that is not already in the evidence.
//
// Everything works without one; set ANTHROPIC_API_KEY to turn this on. Any API
// failure falls back to the deterministic text — a report must never fail
// because a model did.
//
// 🔴 THE FAILURE MODE THIS MODULE HAS TO STAY HONEST ABOUT: falling back is
// SILENT by design, so a wrong key, a retired model or a rate limit produces a
// perfectly good report that simply contains no model output. `narrated` and
// `narrate_note` on the returned object are the only evidence either way, and
// the caller is responsible for surfacing them. server.js logs the failure note
// so "the key is set" is never mistaken for "the model ran".

// PINNED, not the floating `claude-sonnet-4-5` alias. Anthropic's own guidance:
// an alias "points to the most recent dated snapshot", so the model underneath
// can change without a deploy -- and this call's whole job is to rephrase
// findings without altering them. Verified 2026-09-01 against the deprecation
// list: claude-sonnet-4-5-20250929 is Active.
const MODEL = 'claude-sonnet-4-5-20250929';
const API = 'https://api.anthropic.com/v1/messages';

export async function narrateFindings(findingsResult, { apiKey = process.env.ANTHROPIC_API_KEY, domain = null, timeoutMs = 20000, fetchImpl = fetch } = {}) {
  if (!apiKey) return { ...findingsResult, narrated: false, narrate_note: 'No ANTHROPIC_API_KEY configured; deterministic statements shipped as-is.' };

  const items = findingsResult.actions.slice(0, 8).map((f, i) => ({ i, title: f.title, statement: f.statement, fix: f.fix }));
  const prompt = `You are polishing findings for a website-readiness report about ${domain || 'a company'}. For each finding below, rewrite "statement" and "fix" to be tighter and more direct. HARD RULES: keep every number, count, percentage and URL exactly as given; add no facts, no numbers, no URLs, no speculation; keep the factual, non-mocking tone; never write the words we, us or our — this tool is one person, so use I for a judgment or a promise and impersonal phrasing for an observation; one short paragraph each. Return ONLY a JSON array of {"i": <index>, "statement": "...", "fix": "..."}.\n\n${JSON.stringify(items, null, 1)}`;

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetchImpl(API, {
      method: 'POST', signal: ctl.signal,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    const text = data.content?.map((c) => c.text || '').join('') || '';
    const parsed = JSON.parse(text.replace(/^```json?\s*|\s*```$/g, ''));
    // 🔴 MUST BE AN ARRAY. `JSON.parse('"some text"')` yields a STRING, and
    // `for...of` over a string iterates its CHARACTERS — every one of which
    // misses the actions lookup and is skipped, so the function used to return
    // narrated:true having applied nothing at all. That made the only signal
    // anyone has about whether the model ran into a false positive.
    if (!Array.isArray(parsed)) throw new Error('model did not return a JSON array');
    const actions = findingsResult.actions.map((f) => ({ ...f }));
    let applied = 0;
    for (const p of parsed) {
      const f = actions[p.i];
      if (!f || typeof p.statement !== 'string') continue;
      // GUARD: no rewrite may introduce a number the deterministic text did not
      // already contain. Rejection is per-finding: the original statement stands.
      //
      // 🔴 THE OLD GUARD DID NOT DO THIS. It joined the source numbers into one
      // string and asked `numsBefore.includes(n)`, a SUBSTRING test -- so with a
      // source containing 506, an invented "50" passed, because "506" contains
      // "50". It also checked `statement` only and let `fix` through unchecked,
      // even though the fix text ships in the report and in the 48h email.
      // Whole-token comparison over BOTH fields now.
      //
      // Dropping a number is deliberately still allowed: "2 of 24 sampled pages"
      // legitimately rephrases to "few of the sampled pages". Inventing one is
      // what spec §7 forbids.
      const tokens = (str) => (String(str).match(/\d+(?:[.,]\d+)*/g) || []);
      const known = new Set([...tokens(f.statement), ...tokens(f.fix || '')]);
      const invents = (str) => tokens(str).some((n) => !known.has(n));
      if (invents(p.statement)) continue;
      if (typeof p.fix === 'string' && invents(p.fix)) continue;
      f.narrative = p.statement;
      if (typeof p.fix === 'string' && f.fix) f.narrative_fix = p.fix;
      applied++;
    }
    // narrated:true has to mean a rewrite actually reached the report. If every
    // candidate was rejected by the guard, no model text ships and saying
    // otherwise would misreport this tool's own behaviour.
    if (!applied) throw new Error('no rewrite survived the number guard; nothing was applied');
    return { ...findingsResult, actions, narrated: true, narrate_note: null };
  } catch (err) {
    return { ...findingsResult, narrated: false, narrate_note: `Narrative call failed (${err.message}); deterministic statements shipped instead.` };
  }
}
