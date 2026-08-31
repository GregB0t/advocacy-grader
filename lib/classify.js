// Deterministic URL classification. No AI, no guessing. Rules are ordered;
// first match wins. Anything unmatched is reported as unclassified with its
// path prefix, so the rule set can be improved from evidence rather than vibes.
//
// K1 (2026-08-31): dated permalinks, multilingual section words (DE FR NL SV
// ES IT CZ + FI), evidence-based locale false-friend promotion, .html-suffixed
// enterprise CMS paths, a catalog_listing bucket for commerce inventory, CMS
// cruft detection, and — so a classifier change never again requires a blind
// refetch — complete depth-1/2 path-prefix histograms plus a deterministic
// capped URL sample stored in the classification block.
//
// The honesty rule that governs every entry here: a rule must be justifiable
// from the path alone. "/2021/11/18/slug" carries its meaning; "any root-level
// hyphenated slug" does not. Unclassified is an honest answer; a wrong section
// is not.

export const SECTION_RULES = [
  ['blog',          [/^\/blog(\/|$)/, /^\/posts?(\/|$)/, /^\/articles?(\/|$)/, /^\/insights?(\/|$)/]],
  ['case_study',    [/^\/(customers?|case-?stud(y|ies)|(customer|success|client)-?stories|clients?|testimonials?)(\/|$)/, /case-stud/, /customer-stories/, /^\/(projects|project-profiles)(\/|$)/]],
  ['recipe',        [/^\/recipes?(\/|$)/]],
  ['resource',      [/^\/(resources?|library|content|learn|hub|tips|tips-and-ideas)(\/|$)/]],
  ['guide_ebook',   [/^\/(guides?|ebooks?|whitepapers?|reports?|playbooks?|templates?|checklists?|toolkits?)(\/|$)/]],
  ['news_press',    [/^\/(news|press|newsroom|press-releases?|media|company-news|news-events)(\/|$)/, /^\/about\/news(\/|$)/, /\/(news-releases?|press-releases?)(\/|$)/, /(^|\/)newsroom(\/|$)/]],
  ['event_webinar', [/^\/(events?|webinars?|conferences?|summit|workshops?|demos?)(\/|$)/]],
  ['podcast_video', [/^\/(podcasts?|videos?|watch|episodes?|shows?)(\/|$)/]],
  ['careers',       [/^\/(careers?|jobs?|job|openings?|opportunities|hiring|join-us)(\/|$)/]],
  ['culture',       [/^\/(life-at|life|culture|our-people|people|team|employees?|our-story|diversity|dei|belonging|values)(\/|$)/, /life-at-/, /employee-(story|stories|spotlight)/]],
  ['about',         [/^\/(about|about-us|company|who-we-are|mission|leadership|investors)(\/|$)/, /^\/about-[a-z0-9-]+(\/|$)/]],
  ['docs_support',  [/^\/(docs?|documentation|developers?|api|support|help|help-center|customer-service|knowledge-?base|kb|faqs?|community|forums?|drivers?|downloads?|glossary)(\/|$)/]],
  ['locations',     [/^\/(locations?|stores|store-locator|our-locations|find-a-store|branches)(\/|$)/]],
  ['product',       [/^\/(product|products|platform|features?|capabilities|technologies|gpu|hardware|software)(\/|$)/]],
  ['solutions',     [/^\/(solutions?|use-?cases?|industries|verticals|for|services?)(\/|$)/]],
  ['pricing',       [/^\/(pricing|plans|packages)(\/|$)/]],
  ['partner_integration', [/^\/(partners?|integrations?|marketplace|apps?|ecosystem)(\/|$)/]],
  ['legal',         [/^\/(legal|privacy|terms|cookie|gdpr|dpa|security|trust|compliance|accessibility|sitemap|terms-and-conditions|terms-conditions)(\/|$)/, /privacy-policy/, /terms-of/, /^\/privacy-[a-z0-9-]+(\/|$)/]],
  ['author_tag_taxonomy', [/^\/(author|authors|tag|tags|category|categories|topic|topics|archive)(\/|$)/, /\/(tag|category|author)\//]],
  ['contact_demo',  [/^\/(contact|contact-us|demo|instant-demo|request-demo|tour|platform-tour|product-tour|get-started|book|schedule|signup|sign-up|register|login|log-in|trial|lp)(\/|$)/]],
  ['home',          [/^\/$/]],
];

// K1: section words in the corpus's non-English languages (DE FR NL SV ES IT
// CZ per the 2026-08-31 decision, plus FI — tieto's 472-page Finnish newsroom
// is a named case in the audit). Every word maps into an EXISTING section.
// Words mapping into SHAREABLE sections are individually vetted for English
// collisions; ambiguous ones were left out on purpose (e.g. IT "stampa" is
// both "press" and "printing" — a printing company's product pages must not
// score as a newsroom; CZ "akce" is both "events" and "deals").
// Applied AFTER the English rules, same first-match-wins semantics.
export const LANG_SECTION_RULES = [
  ['news_press',    [/^\/(aktuelles|nachrichten|neuigkeiten|presse|pressemitteilungen|actualites|communiques-de-presse|salle-de-presse|nieuws|persberichten|nyheter|pressmeddelanden|noticias|prensa|actualidad|sala-de-prensa|notizie|novita|comunicati-stampa|comunicazione|aktuality|novinky|tiskove-zpravy|uutiset|uutishuone|ajankohtaista)(\/|$)/, /\/(pressemitteilungen|persberichten|pressmeddelanden|comunicati-stampa|tiskove-zpravy)(\/|$)/]],
  ['blog',          [/^\/blogg(\/|$)/]],
  ['event_webinar', [/^\/(veranstaltungen|evenements|evenementen|evenemang|eventos|eventi|webinare|webinaires|seminare|tapahtumat)(\/|$)/]],
  ['case_study',    [/^\/(referenzen|referenties|temoignages|casos-de-exito)(\/|$)/]],
  ['careers',       [/^\/(karriere|karriar|carrieres|carriere|vacatures|werken-bij|lediga-jobb|jobb|empleo|ofertas-de-empleo|offres-emploi|emploi|trabaja-con-nosotros|carreras|lavora-con-noi|kariera|volna-mista|stellenangebote|tyopaikat|avoimet-tyopaikat)(\/|$)/]],
  ['about',         [/^\/(ueber-uns|uber-uns|unternehmen|a-propos|qui-sommes-nous|entreprise|over-ons|om-oss|om-foretaget|sobre-nosotros|quienes-somos|empresa|chi-siamo|azienda|o-nas|o-spolecnosti|yritys|tietoa-meista)(\/|$)/]],
  ['legal',         [/^\/(datenschutz|impressum|agb|rechtliches|mentions-legales|confidentialite|cgu|cgv|algemene-voorwaarden|privacybeleid|privacyverklaring|integritetspolicy|anvandarvillkor|villkor|aviso-legal|privacidad|politica-de-privacidad|condiciones|informativa-privacy|note-legali|ochrana-osobnich-udaju|obchodni-podminky|zasady-ochrany-osobnich-udaju|tietosuoja|kayttoehdot)(\/|$)/]],
  ['contact_demo',  [/^\/(kontakt|contacto|contatti|contactez-nous|yhteystiedot)(\/|$)/]],
  ['product',       [/^\/(produkte|produits|producten|produkter|productos|prodotti|produkty|tuotteet)(\/|$)/]],
  ['solutions',     [/^\/(loesungen|losungen|dienstleistungen|leistungen|diensten|tjanster|servicios|servizi|sluzby|palvelut|losningar|soluciones|soluzioni|oplossingen|reseni|ratkaisut|branchen)(\/|$)/]],
  ['docs_support',  [/^\/(hilfe|kennisbank|utbildningar|aide|ayuda|assistenza|napoveda|tuki)(\/|$)/]],
  ['pricing',       [/^\/(preise|tarifs|prijzen|priser|precios|prezzi|cenik|hinnat)(\/|$)/]],
  ['locations',     [/^\/(standorte|filialen|niederlassungen|magasiner|vestigingen|sedi|oficinas)(\/|$)/]],
];

// K1: commerce/catalog inventory. Classified-but-not-shareable so a retailer's
// product database stops tripping the coverage gate as "unread" — the gate now
// distinguishes "could we read this site" from "did we find content".
// Word list approved by Greg 2026-08-31, each word vetted against real corpus
// URLs (pearson /store 40k, williams-sonoma /shop 30k, homedepot /p 19k,
// opendoor /properties, southwest /flights, collegeboard /colleges +
// /scholarships, trustedshops /bewertung + /shops). DELIBERATELY ABSENT, so
// those inventories stay honestly unclassified: /data (too generic a word),
// /l (single letter, unknowable), brand-specific segments like /geforce.
// THE ORDERING GUARANTEE THAT MAKES THIS SAFE: these rules run AFTER every
// content rule above, so they can only convert currently-unclassified URLs —
// they can never take a page away from the shareable pool.
export const CATALOG_RULES = [
  ['catalog_listing', [/^\/(store|shops?|collections?|properties|flights|colleges|scholarships|bewertung(en)?|catalogue?|listings|inventory)(\/|$)/, /^\/p\/./]],
];

// K1: dated permalinks (classic WordPress /YYYY/MM/DD/slug). The shape alone
// carries the meaning: these are posts, and the corpus shows them exclusively
// as blog posts and press releases (guardanthealth, expandenergy, clece.es,
// esfm-usa, globalfurnitureusa, warburgpincus). /YYYY/MM/slug (no day) is NOT
// matched — a two-part date prefix is not unambiguous enough.
const DATED_POST_RE = /^\/\d{4}\/\d{2}\/\d{2}\/.+/;
const DATED_ARCHIVE_RE = /^\/\d{4}(\/\d{2}){1,2}\/?$/;

// K1: CMS cruft shipped to production by accident — lorem-ipsum filler pages,
// page-builder demos, editor copies. Bucketed as cms_cruft (visible, not
// silently dropped) and never shareable.
const CRUFT_RES = [/^\/copy-of-/, /header-footer/];
const LOREM_TOKENS = new Set(['lorem', 'ipsum', 'dolor', 'consectetur', 'adipisci', 'adipiscing', 'eiusmod', 'incididunt', 'repudiandae', 'expedita', 'voluptas', 'voluptatem', 'quisquam', 'perspiciatis', 'accusantium', 'doloremque', 'laudantium']);
function isCmsCruft(path) {
  if (CRUFT_RES.some((re) => re.test(path))) return true;
  const tokens = path.toLowerCase().split(/[/\-_.]/);
  let hits = 0;
  for (const t of tokens) if (LOREM_TOKENS.has(t)) { hits++; if (hits >= 2) return true; }
  return false;
}

// Locale segments: <lang> or <lang>-<region>. Region extended to 2-3
// alphanumerics (en-lac, es-419), and <x>-<x> pairs (cz-cz, an Enphase
// habit) accepted even when <x> is not an ISO code — the doubled shape is
// itself locale evidence.
const LOCALE_RE = /^\/([a-z]{2})(?:[-_]([a-z0-9]{2,3}))?(?=\/|$)/i;

// ISO 639-1 language codes. Locale segments are matched as <lang> or <lang>-<region>,
// which covers en-us, es-la, zh-tw, pt-br and the long tail without a hand-kept list
// of every market a company happens to sell into. (NVIDIA alone ships 30+.)
const ISO639_1 = new Set(('aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu').split(' '));

// Path segments that look like a locale but are ordinary sections. Without this,
// /it/ (Italian) is indistinguishable from an /it/ IT-solutions section, and /no/,
// /is/, /as/, /be/, /or/ collide with English words used as slugs.
// K1: this list was over-blocking — /it alone cost 4,741 URLs across 12
// domains — so membership is no longer final. A false friend is PROMOTED to a
// locale when the host itself supplies the evidence: at least two definite
// locale siblings (/de, /fr, /en-gb...), or three ISO-coded first segments
// (trustly.com's /se + /it + /no country roots), or a ccTLD matching the
// language (dovalue.it/it). No sibling evidence -> still treated as a section.
const LOCALE_FALSE_FRIENDS = new Set(['it', 'no', 'is', 'as', 'be', 'or', 'in', 'to', 'so', 'an', 'my', 'me', 'do', 'go', 'id', 'os', 'ai', 'pi', 'la', 'se', 'st', 'na', 'ha', 'hi']);

const WRAPPER_SEGMENTS = new Set(['corp', 'content', 'global']);

// Sections that plausibly produce something an employee would share.
// K1: 'recipe' added by decision 2026-08-31 — retailer recipe programmes are
// editorial content marketing (the audit's wholefoodsmarket false-F is the
// precedent), not catalog inventory. Keep this list in sync with lib/rubric.js.
export const SHAREABLE_SECTIONS = ['blog', 'case_study', 'recipe', 'resource', 'guide_ebook', 'news_press', 'event_webinar', 'podcast_video', 'culture'];

// Pages that sit inside a shareable section but that nobody would ever share.
// Sampling these produces a technically accurate Shareability score that measures
// the wrong thing — NVIDIA's pool was mostly sweepstakes terms and exhibitor lists.
export const NON_SHAREABLE_PATH = /\/(terms|terms-and-conditions|terms-conditions|rules|sweepstakes|giveaway|contest|legal|privacy|disclaimer|sponsors?-?(and-)?exhibitors?|exhibitors?|floor-?plan|agenda|registration|register|thank-?you|confirmation|unsubscribe|search|page\/\d+)(\/|$)/i;

// Parse a leading locale segment out of a path. `promoted` is the per-host set
// of false-friend languages promoted by sibling/TLD evidence.
function takeLocale(path, promoted) {
  const lm = LOCALE_RE.exec(path);
  if (!lm) return null;
  const lang = lm[1].toLowerCase();
  const region = lm[2] ? lm[2].toLowerCase() : null;
  const langOk = ISO639_1.has(lang) || (region !== null && region === lang);
  if (!langOk) return null;
  if (!region && LOCALE_FALSE_FRIENDS.has(lang) && !promoted.has(lang)) return null;
  const locale = region ? `${lang}-${region}` : lang;
  return { locale, rest: path.slice(lm[0].length) || '/' };
}

// Pre-scan: decide, per host, which false-friend segments are actually locales.
function promotedFalseFriends(urls) {
  const perHost = new Map(); // host -> { definite:Set, isoBare:Set }
  for (const u of urls) {
    let parsed; try { parsed = new URL(u.loc); } catch { continue; }
    const m = LOCALE_RE.exec(parsed.pathname);
    if (!m) continue;
    const lang = m[1].toLowerCase();
    const region = m[2] ? m[2].toLowerCase() : null;
    if (!perHost.has(parsed.host)) perHost.set(parsed.host, { definite: new Set(), isoBare: new Set() });
    const h = perHost.get(parsed.host);
    if (region && (ISO639_1.has(lang) || region === lang)) h.definite.add(region ? `${lang}-${region}` : lang);
    else if (!region && ISO639_1.has(lang)) {
      h.isoBare.add(lang);
      if (!LOCALE_FALSE_FRIENDS.has(lang)) h.definite.add(lang);
    }
  }
  const promoted = new Map(); // host -> Set(lang)
  for (const [host, h] of perHost) {
    const tld = host.split('.').pop();
    const set = new Set();
    for (const lang of h.isoBare) {
      if (!LOCALE_FALSE_FRIENDS.has(lang)) continue;
      const siblingEvidence = h.definite.size >= 2 || h.isoBare.size >= 3;
      const tldEvidence = tld === lang;
      if (siblingEvidence || tldEvidence) set.add(lang);
    }
    if (set.size) promoted.set(host, set);
  }
  return promoted;
}

export function classifyUrls(urls, { origin, urlSampleCap = 2000 } = {}) {
  const bySection = new Map();
  const unclassifiedPrefixes = new Map();
  const localeCounts = new Map();
  const hosts = new Map();
  const depthCounts = new Map();
  const samples = new Map();
  const canonical = new Map();      // locale-stripped path -> { section, locales:Set, url, repLocale }
  const rawDepth1 = new Map();
  const rawDepth2 = new Map();
  let localized = 0;

  const promotedByHost = promotedFalseFriends(urls);
  const NONE = new Set();

  for (const u of urls) {
    let parsed;
    try { parsed = new URL(u.loc); } catch { continue; }
    hosts.set(parsed.host, (hosts.get(parsed.host) || 0) + 1);

    // Raw path-prefix histograms — recorded BEFORE any normalization, so a
    // future classifier can be evaluated against exactly what the sitemap said.
    {
      const rawSegs = parsed.pathname.split('/').filter(Boolean);
      const d1 = '/' + (rawSegs[0] || '');
      rawDepth1.set(d1, (rawDepth1.get(d1) || 0) + 1);
      if (rawSegs.length >= 2) {
        const d2 = '/' + rawSegs[0] + '/' + rawSegs[1];
        rawDepth2.set(d2, (rawDepth2.get(d2) || 0) + 1);
      }
    }

    // Normalize: strip .html/.htm suffixes first (pearson.com/en.html is a
    // locale home page; allegion.com/corp/en/about.html is /about), then the
    // enterprise-CMS wrapper (/corp|/content|/global + locale), then a leading
    // locale segment.
    let path = parsed.pathname.replace(/\/index\.html?$/i, '/').replace(/\.html?$/i, '') || '/';
    const promoted = promotedByHost.get(parsed.host) || NONE;
    let locale = null;

    const wm = /^\/(corp|content|global)(\/|$)/i.exec(path);
    if (wm && WRAPPER_SEGMENTS.has(wm[1].toLowerCase())) {
      const afterWrapper = path.slice(wm[1].length + 1) || '/';
      const took = takeLocale(afterWrapper, promoted);
      if (took) { locale = took.locale; path = took.rest; }
    }
    if (!locale) {
      const took = takeLocale(path, promoted);
      if (took) { locale = took.locale; path = took.rest; }
    }
    if (locale) {
      localized++;
      localeCounts.set(locale, (localeCounts.get(locale) || 0) + 1);
    }

    const segs = path.split('/').filter(Boolean);
    depthCounts.set(segs.length, (depthCounts.get(segs.length) || 0) + 1);

    let section = null;
    if (isCmsCruft(path)) section = 'cms_cruft';
    else if (DATED_POST_RE.test(path)) section = 'blog';
    else if (DATED_ARCHIVE_RE.test(path)) section = 'author_tag_taxonomy';
    if (!section) {
      for (const rules of [SECTION_RULES, LANG_SECTION_RULES, CATALOG_RULES]) {
        for (const [name, patterns] of rules) {
          if (patterns.some((re) => re.test(path))) { section = name; break; }
        }
        if (section) break;
      }
    }
    if (!section) {
      section = 'unclassified';
      const prefix = '/' + (segs[0] || '');
      unclassifiedPrefixes.set(prefix, (unclassifiedPrefixes.get(prefix) || 0) + 1);
    }
    // Decision 2: localized duplicates collapse to one canonical piece of content.
    // The locale count is reported separately rather than multiplying the inventory.
    // K1: the English variant is preferred as the canonical representative, so
    // downstream sampling reads pages in English wherever the site offers them.
    const canonKey = parsed.host.replace(/^www\./, '') + path.replace(/\/$/, '');
    if (!canonical.has(canonKey)) canonical.set(canonKey, { section, locales: new Set(), url: u.loc, repLocale: locale });
    else {
      const entry = canonical.get(canonKey);
      const repIsEn = entry.repLocale && entry.repLocale.startsWith('en');
      if (!repIsEn && locale && locale.startsWith('en')) { entry.url = u.loc; entry.repLocale = locale; }
    }
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

  // K1: bounded histogram view. Depth-2 is unbounded in the wild (/p/<40k ids>),
  // so both depths are capped with the truncation recorded honestly.
  const HISTOGRAM_CAP = 1000;
  const capped = (m) => {
    const entries = [...m.entries()].sort((a, b) => b[1] - a[1]);
    return {
      counts: Object.fromEntries(entries.slice(0, HISTOGRAM_CAP)),
      distinct: m.size,
      truncated: m.size > HISTOGRAM_CAP,
    };
  };
  const d1 = capped(rawDepth1);
  const d2 = capped(rawDepth2);

  // K1: deterministic capped URL sample, stored so a future classifier change
  // can be evaluated against cached evidence WITHOUT a refetch. (The absence
  // of exactly this is why K1 needed a refetch at all.)
  const locs = urls.map((u) => u.loc).sort();
  const stride = Math.max(1, Math.ceil(locs.length / urlSampleCap));
  const sampledUrls = [];
  for (let i = 0; i < locs.length && sampledUrls.length < urlSampleCap; i += stride) sampledUrls.push(locs[i]);

  const promotedReport = {};
  for (const [host, set] of promotedByHost) promotedReport[host] = [...set].sort();

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
      false_friends_promoted: Object.keys(promotedReport).length ? promotedReport : null,
      note: localeCounts.size > 1 ? 'Localized duplicates inflate raw URL counts; per-section counts include every locale.' : null,
    },
    path_depth: sorted(depthCounts),
    unclassified: {
      count: sections.unclassified || 0,
      top_path_prefixes: Object.fromEntries([...unclassifiedPrefixes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)),
      note: 'Reported so classification gaps are visible rather than silently absorbed into other buckets.',
    },
    path_prefixes: {
      depth1: d1.counts,
      depth1_distinct: d1.distinct,
      depth1_truncated: d1.truncated,
      depth2: d2.counts,
      depth2_distinct: d2.distinct,
      depth2_truncated: d2.truncated,
      cap_per_depth: HISTOGRAM_CAP,
      note: 'Raw path-prefix histograms (before locale stripping), stored so classifier changes can be estimated against cached evidence without a refetch. Capped per depth; truncation is recorded, never silent.',
    },
    url_sample: {
      method: 'deterministic: all collected URLs sorted lexicographically, then fixed-stride selection starting at index 0',
      cap: urlSampleCap,
      stride,
      total_urls: urls.length,
      sampled: sampledUrls.length,
      complete: stride === 1,
      note: 'Stored so a future classifier change can be re-evaluated against this crawl without refetching. When complete=false this is a stride sample of the inventory, not the whole of it.',
      urls: sampledUrls,
    },
  };
  // Non-enumerable so the canonical list is available to the sampler without
  // bloating the JSON report with tens of thousands of entries.
  Object.defineProperty(result, 'canonicalList', { value: canonList, enumerable: false });
  return result;
}
