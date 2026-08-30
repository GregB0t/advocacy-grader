// robots.txt parsing, Google-style path matching, AI-agent posture, and
// Content-Signal coherence. Spec §3 category 4, as revised by R2/R3.

// AI-relevant user-agents we look for. `kind` distinguishes what blocking it costs you.
export const AI_AGENTS = [
  { ua: 'GPTBot',                     vendor: 'OpenAI',      kind: 'train' },
  { ua: 'OAI-SearchBot',              vendor: 'OpenAI',      kind: 'search' },
  { ua: 'ChatGPT-User',               vendor: 'OpenAI',      kind: 'user-fetch' },
  { ua: 'ClaudeBot',                  vendor: 'Anthropic',   kind: 'train' },
  { ua: 'Claude-User',                vendor: 'Anthropic',   kind: 'user-fetch' },
  { ua: 'Claude-SearchBot',           vendor: 'Anthropic',   kind: 'search' },
  { ua: 'anthropic-ai',               vendor: 'Anthropic',   kind: 'train' },
  { ua: 'Google-Extended',            vendor: 'Google',      kind: 'train' },
  { ua: 'Googlebot',                  vendor: 'Google',      kind: 'search' },
  { ua: 'Bingbot',                    vendor: 'Microsoft',   kind: 'search' },
  { ua: 'PerplexityBot',              vendor: 'Perplexity',  kind: 'search' },
  { ua: 'Perplexity-User',            vendor: 'Perplexity',  kind: 'user-fetch' },
  { ua: 'Applebot',                   vendor: 'Apple',       kind: 'search' },
  { ua: 'Applebot-Extended',          vendor: 'Apple',       kind: 'train' },
  { ua: 'Amazonbot',                  vendor: 'Amazon',      kind: 'search' },
  { ua: 'meta-externalagent',         vendor: 'Meta',        kind: 'train' },
  { ua: 'Meta-ExternalFetcher',       vendor: 'Meta',        kind: 'user-fetch' },
  { ua: 'CCBot',                      vendor: 'Common Crawl',kind: 'train' },
  { ua: 'Bytespider',                 vendor: 'ByteDance',   kind: 'train' },
  { ua: 'cohere-ai',                  vendor: 'Cohere',      kind: 'train' },
  { ua: 'YouBot',                     vendor: 'You.com',     kind: 'search' },
  { ua: 'DuckAssistBot',              vendor: 'DuckDuckGo',  kind: 'search' },
  { ua: 'Diffbot',                    vendor: 'Diffbot',     kind: 'train' },
  { ua: 'ImagesiftBot',               vendor: 'ImageSift',   kind: 'train' },
  { ua: 'CloudflareBrowserRenderingCrawler', vendor: 'Cloudflare', kind: 'render' },
];

// Exact bot list Cloudflare's one-click "block AI bots" toggle writes. R3.
const CF_DEFAULT_BLOCKLIST = [
  'amazonbot', 'applebot-extended', 'bytespider', 'ccbot', 'claudebot',
  'cloudflarebrowserrenderingcrawler', 'google-extended', 'gptbot', 'meta-externalagent',
];

export function parseRobots(text) {
  const lines = String(text).split(/\r?\n/);
  const groups = [];       // { agents:[lc], rules:[{type,path}], crawlDelay, contentSignal }
  const sitemaps = [];
  const unknownDirectives = [];
  let current = null;
  let lastWasAgent = false;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null, contentSignal: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === 'sitemap') { if (value) sitemaps.push(value); continue; }
    if (!current) { current = { agents: ['*'], rules: [], crawlDelay: null, contentSignal: null }; groups.push(current); }
    if (field === 'allow' || field === 'disallow') { current.rules.push({ type: field, path: value }); continue; }
    if (field === 'crawl-delay') { const n = Number(value); if (Number.isFinite(n)) current.crawlDelay = n; continue; }
    if (field === 'content-signal') { current.contentSignal = value; continue; }
    unknownDirectives.push(field);
  }
  return { groups, sitemaps: [...new Set(sitemaps)], unknownDirectives: [...new Set(unknownDirectives)] };
}

// Select the group whose agent token matches ours most specifically, else '*'.
function selectGroup(parsed, uaToken) {
  const ua = uaToken.toLowerCase();
  let best = null, bestLen = -1;
  for (const g of parsed.groups) {
    for (const a of g.agents) {
      if (a === '*') continue;
      if (ua.includes(a) && a.length > bestLen) { best = g; bestLen = a.length; }
    }
  }
  if (best) return best;
  const star = parsed.groups.filter((g) => g.agents.includes('*'));
  if (!star.length) return null;
  // Multiple '*' groups occur in the wild (e.g. a managed block + a hand-written one).
  // Merge them: union of rules, most permissive crawl-delay retained.
  return star.reduce((acc, g) => ({
    agents: ['*'],
    rules: [...acc.rules, ...g.rules],
    crawlDelay: acc.crawlDelay ?? g.crawlDelay,
    contentSignal: acc.contentSignal ?? g.contentSignal,
  }), { agents: ['*'], rules: [], crawlDelay: null, contentSignal: null });
}

function ruleToRegex(path) {
  if (path === '') return null;
  let re = '';
  for (const ch of path) {
    if (ch === '*') re += '.*';
    else if (ch === '$') re += '$';
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re);
}

// Google's longest-match-wins rule; Allow breaks ties.
function matchLength(rules, pathname, type) {
  let longest = -1;
  for (const r of rules) {
    if (r.type !== type) continue;
    const re = ruleToRegex(r.path);
    if (re === null) continue;
    if (re.test(pathname)) longest = Math.max(longest, r.path.replace(/\$$/, '').length);
  }
  return longest;
}

export function makeMatcher(parsed, uaToken) {
  const group = selectGroup(parsed, uaToken);
  if (!group) return { allowed: () => true, group: null, crawlDelay: null };
  return {
    group,
    crawlDelay: group.crawlDelay,
    allowed(urlOrPath) {
      let pathname = urlOrPath;
      try { const u = new URL(urlOrPath); pathname = u.pathname + u.search; } catch {}
      const a = matchLength(group.rules, pathname, 'allow');
      const d = matchLength(group.rules, pathname, 'disallow');
      if (d === -1) return true;
      if (a === -1) return false;
      return a >= d;
    },
  };
}

export function parseContentSignal(value) {
  if (!value) return null;
  const out = {};
  for (const part of value.split(',')) {
    const [k, v] = part.split('=').map((s) => (s || '').trim().toLowerCase());
    if (k) out[k] = v ?? null;
  }
  return out;
}

// Per-agent posture, plus the coherence finding that R2/R3 make the headline signal.
export function aiPosture(parsed) {
  const agents = AI_AGENTS.map(({ ua, vendor, kind }) => {
    const m = makeMatcher(parsed, ua);
    const named = parsed.groups.some((g) => g.agents.includes(ua.toLowerCase()));
    return {
      user_agent: ua, vendor, kind,
      named_explicitly: named,
      root_allowed: m.allowed('/'),
      basis: named ? 'own group' : 'wildcard group',
    };
  });

  // Content-Signal may be declared on any group; report every declaration seen.
  const signals = [];
  for (const g of parsed.groups) {
    if (g.contentSignal) signals.push({ applies_to: g.agents, raw: g.contentSignal, parsed: parseContentSignal(g.contentSignal) });
  }

  const blocked = agents.filter((a) => !a.root_allowed);
  const blockedNames = blocked.map((a) => a.user_agent.toLowerCase()).sort();
  const cfMatch = CF_DEFAULT_BLOCKLIST.every((b) => blockedNames.includes(b));

  // A contradiction exists only when the KIND of agent the grant depends on is
  // blocked. Blocking training bots while declaring search=yes is a coherent
  // policy, not a contradiction (2026-08-29 audit hardening — no false positive
  // in the 350-domain calibration set, but the old check keyed on ANY blocked
  // agent and would have miscalled that site).
  const contradictions = [];
  for (const s of signals) {
    const p = s.parsed || {};
    const requiredKinds = new Set();
    if (p.search === 'yes') requiredKinds.add('search');
    if (p['ai-input'] === 'yes') { requiredKinds.add('user-fetch'); requiredKinds.add('search'); }
    if (['reference', 'excerpt', 'full'].includes(p.use)) { requiredKinds.add('search'); requiredKinds.add('user-fetch'); }
    const conflicting = blocked.filter((a) => requiredKinds.has(a.kind));
    if (requiredKinds.size && conflicting.length) {
      contradictions.push({
        finding: 'content_signal_contradicts_disallow',
        signal: s.raw,
        blocked_agents: conflicting.map((a) => a.user_agent),
        explanation:
          'The Content-Signal grants a use that requires reading the site, while AI user-agents of exactly that kind are disallowed from reading it. A crawler cannot reference content it is not permitted to fetch. Blocking only training bots would not have triggered this finding.',
      });
    }
  }

  return {
    agents,
    content_signals: signals,
    blocked_count: blocked.length,
    blocked_agents: blocked.map((a) => a.user_agent),
    matches_cloudflare_default_blocklist: cfMatch,
    contradictions,
    caveat: 'robots.txt is advisory. This reports the declared policy only; it is not a claim that any crawler was actually blocked.',
  };
}
