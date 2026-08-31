// Homepage evidence. Regex extraction over raw HTML — no DOM dependency, and
// we only report tags we actually matched.

const metaRe = /<meta\b[^>]*>/gi;
const attrRe = /([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function attrs(tag) {
  const out = {};
  let m;
  attrRe.lastIndex = 0;
  while ((m = attrRe.exec(tag))) out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  return out;
}

const ATS_PATTERNS = [
  ['greenhouse', /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i],
  ['lever',      /jobs\.lever\.co\/([a-z0-9_-]+)/i],
  ['ashby',      /jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i],
  ['workday',    /([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com/i],
  ['smartrecruiters', /careers\.smartrecruiters\.com\/([a-z0-9_-]+)/i],
  ['workable',   /apply\.workable\.com\/([a-z0-9_-]+)/i],
];

export function extractHomepage(html, baseUrl) {
  if (!html) return null;
  const head = html.slice(0, 400000);
  const meta = { og: {}, twitter: {}, other: {} };
  for (const tag of head.match(metaRe) || []) {
    const a = attrs(tag);
    const key = (a.property || a.name || a.itemprop || '').toLowerCase();
    const content = a.content ?? '';
    if (!key) continue;
    if (key.startsWith('og:')) meta.og[key.slice(3)] = content;
    else if (key.startsWith('twitter:')) meta.twitter[key.slice(8)] = content;
    else if (['description', 'robots', 'generator', 'author'].includes(key)) meta.other[key] = content;
  }

  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head) || [])[1]?.trim().replace(/\s+/g, ' ') || null;
  const canonical = (() => {
    for (const tag of head.match(/<link\b[^>]*>/gi) || []) {
      const a = attrs(tag);
      if ((a.rel || '').toLowerCase() === 'canonical') return a.href || null;
    }
    return null;
  })();

  const feeds = [];
  const hreflangAlternates = [];
  for (const tag of head.match(/<link\b[^>]*>/gi) || []) {
    const a = attrs(tag);
    const rel = (a.rel || '').toLowerCase();
    const type = (a.type || '').toLowerCase();
    if (rel.includes('alternate') && /rss|atom|xml/.test(type) && a.href) {
      try { feeds.push({ href: new URL(a.href, baseUrl).toString(), type, title: a.title || null }); } catch {}
    }
    // K1: hreflang alternates feed English-version discovery (decision 2026-08-31).
    if (rel.includes('alternate') && a.hreflang && a.href && hreflangAlternates.length < 100) {
      try { hreflangAlternates.push({ hreflang: a.hreflang.toLowerCase(), href: new URL(a.href, baseUrl).toString() }); } catch {}
    }
  }

  // K1: the declared document language drives English-version discovery.
  const htmlLang = (/<html[^>]*\slang\s*=\s*["']?([a-zA-Z][a-zA-Z0-9-]*)/i.exec(head) || [])[1]?.toLowerCase() || null;

  const jsonLdTypes = [];
  for (const m of head.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim());
      const walk = (n) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (n && typeof n === 'object') {
          if (n['@type']) [].concat(n['@type']).forEach((t) => jsonLdTypes.push(String(t)));
          Object.values(n).forEach(walk);
        }
      };
      walk(data);
    } catch { jsonLdTypes.push('__unparseable_json_ld__'); }
  }

  // Link discovery, restricted to same-origin plus known ATS hosts.
  const hrefs = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    hrefs.push(m[2] ?? m[3] ?? '');
  }
  const abs = [];
  for (const h of hrefs) { try { abs.push(new URL(h, baseUrl).toString()); } catch {} }

  const careerLinks = [...new Set(abs.filter((u) => /\/(careers?|jobs?|join-us|work-with-us|life-at)(\/|$|\?)/i.test(u)))].slice(0, 10);
  const atsHints = [];
  for (const [name, re] of ATS_PATTERNS) {
    const hit = re.exec(html);
    if (hit) atsHints.push({ ats: name, token: hit[1], matched_on: 'homepage HTML' });
  }

  const textLen = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;

  return {
    title,
    lang: htmlLang,
    hreflang_alternates: hreflangAlternates,
    meta_description: meta.other.description || null,
    canonical,
    open_graph: meta.og,
    open_graph_complete: Boolean(meta.og.title && meta.og.description && meta.og.image),
    twitter_card: meta.twitter,
    json_ld_types: [...new Set(jsonLdTypes)],
    json_ld_blocks: (head.match(/application\/ld\+json/gi) || []).length,
    feeds_declared: feeds,
    generator: meta.other.generator || null,
    outbound_link_count: abs.length,
    career_links_found: careerLinks,
    ats_hints: atsHints,
    rendered_text_chars: textLen,
    likely_js_rendered: textLen < 800,
    note: textLen < 800
      ? 'Very little text in the raw HTML. This page is probably JavaScript-rendered; a plain fetch cannot see its content.'
      : null,
  };
}
