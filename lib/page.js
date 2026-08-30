// Per-page shareability evidence. Reports only tags actually found; every absent
// tag is an explicit false, never an omission the reader has to interpret.

const metaRe = /<meta\b[^>]*>/gi;
const linkRe = /<link\b[^>]*>/gi;
const attrRe = /([a-zA-Z:_.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function attrs(tag) {
  const out = {}; let m; attrRe.lastIndex = 0;
  while ((m = attrRe.exec(tag))) out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  return out;
}
const decode = (s) => String(s ?? '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').trim();

const SHARE_PATTERNS = [
  ['x_twitter', /(twitter\.com\/intent\/tweet|x\.com\/intent\/(tweet|post))/i],
  ['linkedin',  /linkedin\.com\/(sharing\/share-offsite|shareArticle|cws\/share)/i],
  ['facebook',  /facebook\.com\/(sharer|dialog\/share)/i],
  ['reddit',    /reddit\.com\/submit/i],
  ['email',     /mailto:\?[^"']*(subject|body)=/i],
  ['generic',   /(class|data-[a-z-]*)\s*=\s*["'][^"']*\b(share|social-share|addtoany|sharethis)\b/i],
];

export function extractPage(html, pageUrl) {
  if (!html) return null;
  const head = html.slice(0, 500000);

  const og = {}, tw = {}, other = {};
  for (const tag of head.match(metaRe) || []) {
    const a = attrs(tag);
    const key = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (!key) continue;
    const content = decode(a.content);
    if (key.startsWith('og:')) og[key.slice(3)] = content;
    else if (key.startsWith('twitter:')) tw[key.slice(8)] = content;
    else if (['description', 'author', 'robots', 'article:author', 'article:published_time', 'article:modified_time'].includes(key)) other[key] = content;
  }
  for (const tag of head.match(metaRe) || []) {
    const a = attrs(tag);
    const p = (a.property || '').toLowerCase();
    if (p === 'article:author') other['article:author'] = decode(a.content);
    if (p === 'article:published_time') other['article:published_time'] = decode(a.content);
    if (p === 'article:modified_time') other['article:modified_time'] = decode(a.content);
  }

  let canonical = null;
  const relAuthors = [];
  for (const tag of head.match(linkRe) || []) {
    const a = attrs(tag);
    const rel = (a.rel || '').toLowerCase();
    if (rel === 'canonical' && a.href) canonical = a.href;
    if (rel === 'author' && a.href) relAuthors.push(a.href);
  }

  // JSON-LD is the most reliable author/date source when it is present.
  const ld = { types: [], authors: [], published: null, modified: null, headline: null, unparseable: 0 };
  for (const m of head.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { ld.unparseable++; continue; }
    const walk = (n) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      if (n['@type']) [].concat(n['@type']).forEach((t) => ld.types.push(String(t)));
      if (n.author) {
        for (const a of [].concat(n.author)) {
          if (typeof a === 'string') ld.authors.push(a);
          else if (a && typeof a === 'object' && a.name) ld.authors.push(String(a.name));
        }
      }
      if (!ld.published && n.datePublished) ld.published = String(n.datePublished);
      if (!ld.modified && n.dateModified) ld.modified = String(n.dateModified);
      if (!ld.headline && n.headline) ld.headline = String(n.headline);
      Object.values(n).forEach(walk);
    };
    walk(data);
  }
  ld.types = [...new Set(ld.types)];
  ld.authors = [...new Set(ld.authors.map((a) => a.trim()).filter(Boolean))];

  // Visible byline, as a fallback when there is no structured author.
  const bylineHits = [];
  for (const m of html.matchAll(/<[^>]+(?:rel=["']author["']|itemprop=["']author["']|class=["'][^"']*\b(?:author|byline|post-author)\b[^"']*["'])[^>]*>([\s\S]{0,160}?)<\/[a-z]+>/gi)) {
    const t = decode(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
    if (t && t.length > 1 && t.length < 80) bylineHits.push(t);
  }

  const shareAffordances = SHARE_PATTERNS.filter(([, re]) => re.test(html)).map(([name]) => name);

  const h1 = decode((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || [])[1]?.replace(/<[^>]+>/g, ' '))?.replace(/\s+/g, ' ') || null;
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  const authorNames = ld.authors.length ? ld.authors : (other.author ? [other.author] : bylineHits.slice(0, 2));

  return {
    url: pageUrl,
    open_graph: { title: og.title || null, description: og.description || null, image: og.image || null, type: og.type || null, site_name: og.site_name || null },
    has_og_title: Boolean(og.title),
    has_og_description: Boolean(og.description),
    has_og_image: Boolean(og.image),
    og_complete: Boolean(og.title && og.description && og.image),
    twitter_card: tw.card || null,
    has_twitter_card: Boolean(tw.card),
    has_twitter_image: Boolean(tw.image || og.image),
    canonical,
    has_canonical: Boolean(canonical),
    schema_types: ld.types,
    has_article_schema: ld.types.some((t) => /^(Article|BlogPosting|NewsArticle|TechArticle|Report)$/i.test(t)),
    json_ld_unparseable_blocks: ld.unparseable,
    author: {
      names: authorNames,
      named_human_author: authorNames.length > 0,
      source: ld.authors.length ? 'json-ld' : other.author ? 'meta[name=author]' : bylineHits.length ? 'visible byline' : null,
      rel_author_links: relAuthors.length,
    },
    dates: {
      published: ld.published || other['article:published_time'] || null,
      modified: ld.modified || other['article:modified_time'] || null,
      source: ld.published ? 'json-ld' : other['article:published_time'] ? 'meta[article:published_time]' : null,
    },
    share_affordances: shareAffordances,
    has_share_affordance: shareAffordances.length > 0,
    h1,
    word_count: text ? text.split(' ').length : 0,
    looks_empty: text.length < 800,
  };
}
