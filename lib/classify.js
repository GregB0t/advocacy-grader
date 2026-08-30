// Deterministic URL classification. No AI, no guessing. Rules are ordered;
// first match wins. Anything unmatched is reported as unclassified with its
// path prefix, so the rule set can be improved from evidence rather than vibes.

export const SECTION_RULES = [
  ['blog',          [/^\/blog(\/|$)/, /^\/posts?(\/|$)/, /^\/articles?(\/|$)/, /^\/insights?(\/|$)/]],
  ['case_study',    [/^\/(customers?|case-?stud(y|ies)|(customer|success|client)-?stories|clients?|testimonials?)(\/|$)/, /case-stud/, /customer-stories/]],
  ['resource',      [/^\/(resources?|library|content|learn|hub)(\/|$)/]],
  ['guide_ebook',   [/^\/(guides?|ebooks?|whitepapers?|reports?|playbooks?|templates?|checklists?|toolkits?)(\/|$)/]],
  ['news_press',    [/^\/(news|press|newsroom|press-releases?|media)(\/|$)/, /^\/about\/news(\/|$)/]],
  ['event_webinar', [/^\/(events?|webinars?|conferences?|summit|workshops?|demos?)(\/|$)/]],
  ['podcast_video', [/^\/(podcasts?|videos?|watch|episodes?|shows?)(\/|$)/]],
  ['careers',       [/^\/(careers?|jobs?|job|openings?|opportunities|hiring|join-us)(\/|$)/]],
  ['culture',       [/^\/(life-at|life|culture|our-people|people|team|employees?|our-story|diversity|dei|belonging|values)(\/|$)/, /life-at-/, /employee-(story|stories|spotlight)/]],
  ['about',         [/^\/(about|about-us|company|who-we-are|mission|leadership|investors)(\/|$)/, /^\/about-[a-z0-9-]+(\/|$)/]],
  ['docs_support',  [/^\/(docs?|documentation|developers?|api|support|help|knowledge-?base|kb|faqs?|community|forums?|drivers?|downloads?|glossary)(\/|$)/]],
  ['product',       [/^\/(product|products|platform|features?|capabilities|technologies|gpu|hardware|software)(\/|$)/]],
  ['solutions',     [/^\/(solutions?|use-?cases?|industries|verticals|for)(\/|$)/]],
  ['pricing',       [/^\/(pricing|plans|packages)(\/|$)/]],
  ['partner_integration', [/^\/(partners?|integrations?|marketplace|apps?|ecosystem)(\/|$)/]],
  ['legal',         [/^\/(legal|privacy|terms|cookie|gdpr|dpa|security|trust|compliance|accessibility|sitemap)(\/|$)/, /privacy-policy/, /terms-of/]],
  ['author_tag_taxonomy', [/^\/(author|authors|tag|tags|category|categories|topic|topics|archive)(\/|$)/, /\/(tag|category|author)\//]],
  ['contact_demo',  [/^\/(contact|contact-us|demo|instant-demo|request-demo|tour|platform-tour|product-tour|get-started|book|schedule|signup|sign-up|register|login|log-in|trial|lp)(\/|$)/]],
  ['home',          [/^\/$/]],
];

const LOCALE_RE = /^\/([a-z]{2})(?:-([a-z]{2}))?(\/|$)/i;

// ISO 639-1 language codes. Locale segments are matched as <lang> or <lang>-<region>,
// which covers en-us, es-la, zh-tw, pt-br and the long tail without a hand-kept list
// of every market a company happens to sell into. (NVIDIA alone ships 30+.)
const ISO639_1 = new Set(('aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu').split(' '));

// Path segments that look like a locale but are ordinary sections. Without this,
// /it/ (Italian) is indistinguishable from an /it/ IT-solutions section, and /no/,
// /is/, /as/, /be/, /or/ collide with English words used as slugs.
const LOCALE_FALSE_FRIENDS = new Set(['it', 'no', 'is', 'as', 'be', 'or', 'in', 'to', 'so', 'an', 'my', 'me', 'do', 'go', 'id', 'os', 'ai', 'pi', 'la', 'se', 'st', 'na', 'ha', 'hi']);

// Sections that plausibly produce something an employee would share.
export const SHAREABLE_SECTIONS = ['blog', 'case_study', 'resource', 'guide_ebook', 'news_press', 'event_webinar', 'podcast_video', 'culture'];

// Pages that sit inside a shareable section but that nobody would ever share.
// Sampling these produces a technically accurate Shareability score that measures
// the wrong thing — NVIDIA's pool was mostly sweepstakes terms and exhibitor lists.
export const NON_SHAREABLE_PATH = /\/(terms|terms-and-conditions|terms-conditions|rules|sweepstakes|giveaway|contest|legal|privacy|disclaimer|sponsors?-?(and-)?exhibitors?|exhibitors?|floor-?plan|agenda|registration|register|thank-?you|confirmation|unsubscribe|search|page\/\d+)(\/|$)/i;

export function classifyUrls(urls, { origin } = {}) {
  const bySection = new Map();
  const unclassifiedPrefixes = new Map();
  const localeCounts = new Map();
  const hosts = new Map();
  const depthCounts = new Map();
  const samples = new Map();
  const canonical = new Map();      // locale-stripped path -> { section, locales:Set, urls:[] }
  let localized = 0;

  for (const u of urls) {
    let parsed;
    try { parsed = new URL(u.loc); } catch { continue; }
    hosts.set(parsed.host, (hosts.get(parsed.host) || 0) + 1);

    let path = parsed.pathname;
    const lm = LOCALE_RE.exec(path);
    let locale = null;
    if (lm) {
      const lang = lm[1].toLowerCase();
      const region = lm[2] ? lm[2].toLowerCase() : null;
      // A bare two-letter segment is only treated as a locale when it is an ISO
      // language code AND not a word that commonly appears as a real path segment.
      const isLocale = ISO639_1.has(lang) && (region ? true : !LOCALE_FALSE_FRIENDS.has(lang));
      if (isLocale) {
        locale = region ? `${lang}-${region}` : lang;
        localized++;
        localeCounts.set(locale, (localeCounts.get(locale) || 0) + 1);
        path = path.slice(locale.length + 1) || '/';
      }
    }

    const segs = path.split('/').filter(Boolean);
    depthCounts.set(segs.length, (depthCounts.get(segs.length) || 0) + 1);

    let section = null;
    for (const [name, patterns] of SECTION_RULES) {
      if (patterns.some((re) => re.test(path))) { section = name; break; }
    }
    if (!section) {
      section = 'unclassified';
      const prefix = '/' + (segs[0] || '');
      unclassifiedPrefixes.set(prefix, (unclassifiedPrefixes.get(prefix) || 0) + 1);
    }
    // Decision 2: localized duplicates collapse to one canonical piece of content.
    // The locale count is reported separately rather than multiplying the inventory.
    const canonKey = parsed.host.replace(/^www\./, '') + path.replace(/\/$/, '');
    if (!canonical.has(canonKey)) canonical.set(canonKey, { section, locales: new Set(), url: u.loc });
    if (locale) canonical.get(canonKey).locales.add(locale);

    bySection.set(section, (bySection.get(section) || 0) + 1);
    if (!samples.has(section)) samples.set(section, []);
    const s = samples.get(section);
    if (s.length < 3) s.push(u.loc);
  }

  const sorted = (m) => Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
  const sections = sorted(bySection);
  const shareable = SHAREABLE_SECTIONS.reduce((n, k) => n + (sections[k] || 0), 0);

  // Canonical (deduplicated) view — this is what Content Supply scores against.
  const canonSections = new Map();
  for (const { section } of canonical.values()) canonSections.set(section, (canonSections.get(section) || 0) + 1);
  const canonSectionsObj = sorted(canonSections);
  const canonShareable = SHAREABLE_SECTIONS.reduce((n, k) => n + (canonSectionsObj[k] || 0), 0);
  const canonList = [...canonical.entries()]
    .map(([key, v]) => ({ key, url: v.url, section: v.section, locale_count: v.locales.size }))
    .filter((c) => !NON_SHAREABLE_PATH.test(new URL(c.url).pathname));

  const result = {
    total_urls_classified: urls.length,
    canonical_content: {
      canonical_urls: canonical.size,
      raw_urls: urls.length,
      collapsed_by_localization: urls.length - canonical.size,
      sections: canonSectionsObj,
      sections_present: Object.keys(canonSectionsObj).filter((k) => k !== 'unclassified').length,
      shareable_url_count: canonShareable,
      shareable_share_pct: canonical.size ? Math.round((canonShareable / canonical.size) * 1000) / 10 : 0,
      note: 'Localized duplicates collapsed to one entry each. Per decision 2 this deduplicated view is what Content Supply scores; the raw counts below are kept for transparency.',
    },
    hosts_seen: sorted(hosts),
    cross_host: (() => {
      const entries = [...hosts.entries()];
      const primary = entries.sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const others = entries.filter(([h]) => h !== primary);
      return others.length
        ? { primary_host: primary, other_hosts: Object.fromEntries(others), note: 'The sitemap lists URLs on hosts other than the primary one. Those pages were counted in the totals above.' }
        : null;
    })(),
    sections,
    section_samples: Object.fromEntries([...samples.entries()].map(([k, v]) => [k, v])),
    sections_present: Object.keys(sections).filter((k) => k !== 'unclassified').length,
    shareable_url_count: shareable,
    shareable_share_pct: urls.length ? Math.round((shareable / urls.length) * 1000) / 10 : 0,
    localization: {
      localized_urls: localized,
      locales: sorted(localeCounts),
      distinct_locales: localeCounts.size,
      note: localeCounts.size > 1 ? 'Localized duplicates inflate raw URL counts; per-section counts include every locale.' : null,
    },
    path_depth: sorted(depthCounts),
    unclassified: {
      count: sections.unclassified || 0,
      top_path_prefixes: Object.fromEntries([...unclassifiedPrefixes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)),
      note: 'Reported so classification gaps are visible rather than silently absorbed into other buckets.',
    },
  };
  // Non-enumerable so the canonical list is available to the sampler without
  // bloating the JSON report with tens of thousands of entries.
  Object.defineProperty(result, 'canonicalList', { value: canonList, enumerable: false });
  return result;
}
