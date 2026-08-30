// Sitemap discovery, recursion and parsing. Dependency-free XML extraction:
// sitemaps are a narrow, well-formed subset and full XML parsing buys nothing here.
import { gunzipSync } from 'node:zlib';

export const FALLBACK_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap1.xml', '/wp-sitemap.xml'];

function decode(res) {
  let body = res.body;
  if (/\.gz($|\?)/i.test(res.finalUrl || res.url) || (res.buffer && res.buffer[0] === 0x1f && res.buffer[1] === 0x8b)) {
    try { body = gunzipSync(res.buffer).toString('utf8'); } catch { /* leave as-is; recorded below */ }
  }
  return body;
}

function unescapeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// Returns { kind: 'index'|'urlset'|'unknown', entries:[{loc,lastmod}] }
export function parseSitemapXml(xml, baseUrl = null) {
  // <loc> is required by the sitemap spec to be absolute, but real sitemaps
  // break that (basecamp.com ships "/" and "/about"). Resolve against the
  // sitemap's own URL rather than dropping the entire inventory on the floor.
  const abs = (loc) => {
    try { return new URL(loc).toString(); }
    catch { try { return baseUrl ? new URL(loc, baseUrl).toString() : null; } catch { return null; } }
  };
  if (!xml) return { kind: 'unknown', entries: [] };
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const blockRe = isIndex ? /<sitemap[\s>][\s\S]*?<\/sitemap>/gi : /<url[\s>][\s\S]*?<\/url>/gi;
  const entries = [];
  const blocks = xml.match(blockRe);
  if (blocks) {
    for (const b of blocks) {
      const loc = /<loc>\s*([\s\S]*?)\s*<\/loc>/i.exec(b);
      const lm = /<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i.exec(b);
      if (loc) {
        const resolved = abs(unescapeXml(loc[1].trim()));
        if (resolved) entries.push({ loc: resolved, lastmod: lm ? lm[1].trim() : null });
      }
    }
  } else {
    // Some sitemaps omit the wrapper elements we expect; fall back to bare <loc>.
    const locs = xml.match(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi) || [];
    for (const l of locs) {
      const resolved = abs(unescapeXml(l.replace(/<\/?loc>/gi, '').trim()));
      if (resolved) entries.push({ loc: resolved, lastmod: null });
    }
  }
  return { kind: isIndex ? 'index' : entries.length ? 'urlset' : 'unknown', entries };
}

export async function collectSitemaps({ fetcher, matcher, seeds, origin, maxSitemaps = 60, maxUrls = 60000 }) {
  const queue = [...new Set(seeds)];
  const seen = new Set();
  const documents = [];
  const urls = [];
  const urlIndex = new Map(); // loc -> index in `urls`; sitemaps repeat URLs in the wild
  const notes = [];
  let fetched = 0;
  let duplicates = 0;

  while (queue.length && fetched < maxSitemaps && urls.length < maxUrls) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);

    if (!matcher.allowed(url)) {
      documents.push({ url, status: null, kind: 'skipped', reason: 'disallowed by robots.txt for our user-agent', entries: 0 });
      notes.push(`Skipped ${url}: robots.txt disallows it for our user-agent.`);
      continue;
    }
    const res = await fetcher.get(url, { note: 'sitemap', accept: 'application/xml,text/xml,*/*' });
    fetched++;
    if (!res.ok) {
      documents.push({ url, status: res.status, kind: 'error', reason: res.error || `HTTP ${res.status}`, entries: 0 });
      continue;
    }
    const xml = decode(res);
    const parsed = parseSitemapXml(xml, res.finalUrl || url);
    const withLastmod = parsed.entries.filter((e) => e.lastmod).length;
    documents.push({
      url, status: res.status, kind: parsed.kind, bytes: res.bytes, entries: parsed.entries.length,
      entries_with_lastmod: withLastmod,
    });
    if (parsed.kind === 'index') {
      for (const e of parsed.entries) if (!seen.has(e.loc)) queue.push(e.loc);
    } else {
      for (const e of parsed.entries) {
        if (urls.length >= maxUrls) break;
        const key = e.loc.replace(/#.*$/, '');
        if (urlIndex.has(key)) {
          duplicates++;
          const prev = urls[urlIndex.get(key)];
          if (!prev.lastmod && e.lastmod) prev.lastmod = e.lastmod;
          if (!prev.also_in.includes(url)) prev.also_in.push(url);
          continue;
        }
        urlIndex.set(key, urls.length);
        urls.push({ loc: key, lastmod: e.lastmod, from: url, also_in: [] });
      }
    }
  }
  if (queue.length) notes.push(`Sitemap traversal capped: ${queue.length} sitemap document(s) left unfetched (limit ${maxSitemaps}).`);
  if (urls.length >= maxUrls) notes.push(`URL collection capped at ${maxUrls}; totals below are a floor, not the full inventory.`);
  if (duplicates) notes.push(`${duplicates} URL(s) appeared in more than one sitemap document and were counted once. Deduplicated inventory is ${urls.length}.`);
  return { documents, urls, notes, duplicates };
}

export function lastmodStats(urls) {
  const withLm = urls.filter((u) => u.lastmod);
  const parsedDates = withLm.map((u) => Date.parse(u.lastmod)).filter(Number.isFinite);
  const dates = [...parsedDates].sort((a, b) => b - a);
  const now = Date.now(), day = 86400000;

  // lastmod is frequently a CMS build timestamp rather than a content-edit date.
  // Scoring recency off a build stamp would credit a site for freshness it does not
  // have, which spec §7 rule 1 forbids. Detect the tell-tale shapes and say so.
  const dayCounts = new Map();
  for (const d of parsedDates) {
    const k = new Date(d).toISOString().slice(0, 10);
    dayCounts.set(k, (dayCounts.get(k) || 0) + 1);
  }
  const ranked = [...dayCounts.entries()].sort((a, b) => b[1] - a[1]);
  const topDate = ranked[0] || null;
  const topShare = topDate && parsedDates.length ? Math.round((topDate[1] / parsedDates.length) * 1000) / 10 : 0;
  const distinctDays = dayCounts.size;
  const spanDays = dates.length ? Math.round((dates[0] - dates[dates.length - 1]) / day) : 0;

  const reasons = [];
  if (topShare >= 15) reasons.push(`${topShare}% of all lastmod values fall on a single day (${topDate[0]}), which is the signature of a site-wide rebuild rather than individual edits.`);
  if (parsedDates.length >= 300 && spanDays > 0 && spanDays < 550) reasons.push(`The entire inventory's lastmod range spans only ${spanDays} days, which is implausibly short for ${parsedDates.length} pages and suggests the dates were regenerated.`);
  // Only meaningful when edits cluster onto a tiny fraction of the days available.
  // A large site legitimately publishes many pages per day, so a raw URLs-per-date
  // ratio is not evidence on its own.
  if (parsedDates.length >= 300 && spanDays > 60 && distinctDays < spanDays * 0.05) reasons.push(`Edits cluster onto ${distinctDays} distinct days out of a ${spanDays}-day range, too few to represent ongoing publishing.`);
  const looksGenerated = reasons.length > 0;

  return {
    urls_total: urls.length,
    urls_with_lastmod: withLm.length,
    lastmod_coverage_pct: urls.length ? Math.round((withLm.length / urls.length) * 1000) / 10 : 0,
    newest: dates.length ? new Date(dates[0]).toISOString().slice(0, 10) : null,
    oldest: dates.length ? new Date(dates[dates.length - 1]).toISOString().slice(0, 10) : null,
    distinct_dates: distinctDays,
    span_days: spanDays,
    most_common_date: topDate ? { date: topDate[0], urls: topDate[1], share_pct: topShare } : null,
    updated_last_30d: dates.filter((d) => now - d <= 30 * day).length,
    updated_last_90d: dates.filter((d) => now - d <= 90 * day).length,
    updated_last_365d: dates.filter((d) => now - d <= 365 * day).length,
    lastmod_looks_machine_generated: looksGenerated,
    credibility_reasons: reasons,
    recency_measurable: withLm.length > 0 && !looksGenerated,
    note: withLm.length === 0
      ? 'No lastmod values present anywhere in this sitemap. Content recency cannot be measured for this domain and must not be inferred.'
      : looksGenerated
        ? 'lastmod is present but does not look like genuine edit history. The counts above describe the dates as published; they should NOT be reported to the visitor as content freshness.'
        : withLm.length < urls.length * 0.95
          ? 'lastmod is present on only part of the inventory. Recency figures describe that subset only.'
          : null,
  };
}
