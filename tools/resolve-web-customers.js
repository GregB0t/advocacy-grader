#!/usr/bin/env node
// Resolve scraped customer NAMES to domains.
//
// This is a better-conditioned problem than the app-store bundle tokens were.
// There we had "burnsmcdonnell" and had to guess; here we have "Burns &
// McDonnell" and can check it against the live site's own title. A name that
// matches the title of the domain it resolves to is real corroboration, not the
// tautology that "the token appears in the domain we built from the token".
//
// Confidence here never reaches "confirmed": the vendor published the NAME, not
// the domain, so the domain is always our inference. "confirmed" stays reserved
// for a vendor declaring the customer's own URL (app-store sellerUrl rows).
//
// Resumable: one cache entry per name. Re-run until it prints ALL NAMES DONE.

import fs from 'node:fs/promises';
import path from 'node:path';
import { VENDORS, VENDOR_BY_KEY } from '../lib/vendors.js';
import { registrableDomain } from '../lib/domain.js';
import { cleanCustomerName, normalizeCompany, domainCandidates } from '../lib/customer-name.js';
import { UA, UA_TOKEN } from '../lib/http.js';
import { parseRobots, makeMatcher } from '../lib/robots.js';
import { mapPool } from '../lib/pool.js';
import dns from 'node:dns/promises';

// Most candidate domains do not exist. A DNS lookup settles that in ~50ms and
// saves two HTTP fetches (robots.txt + homepage) per dead candidate. Without it
// the run saturates its own network and healthy domains start timing out --
// sentinelone.com came back "no_site" at concurrency 25 and resolved in 492ms
// on its own, which is a measurement artefact, not a finding.
async function hostExists(host) {
  try { const r = await dns.resolve4(host); return r.length > 0; }
  catch {
    try { const r6 = await dns.resolve6(host); return r6.length > 0; } catch { return false; }
  }
}

const IN = path.resolve(process.cwd(), 'data/web-customer-index.json');
const OUT = path.resolve(process.cwd(), 'data/web-customer-resolved.json');
const CACHE = path.resolve(process.cwd(), 'data/.webresolve-cache.json');
const BUDGET_MS = Number(process.env.BUDGET_MS || 33000);
const t0 = Date.now();
const outOfTime = () => Date.now() - t0 > BUDGET_MS;
const log = (...a) => console.error(...a);

const PARKING = new Set(['hugedomains.com','sedo.com','sedoparking.com','dan.com','afternic.com','undeveloped.com','buydomains.com','domainmarket.com','squadhelp.com','atom.com','namecheap.com','godaddy.com','bodis.com','parkingcrew.com','above.com','uniregistry.com','domain.com','name.com','escrow.com','brandbucket.com','saw.com']);
const PARKED_TEXT = /(domain\s+(is\s+)?for\s+sale|buy\s+this\s+domain|parked\s+(free\s+)?at|namecheap\s+parking|under\s+construction|coming\s+soon)/i;

async function fetchText(url, timeout = 8000) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
    return { ok: res.ok, status: res.status, finalUrl: res.url, text: await res.text() };
  } catch (e) { return { ok: false, status: null, error: e.message }; }
}

async function tryCandidate(candidate, companyName) {
  const rb = await fetchText(`https://${candidate}/robots.txt`, 5000);
  if (rb.ok && rb.text && !/^\s*<(!doctype|html)/i.test(rb.text)) {
    const m = makeMatcher(parseRobots(rb.text), UA_TOKEN);
    if (m && !m.allowed('/')) return { domain: null, signal: 'robots_blocked', why: `robots.txt on ${candidate} disallows our user-agent at /; not fetched (spec §7 rule 5)` };
  }
  const res = await fetchText(`https://${candidate}/`, 8000);
  if (!res.ok && res.status) {
    if ([401, 403, 405, 406, 429, 503].includes(res.status)) {
      return { domain: candidate, signal: 'exists_blocked', why: `https://${candidate}/ exists but returned HTTP ${res.status} to our user-agent, so its page could not corroborate the name "${companyName}".` };
    }
    return { domain: null, signal: 'no_site', why: `https://${candidate}/ returned HTTP ${res.status}` };
  }
  if (!res.ok) return { domain: null, signal: 'no_site', why: `https://${candidate}/ did not respond (${res.error})` };
  if ((res.text || '').length < 1500) return { domain: null, signal: 'no_site', why: `https://${candidate}/ returned a near-empty page` };

  const title = ((res.text.match(/<title[^>]*>([\s\S]{0,250}?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  const ogSite = ((res.text.match(/property=["']og:site_name["'][^>]*content=["']([^"']{0,120})["']/i) || [])[1] || '').trim();
  const finalDomain = registrableDomain(res.finalUrl) || candidate;
  if (PARKING.has(finalDomain)) return { domain: null, signal: 'parked', why: `${candidate} redirects to the domain broker ${finalDomain}` };
  if (PARKED_TEXT.test(title)) return { domain: null, signal: 'parked', why: `${candidate} looks parked (title: "${title}")` };

  const hay = normalizeCompany(title + ' ' + ogSite);
  const needle = normalizeCompany(companyName);
  if (needle.length >= 4 && hay.includes(needle)) {
    return { domain: finalDomain, signal: 'title_match', title,
      why: `${candidate} resolves to ${finalDomain} and its own page title names "${companyName}" (title: "${title}") — the site corroborates the vendor's claim independently.` };
  }
  return { domain: finalDomain, signal: 'exists_only', title,
    why: `${candidate} is a live site (title: "${title}") but its title does not name "${companyName}", so nothing corroborates the match beyond the name spelling a live domain.` };
}

async function resolveName(companyName) {
  const cands = domainCandidates(companyName);
  if (!cands.length) return { domain: null, signal: 'no_candidate', why: `No usable domain candidate could be formed from "${companyName}".` };

  // DNS-filter every candidate in parallel FIRST. Most candidates do not exist,
  // and an HTTP probe of a non-existent host costs two slow timeouts where a
  // DNS lookup costs ~50ms. Without this the pass spends all its time waiting
  // on hosts that were never there.
  const live = (await Promise.all(cands.map(async (c) => (await hostExists(c)) || (await hostExists('www.' + c)) ? c : null))).filter(Boolean);
  if (!live.length) return { domain: null, signal: 'no_dns', why: `None of ${cands.slice(0, 6).join(', ')} has a DNS record.` };

  const deadline = Date.now() + Number(process.env.NAME_MS || 22000);
  // A country TLD may be live while .com is the company's actual home. Taking
  // the first live candidate as the fallback gave Shake Shack shakeshack.de and
  // the WHO worldhealthorganization.nl. So: a title match wins anywhere, but an
  // UNCORROBORATED fallback is only ever taken from a generic TLD, and a
  // country-TLD fallback is used only when no generic one answered at all.
  const GENERIC_TLD = /\.(com|io|co|net|org)$/;
  let genericFallback = null, countryFallback = null;
  for (const c of live.slice(0, Number(process.env.MAX_CANDIDATES || 4))) {
    if (Date.now() > deadline) break;
    const r = await tryCandidate(c, companyName);
    if (r.signal === 'title_match') return r;
    if (r.domain || r.signal === 'robots_blocked') {
      if (GENERIC_TLD.test(c)) { if (!genericFallback) genericFallback = r; }
      else if (!countryFallback) countryFallback = r;
    }
  }
  const fallback = genericFallback || countryFallback;
  if (fallback && fallback === countryFallback && fallback.why) {
    fallback.why += ' No generic-TLD candidate answered, so this country-TLD host is the only thing that responded — it may not be the company\'s primary domain.';
  }
  return fallback || { domain: null, signal: 'no_site', why: `${live.join(', ')} resolved in DNS but none served a page corroborating "${companyName}".` };
}

async function main() {
  const raw = JSON.parse(await fs.readFile(IN, 'utf8'));
  const cache = await fs.readFile(CACHE, 'utf8').then(JSON.parse).catch(() => ({}));

  // vendor names must not be logged as customers of each other from comparison
  // pages; kept as a count so the filtering is visible rather than silent.
  const vendorNames = new Set(VENDORS.flatMap((v) => [normalizeCompany(v.key), normalizeCompany(v.name.split('(')[0])]));

  const rows = []; let droppedName = 0, droppedVendor = 0;
  const seen = new Set();
  for (const r of raw.rows) {
    const name = cleanCustomerName(r.customer_name);
    if (!name) { droppedName++; continue; }
    const key = normalizeCompany(name);
    if (!key || key.length < 2) { droppedName++; continue; }
    if (vendorNames.has(key)) { droppedVendor++; continue; }
    // A vendor's name EMBEDDED in a longer string is a filename or a comparison
    // label, never a customer: "DSMN8 Website Client - Dropbox".
    if ([...vendorNames].some((vn) => vn.length >= 5 && key.includes(vn))) { droppedVendor++; continue; }
    if (/\b(website|client|template|example|sample|placeholder|asset|mockup|screenshot)\b/i.test(name)) { droppedName++; continue; }
    const dedupe = `${r.vendor_key}::${key}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    rows.push({ ...r, customer_name: name, name_key: key });
  }
  log(`${raw.rows.length} raw -> ${rows.length} rows (dropped ${droppedName} non-company strings, ${droppedVendor} vendor names, ${raw.rows.length - rows.length - droppedName - droppedVendor} duplicates)`);

  const todo = [...new Set(rows.map((r) => r.name_key))].filter((k) => !(k in cache));
  let pending = 0;
  if (todo.length) {
    const batch = todo.slice(0, Number(process.env.BATCH || 90));
    pending = todo.length - batch.length;
    log(`resolving ${batch.length} distinct company name(s), ${pending} left after this pass`);
    const nameFor = Object.fromEntries(rows.map((r) => [r.name_key, r.customer_name]));
    let done = 0;
    await mapPool(batch, Number(process.env.CONCURRENCY || 15), async (k) => {
      const v = await resolveName(nameFor[k]);
      cache[k] = v; done++;
      log(`  ${nameFor[k]} -> ${v.domain || 'UNRESOLVED'} [${v.signal}]`);
      if (done % 3 === 0) await fs.writeFile(CACHE, JSON.stringify(cache, null, 2));
    });
    await fs.writeFile(CACHE, JSON.stringify(cache, null, 2));
  }

  const out = [];
  for (const r of rows) {
    const v = cache[r.name_key];
    if (!v) continue;
    const corroborated = v.signal === 'title_match';
    out.push({
      ...r,
      domain: v.domain || null,
      domain_source: v.domain ? `inferred from the customer name "${r.customer_name}" (${v.signal})` : null,
      customer_token: r.name_key,
      resolution_signal: v.signal,
      confidence: !v.domain ? 'named_unresolved' : corroborated ? 'probable' : 'possible',
      confidence_basis: `${r.vendor_name} publicly names "${r.customer_name}" as a customer — ${r.evidence.claim}. The vendor published the NAME, not the domain, so the domain is our inference: ${v.why}${corroborated ? '' : ' Unconfirmed: do not assert this domain.'}`,
    });
  }

  const domains = {};
  for (const r of out) if (r.domain) (domains[r.domain] ||= []).push(r);
  const tally = out.reduce((a, r) => { a[r.confidence] = (a[r.confidence] || 0) + 1; return a; }, {});
  await fs.writeFile(OUT, JSON.stringify({ schema: 1, built_at: raw.built_at, resolved_at: new Date().toISOString(),
    counts: { rows: out.length, distinct_domains: Object.keys(domains).length, by_confidence: tally,
      dropped_non_company: droppedName, dropped_vendor_names: droppedVendor }, rows: out }, null, 2));
  log(`\nrows=${out.length} domains=${Object.keys(domains).length} ${JSON.stringify(tally)}`);
  if (pending) log(`${pending} name(s) left -- re-run.`); else log('ALL NAMES DONE.');
}
main().catch((e) => { console.error(e); process.exit(1); });
