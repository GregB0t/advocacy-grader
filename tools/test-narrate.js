// Narrative-layer tests (phase H tail). Run: npm test
//
// WHY THIS SUITE EXISTS. lib/narrate.js is the only place in the project where a
// language model touches text that ships to a stranger — in the report and, via
// top_fix_*, in the 48h follow-up email. Detection stays deterministic; this
// module may only REPHRASE. Spec §7 rule 3 says never state a finding the tool
// did not observe, so the failure this suite guards against is a rewrite that
// quietly acquires a number nobody measured.
//
// Fully offline: narrateFindings takes an injectable fetchImpl, so every case
// below is a scripted model response. No key, no network.
import { narrateFindings } from '../lib/narrate.js';

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('ok - ' + name); }
  else { failed++; console.error('FAIL - ' + name); }
}

// One finding whose deterministic text cites 506, 557 and 90.8 — chosen because
// 506 is exactly the string that made the OLD substring guard let "50" through.
const base = () => ({
  actions: [{
    id: 'coverage', title: 'Most of the sitemap could not be read',
    statement: 'Of the 557 URLs in the sitemap, 506 (90.8%) could not be classified.',
    fix: 'Expose section paths the classifier can read.',
    severity: 'issue',
  }],
});

// A fetchImpl that returns whatever rewrite the test scripts.
const respondWith = (arr) => async () => ({
  ok: true,
  json: async () => ({ content: [{ type: 'text', text: JSON.stringify(arr) }] }),
});

// --- NO KEY: the module must be a pure no-op ---------------------------------
{
  const r = await narrateFindings(base(), { apiKey: null });
  ok(r.narrated === false, 'no key: narrated is false');
  ok(typeof r.narrate_note === 'string' && /ANTHROPIC_API_KEY/.test(r.narrate_note),
    'no key: narrate_note names the missing key, so a silent no-op is explainable');
  ok(r.actions[0].narrative === undefined, 'no key: no narrative field is added');
}

// --- A CLEAN REPHRASE IS ACCEPTED --------------------------------------------
{
  const r = await narrateFindings(base(), {
    apiKey: 'test-key',
    fetchImpl: respondWith([{ i: 0, statement: '506 of 557 sitemap URLs (90.8%) were unreadable.', fix: 'Expose readable section paths.' }]),
  });
  ok(r.narrated === true, 'clean rephrase: narrated is true');
  ok(r.actions[0].narrative === '506 of 557 sitemap URLs (90.8%) were unreadable.',
    'clean rephrase: the narrative is applied');
  ok(r.actions[0].narrative_fix === 'Expose readable section paths.',
    'clean rephrase: the fix rewrite is applied');
  ok(r.actions[0].statement === base().actions[0].statement,
    'clean rephrase: the deterministic statement is preserved alongside, never overwritten');
}

// --- AN INVENTED NUMBER IS REJECTED ------------------------------------------
{
  const r = await narrateFindings(base(), {
    apiKey: 'test-key',
    fetchImpl: respondWith([{ i: 0, statement: 'Roughly 900 URLs could not be classified.' }]),
  });
  ok(r.actions[0].narrative === undefined,
    'invented number: the rewrite is rejected and the deterministic statement stands');
}

// --- THE SUBSTRING BUG, AS ITS OWN CASE --------------------------------------
// The old guard joined source numbers into one string and used .includes(), so
// "50" passed because the source contained "506". This is the regression test
// for that exact hole; it PASSED on the broken code.
{
  const r = await narrateFindings(base(), {
    apiKey: 'test-key',
    fetchImpl: respondWith([{ i: 0, statement: 'About 50 URLs could not be classified.' }]),
  });
  ok(r.actions[0].narrative === undefined,
    'invented "50" is rejected even though the source contains "506" (the substring hole)');
}

// --- THE FIX FIELD IS GUARDED TOO --------------------------------------------
// The old guard checked `statement` only. The fix text ships in the report AND
// in the 48h follow-up email, so an invented number there is equally fatal.
{
  const r = await narrateFindings(base(), {
    apiKey: 'test-key',
    fetchImpl: respondWith([{ i: 0, statement: '506 of 557 URLs were unreadable.', fix: 'This will recover 42% of your content.' }]),
  });
  ok(r.actions[0].narrative === undefined && r.actions[0].narrative_fix === undefined,
    'invented number in the FIX rejects the whole rewrite, not just the fix');
}

// --- DROPPING A NUMBER IS ALLOWED --------------------------------------------
// A rephrase may legitimately omit a redundant figure. Only invention is barred.
{
  const r = await narrateFindings(base(), {
    apiKey: 'test-key',
    fetchImpl: respondWith([{ i: 0, statement: 'Most of the sitemap could not be classified.' }]),
  });
  ok(r.actions[0].narrative === 'Most of the sitemap could not be classified.',
    'a rewrite that drops numbers without inventing any is accepted');
}

// --- A FAILING MODEL MUST NEVER FAIL A REPORT --------------------------------
{
  const r = await narrateFindings(base(), {
    apiKey: 'test-key',
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
  });
  ok(r.narrated === false, 'API error: narrated is false');
  ok(/429/.test(r.narrate_note || ''), 'API error: narrate_note carries the status, so the log can say why');
  ok(r.actions[0].statement === base().actions[0].statement,
    'API error: the deterministic report is intact');
}
{
  const r = await narrateFindings(base(), {
    apiKey: 'test-key',
    fetchImpl: async () => { throw new Error('socket hang up'); },
  });
  ok(r.narrated === false && /socket hang up/.test(r.narrate_note || ''),
    'network throw: falls back and records the reason rather than throwing');
}
{
  const r = await narrateFindings(base(), {
    apiKey: 'test-key',
    fetchImpl: respondWith('not the shape we asked for'),
  });
  ok(r.narrated === false, 'malformed model output: falls back rather than half-applying');
}

// --- THE MODEL ID IS PINNED, NOT AN ALIAS ------------------------------------
// An alias resolves to "the most recent dated snapshot", so the model under a
// rephrase-only call could change without a deploy.
{
  let sentModel = null;
  await narrateFindings(base(), {
    apiKey: 'test-key',
    fetchImpl: async (url, opts) => {
      sentModel = JSON.parse(opts.body).model;
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: '[]' }] }) };
    },
  });
  ok(/^claude-[a-z]+-\d[\d-]*-\d{8}$/.test(sentModel || ''),
    'the request pins a dated model snapshot rather than a floating alias (' + sentModel + ')');
}

console.log(`\n${passed} tests passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
