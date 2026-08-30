#!/usr/bin/env node
// Vendor-published customer evidence: logo walls, case studies, testimonials.
//
// A vendor naming a company as its customer is the vendor ASSERTING the
// relationship in public. That is strong evidence -- stronger than most things
// this project scores on. The weak link is not the claim, it is (a) whether the
// scraper extracted a real company name rather than a nav item or an award
// badge, and (b) whether that name maps to the right domain. Both are handled
// downstream; this file's job is to extract carefully and record where every
// name came from.
//
// TWO SOURCES
//   1. featuredcustomers.com/vendor/<slug> -- aggregates a vendor's public
//      references. Logo alt text and CDN filenames give clean company names.
//      robots.txt allows /vendor/ and /software/ (only /exit/, /captcha/,
//      /external/ and some sort params are disallowed). Verified 2026-08-29.
//   2. The vendor's own site -- homepage logo strip plus customer/case-study
//      index pages.
//
// Every host is robots-checked with OUR user-agent before any fetch, and a
// refusal is recorded as a finding, not worked around (hard rule 2, spec §7 r5).
//
// Resumable: one cache file per vendor. Re-run until it prints ALL VENDORS DONE.

import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { VENDORS } from '../lib/vendors.js';
import { registrableDomain } from '../lib/domain.js';
import { UA, UA_TOKEN } from '../lib/http.js';
import { parseRobots, makeMatcher } from '../lib/robots.js';
import { ScrapingBee, ESCALATION } from '../lib/scrapingbee.js';
import { mapPool } from '../lib/pool.js';

const CACHE = path.resolve(process.cwd(), 'data/.web-cache');
const OUT = path.resolve(process.cwd(), 'data/web-customer-index.json');
const BUDGET_MS = Number(process.env.BUDGET_MS || 33000);
const t0 = Date.now();
const outOfTime = () => Date.now() - t0 > BUDGET_MS;
const log = (...a) => console.error(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CANDIDATE_PATHS = [
  '/', '/customers', '/customers/', '/customer-stories', '/customer-stories/',
  '/case-studies', '/case-studies/', '/clients', '/success-stories',
  '/resources/case-studies', '/testimonials', '/our-customers', '/case-study',
];

// ScrapingBee is used ONLY for URLs our own robots matcher already approved.
// The module enforces that too. A 403 from a bot wall on a robots-ALLOWED page
// is a rendering/agent problem, not a permission signal; a robots disallow is a
// permission signal and is never proxied.
function readEnvKey() {
  try {
    const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    return (env.match(/^SCRAPINGBEE_API_KEY\s*=\s*(.+)$/m) || [])[1]?.trim() || null;
  } catch { return null; }
}
const bee = new ScrapingBee({ apiKey: process.env.SCRAPINGBEE_API_KEY || readEnvKey(), maxCreditsPerRun: Number(process.env.SB_CREDITS || 400), tag: 'vendor-customer-index' });

const robotsCache = new Map();
async function robotsFor(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  let matcher = { allowed: () => true, note: 'no usable robots.txt; treated as allow-all' };
  try {
    const res = await fetch(origin + '/robots.txt', { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
    const body = await res.text();
    if (res.ok && body && !/^\s*<(!doctype|html)/i.test(body)) {
      const m = makeMatcher(parseRobots(body), UA_TOKEN);
      matcher = { allowed: (u) => m.allowed(u), note: 'parsed' };
    } else if (/^\s*<(!doctype|html)/i.test(body)) {
      matcher.note = 'robots.txt returned an HTML page (bot challenge or SPA catch-all); treated as allow-all';
    }
  } catch (e) { matcher.note = `robots.txt unreachable (${e.message}); treated as allow-all`; }
  robotsCache.set(origin, matcher);
  return matcher;
}

async function get(url, opts = {}) {
  await sleep(500);
  let origin;
  try { origin = new URL(url).origin; } catch { return { ok: false, error: 'bad url' }; }
  const rb = await robotsFor(origin);
  if (!rb.allowed(url)) return { ok: false, blocked_by_robots: true, error: 'disallowed by robots.txt for our user-agent' };
  let plain;
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    plain = { ok: res.ok, status: res.status, finalUrl: res.url, text, retrieved_via: 'direct fetch' };
  } catch (e) { plain = { ok: false, error: e.message, retrieved_via: 'direct fetch' }; }

  // WHERE THE LINE IS.
  // ScrapingBee is used to RENDER a page whose content needs JavaScript. It is
  // NOT used to get past a bot wall. A 403 or a Cloudflare interstitial is the
  // site refusing this agent, and routing around that is exactly the evasion
  // hard rule 2 forbids -- so a refusal is recorded and the page is left alone.
  // (Tested 2026-08-29: sociabble.com returns Cloudflare "Just a moment..." to
  // ScrapingBee's rendered fetch too. We stopped rather than buying the stealth
  // proxy tier, and fall back to Wayback and FeaturedCustomers for that vendor.)
  const thin = plain.ok && (plain.text || '').length < 4000;
  if (!opts.allowBee || !bee.enabled || !thin || bee.creditsRemaining < 10) return plain;

  try {
    const r = await bee.fetch(url, { reason: ESCALATION.THIN, robotsAllowed: true });
    if (r?.ok && r.body && !/Just a moment|cf-browser-verification|challenge-platform/i.test(r.body)) {
      return { ok: true, status: r.status ?? 200, finalUrl: url, text: r.body,
        retrieved_via: 'ScrapingBee render_js (page needed JavaScript; robots.txt allows this URL)' };
    }
  } catch { /* fall through to the plain result */ }
  return plain;
}

// ---- name filtering -------------------------------------------------------
// Everything below exists because logo walls and card grids are full of things
// that are not customers: nav labels, award badges, the vendor's own name,
// integration partners, author bylines and cookie banners.
const NOT_A_COMPANY = new Set([
  'logo', 'logos', 'client logo', 'customer logo', 'company logo', 'brand logo',
  'g2', 'capterra', 'trustpilot', 'gartner', 'forrester', 'trustradius', 'getapp',
  'linkedin', 'twitter', 'x', 'facebook', 'instagram', 'youtube', 'tiktok', 'threads',
  'home', 'about', 'about us', 'pricing', 'blog', 'contact', 'contact us', 'careers',
  'login', 'sign in', 'sign up', 'menu', 'search', 'close', 'next', 'previous', 'arrow',
  'read more', 'learn more', 'case study', 'case studies', 'customer story', 'customers',
  'testimonial', 'testimonials', 'quote', 'star', 'stars', 'rating', 'avatar', 'photo',
  'image', 'icon', 'banner', 'hero', 'background', 'placeholder', 'thumbnail',
  'employee advocacy', 'social media', 'privacy policy', 'terms', 'cookie', 'cookies',
  'demo', 'book a demo', 'free trial', 'get started', 'watch the video', 'download',
  'apple', 'google play', 'app store', 'microsoft', 'salesforce', 'sharepoint', 'slack',
  'teams', 'microsoft teams', 'workday', 'okta', 'hubspot', 'marketo', 'zapier',
]);
const GENERIC_RE = /^(the |a )?(company|client|customer|partner|brand|team|user|logo|image|img|photo|picture|group|inc|ltd|llc|gmbh)\b/i;

function cleanName(raw) {
  if (!raw) return null;
  let n = String(raw)
    .replace(/&amp;/g, '&').replace(/&#0?39;|&rsquo;|&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  n = n.replace(/\s+(logo|logotype|icon|image|photo|wordmark)$/i, '').trim();
  n = n.replace(/^(logo|image|photo) (of|for)\s+/i, '').trim();
  n = n.replace(/\s*[-–|]\s*(case study|customer story|success story|testimonial).*$/i, '').trim();
  if (n.length < 2 || n.length > 60) return null;
  if (!/[a-zA-Z]/.test(n)) return null;
  const low = n.toLowerCase();
  if (NOT_A_COMPANY.has(low)) return null;
  if (GENERIC_RE.test(low)) return null;
  if (/^(https?:|www\.|\/)/i.test(n)) return null;
  if (/^\d+$/.test(n)) return null;
  // sentences are descriptions, not company names
  if (n.split(/\s+/).length > 7) return null;
  if (/[.!?]$/.test(n) && n.split(/\s+/).length > 3) return null;
  return n;
}

const slugToName = (slug) => cleanName(String(slug).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));

// ---- extraction -----------------------------------------------------------
function extractFromFeaturedCustomers(html) {
  const out = [];
  // Logo <img alt="Company"> plus the CDN filename, which carries the slug.
  for (const m of html.matchAll(/<img[^>]+src="https:\/\/cdn\.featuredcustomers\.com\/Company\.logo[^"]*\/([a-z0-9-]+)_\d+\.[a-z]+"[^>]*alt="([^"]{2,80})"/gi)) {
    const name = cleanName(m[2]) || slugToName(m[1]);
    if (name) out.push({ name, slug: m[1], how: 'logo on the vendor\'s FeaturedCustomers reference page (img alt text)' });
  }
  // Testimonial cards carry the company logo in data-vendor-logo plus contact.
  // The data-contact-* attributes are matched only to identify a testimonial card.
  // Their VALUES (a real person's name and job title) are deliberately not captured:
  // the owner ruled (2026-08-30) that scraped personal data must not enter the
  // dataset or the repo. Do not "fix" this by capturing them again.
  for (const m of html.matchAll(/data-vendor-logo="https:\/\/cdn\.featuredcustomers\.com\/Company\.logo[^"]*\/([a-z0-9-]+)_\d+\.[a-z]+"[^>]*?data-contact-name="[^"]*"[^>]*?data-contact-title="[^"]*"/gi)) {
    const name = slugToName(m[1]);
    if (name) out.push({ name, slug: m[1], how: 'named testimonial on the vendor\'s FeaturedCustomers reference page' });
  }
  return out;
}

function extractFromVendorSite(html, pageUrl, vendor) {
  const out = [];
  const vHost = registrableDomain(vendor.domain);

  // 1. logo walls: <img alt="Company"> whose src or class smells like a logo
  for (const m of html.matchAll(/<img[^>]*>/gi)) {
    const tag = m[0];
    const alt = (tag.match(/alt="([^"]{2,80})"/i) || [])[1];
    const src = (tag.match(/src="([^"]+)"/i) || [])[1] || '';
    const cls = (tag.match(/class="([^"]*)"/i) || [])[1] || '';
    if (!alt) continue;
    const looksLikeLogo = /logo|client|customer|brand|partner/i.test(src + ' ' + cls);
    if (!looksLikeLogo) continue;
    const name = cleanName(alt);
    if (name && registrableDomain(name) !== vHost) out.push({ name, how: `logo image on ${pageUrl} (img alt text)` });
  }

  // 2. case-study / customer-story links: the company is usually in the slug
  for (const m of html.matchAll(/href="([^"]*\/(?:case-stud(?:y|ies)|customer-stor(?:y|ies)|success-stor(?:y|ies)|portfolio|clients?)\/([a-z0-9][a-z0-9-]{2,60})\/?)"/gi)) {
    const slug = m[2];
    if (/^(index|all|page|category|tag|\d+)$/.test(slug)) continue;
    // strip the boilerplate suffix vendors append to case-study slugs
    const trimmed = slug.replace(/-(employee-advocacy|employee-influencers|social-selling|case-study|customer-story|success-story|personal-brands|advocacy|intranet|enterprise)(-.*)?$/g, '');
    const name = slugToName(trimmed);
    if (name) out.push({ name, how: `case-study URL on ${pageUrl} (${m[1]})` });
  }
  return out;
}


// ---- source 3: the vendor's sitemap ---------------------------------------
// A customer index page shows the first page of case studies. The sitemap shows
// all of them, including the ones paginated out of view.
const STORY_PATH = /\/(case-stud(?:y|ies)|customer-stor(?:y|ies)|success-stor(?:y|ies)|customers?|clients?|portfolio|testimonials?)\//i;

async function sitemapStoryUrls(vendor, seen = new Set(), depth = 0) {
  if (depth > 2) return [];
  const roots = depth === 0
    ? [new URL('/sitemap.xml', vendor.site).toString(), new URL('/sitemap_index.xml', vendor.site).toString(), new URL('/wp-sitemap.xml', vendor.site).toString()]
    : [...seen];
  const out = [];
  for (const sm of roots) {
    if (outOfTime()) break;
    const r = await get(sm);
    if (!r.ok || !r.text || !/<(urlset|sitemapindex)/i.test(r.text)) continue;
    const locs = [...r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    const isIndex = /<sitemapindex/i.test(r.text);
    if (isIndex) {
      // only descend into sub-sitemaps that could hold customer stories
      const kids = locs.filter((l) => STORY_PATH.test(l) || /(case|customer|client|story|stories|portfolio|page|post)/i.test(l)).slice(0, 6);
      out.push(...await sitemapStoryUrls(vendor, new Set(kids), depth + 1));
    } else {
      out.push(...locs.filter((l) => STORY_PATH.test(l)));
    }
    if (out.length > 1500) break;
  }
  return [...new Set(out)];
}

// ---- source 4: Wayback -----------------------------------------------------
// Case studies get pulled down when a customer churns or asks to be removed.
// The archive still has the URL, which makes this the only source in the whole
// index that can surface a FORMER customer. Rows from here are flagged
// historical: the relationship existed when the page did, and may not now.
async function waybackStoryUrls(vendor) {
  const host = registrableDomain(vendor.domain);
  const out = new Map();
  for (const pat of ['case-studies', 'customer-stories', 'customers', 'success-stories', 'portfolio', 'clients']) {
    if (outOfTime()) break;
    const u = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(host)}/${pat}/*&output=json&collapse=urlkey&limit=1200&fl=original,timestamp`;
    try {
      const res = await fetch(u, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(25000) });
      if (!res.ok) continue;
      const rows = await res.json();
      for (const [orig, ts] of rows.slice(1)) if (!out.has(orig)) out.set(orig, ts);
    } catch { /* archive.org is frequently slow; a miss is not a finding */ }
    await sleep(400);
  }
  return [...out.entries()];
}

// Turn a story URL into a candidate company name.
function nameFromStoryUrl(u) {
  let pathname;
  try { pathname = new URL(u).pathname; } catch { return null; }
  const segs = pathname.split('/').filter(Boolean);
  if (!segs.length) return null;
  const last = segs[segs.length - 1].replace(/\.(html?|php|aspx)$/i, '');
  if (STORY_PATH.test('/' + last + '/')) return null;
  if (/^(page|p|\d+|index|all|category|tag|feed|amp)$/i.test(last)) return null;
  const trimmed = last
    .replace(/^(case-study|customer-story|success-story|how)-/i, '')
    .replace(/-(employee-advocacy|employee-influencers|social-selling|case-study|customer-story|success-story|personal-brands|advocacy|intranet|internal-comms|enterprise|story|testimonial)(-.*)?$/gi, '');
  if (trimmed.length < 3 || trimmed.length > 45) return null;
  return slugToName(trimmed);
}

async function main() {
  await fs.mkdir(CACHE, { recursive: true });
  const all = [];
  const report = [];
  let remaining = 0;

  const todo = [];
  for (const vendor of VENDORS) {
    const cacheFile = path.join(CACHE, `${vendor.key}.json`);
    const cached = await fs.readFile(cacheFile, 'utf8').then(JSON.parse).catch(() => null);
    if (cached) { all.push(...cached.rows); report.push(cached.report); continue; }
    todo.push({ vendor, cacheFile });
  }

  // Vendors are independent hosts, so they run in parallel. Within one vendor
  // the fetches stay sequential with a delay, so no single site is hammered.
  await mapPool(todo, Number(process.env.VENDOR_CONCURRENCY || 5), async ({ vendor, cacheFile }) => {
    if (outOfTime()) { remaining++; return; }
    const lines = [`\n== ${vendor.name}`];
    const log = (...a) => lines.push(a.join(' '));
    const found = new Map();   // name -> row
    const pages = [];

    // --- source 1: FeaturedCustomers
    if (vendor.fcSlug) {
      const url = `https://www.featuredcustomers.com/vendor/${vendor.fcSlug}`;
      const r = await get(url, { allowBee: true });
      pages.push({ url, status: r.status ?? null, blocked_by_robots: Boolean(r.blocked_by_robots), error: r.error ?? null, retrieved_via: r.retrieved_via ?? null });
      if (r.ok && r.text) {
        for (const c of extractFromFeaturedCustomers(r.text)) {
          if (!found.has(c.name)) found.set(c.name, { ...c, source: 'FeaturedCustomers', page: url, retrieved_via: r.retrieved_via });
        }
        log(`   featuredcustomers: ${found.size} name(s)`);
      } else {
        log(`   featuredcustomers: ${r.blocked_by_robots ? 'BLOCKED BY ROBOTS' : r.status || r.error}`);
      }
    }

    // --- source 2: the vendor's own site
    const before = found.size;
    for (const p of CANDIDATE_PATHS) {
      if (outOfTime()) break;
      const url = new URL(p, vendor.site).toString();
      const r = await get(url, { allowBee: true });
      if (r.blocked_by_robots) { pages.push({ url, blocked_by_robots: true }); continue; }
      if (!r.ok || !r.text) { pages.push({ url, status: r.status ?? null, error: r.error ?? null }); continue; }
      pages.push({ url, status: r.status, bytes: r.text.length, retrieved_via: r.retrieved_via ?? null });
      for (const c of extractFromVendorSite(r.text, url, vendor)) {
        if (!found.has(c.name)) found.set(c.name, { ...c, source: 'vendor site', page: url, retrieved_via: r.retrieved_via });
      }
    }
    log(`   vendor site: +${found.size - before} name(s)`);

    // --- source 3: sitemap-discovered story pages
    let b3 = found.size;
    let storyUrls = [];
    if (!outOfTime()) {
      storyUrls = await sitemapStoryUrls(vendor);
      for (const u of storyUrls) {
        const name = nameFromStoryUrl(u);
        if (name && !found.has(name)) found.set(name, { name, source: 'vendor site', page: u, how: `case-study page listed in ${vendor.domain}'s sitemap (${u})` });
      }
      log(`   sitemap: ${storyUrls.length} story URL(s) -> +${found.size - b3} name(s)`);
    }

    // --- source 4: Wayback (former customers)
    let b4 = found.size, waybackCount = 0;
    if (!outOfTime()) {
      const wb = await waybackStoryUrls(vendor);
      waybackCount = wb.length;
      const liveSet = new Set(storyUrls.map((u) => { try { return new URL(u).pathname.replace(/\/$/, ''); } catch { return u; } }));
      for (const [u, ts] of wb) {
        const name = nameFromStoryUrl(u);
        if (!name || found.has(name)) continue;
        let p; try { p = new URL(u).pathname.replace(/\/$/, ''); } catch { p = u; }
        found.set(name, { name, source: 'wayback', page: u, archived: ts,
          historical: !liveSet.has(p),
          how: `case-study page archived at ${u} (first capture ${String(ts).slice(0, 8)})${liveSet.has(p) ? '' : ', no longer present in the live sitemap'}` });
      }
      log(`   wayback: ${waybackCount} archived URL(s) -> +${found.size - b4} name(s)`);
    }

    const blocked = pages.filter((p) => p.blocked_by_robots).map((p) => p.url);
    const challenged = pages.filter((p) => p.status === 403 || p.status === 401).map((p) => p.url);

    const rows = [...found.values()].map((c) => ({
      vendor_key: vendor.key, vendor_name: vendor.name, vendor_tier: vendor.tier,
      is_client_vendor: Boolean(vendor.isClient),
      domain: null, domain_source: null,
      customer_token: null,          // filled by the resolver
      customer_name: c.name,
      evidence: {
        source: c.source === 'FeaturedCustomers' ? 'FeaturedCustomers (vendor reference page)'
          : c.source === 'wayback' ? 'Wayback Machine (archived vendor page)' : 'Vendor website',
        historical: Boolean(c.historical),
        archived_timestamp: c.archived || null,
        app_name: null, bundle_id: null, bundle_customer_token: null,
        developer_account: null, developer_id: null, seller_url: null,
        app_url: c.page,
        claim: c.how,
        retrieved_via: c.retrieved_via || 'direct fetch',
        // The contact name/title fields are intentionally absent — see extractFromFeaturedCustomers.
        first_released: null, last_updated: null, description_excerpt: '',
      },
    }));

    const rep = { key: vendor.key, name: vendor.name, tier: vendor.tier, names: rows.length,
      pages_tried: pages.length, robots_blocked: blocked, bot_challenged: challenged,
      sitemap_story_urls: storyUrls.length, wayback_urls: waybackCount,
      historical_names: rows.filter((r) => r.evidence.historical).length };
    if (blocked.length) log(`   ROBOTS-BLOCKED: ${blocked.join(', ')}`);
    if (challenged.length) log(`   bot-challenged (403/401), not evaded: ${challenged.length} page(s)`);
    log(`   -> ${rows.length} candidate customer name(s)`);

    await fs.writeFile(cacheFile, JSON.stringify({ report: rep, rows }, null, 2));
    all.push(...rows); report.push(rep);
    console.error(lines.join('\n'));
  });

  await fs.writeFile(OUT, JSON.stringify({ schema: 2, built_at: new Date().toISOString(),
    scrapingbee_credits_used: bee.creditsUsed, vendors: report, rows: all }, null, 2));
  log(`\nWROTE ${OUT}  rows=${all.length}`);
  if (remaining) log(`${remaining} vendor(s) left -- re-run.`); else log('ALL VENDORS DONE.');
}
main().catch((e) => { console.error(e); process.exit(1); });
