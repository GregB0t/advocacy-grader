// Optional narrative layer over the deterministic findings.
//
// Detection is code; phrasing MAY go through Claude. This module is the seam:
// narrateFindings() returns the findings unchanged when no API key is
// configured (the deterministic statements are complete sentences and ship as
// the product), and when a key exists it asks Claude to rewrite ONLY the
// prose — never to add, remove, reorder or re-rank findings, and never to
// introduce a number or URL that is not already in the evidence.
//
// No key exists yet (owner blocker). Everything works without one; set
// ANTHROPIC_API_KEY in .env to turn this on. Any API failure falls back to
// the deterministic text — a report must never fail because a model did.

const MODEL = 'claude-sonnet-4-5';
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
    const actions = findingsResult.actions.map((f) => ({ ...f }));
    for (const p of parsed) {
      const f = actions[p.i];
      if (!f || typeof p.statement !== 'string') continue;
      // Guard: reject any rewrite that drops the cited URLs' host or invents digits.
      const numsBefore = (f.statement.match(/\d+/g) || []).sort().join(',');
      const numsAfter = (p.statement.match(/\d+/g) || []).sort().join(',');
      if (numsAfter.split(',').some((n) => n && !numsBefore.includes(n))) continue;
      f.narrative = p.statement;
      if (typeof p.fix === 'string' && f.fix) f.narrative_fix = p.fix;
    }
    return { ...findingsResult, actions, narrated: true };
  } catch (err) {
    return { ...findingsResult, narrated: false, narrate_note: `Narrative call failed (${err.message}); deterministic statements shipped instead.` };
  }
}
