#!/usr/bin/env node
// Builds the incumbent-vendor index: which companies already run an employee
// advocacy or employee-comms platform, evidenced by a white-labeled mobile app
// published under the vendor's own developer account.
//
// This is built ONCE from the vendor side and cached. It is never a per-run
// fetch of the graded domain.
//
// Honesty constraints baked in (spec §7):
//   - Every row carries the raw evidence that produced it.
//   - A miss means "not found in this index", never "no incumbent".
//   - Apple's Search API is a public, documented, no-auth endpoint. We throttle.

import fs from 'node:fs/promises';
import path from 'node:path';
import { VENDORS } from '../lib/vendors.js';
import { registrableDomain, NON_CUSTOMER_HOSTS } from '../lib/domain.js';

const UA = 'AdvocacyReadinessGrader/0.1.0 (+https://greg-o-matic.com/grader)';
const COUNTRIES = ['us', 'gb', 'de', 'fr', 'nl', 'se', 'in', 'au', 'ca', 'es', 'it', 'be'];
const SLEEP_MS = Number(process.env.ITUNES_SLEEP_MS || 1200);
const OUT = path.resolve(process.cwd(), 'data/vendor-app-index.json');
const CACHE = path.resolve(process.cwd(), 'data/.vendor-cache');
// Each shell invocation is short-lived, so the build is resumable: every vendor
// is cached on completion and re-runs skip what is already done. Re-run until
// it prints ALL VENDORS CACHED.
const BUDGET_MS = Number(process.env.BUDGET_MS || 33000);
const startedAt = Date.now();
const outOfTime = () => Date.now() - startedAt > BUDGET_MS;

// Seller URLs some vendors fill in with a partner's or a tool's domain rather
// than the customer's. Observed live: two Staffbase apps list freshservice.com.
const BAD_SELLER_DOMAINS = new Set(['freshservice.com', 'freshworks.com', 'sharepoint.com', 'microsoft.com', 'salesforce.com']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(...a);

let calls = 0;
async function api(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    await sleep(SLEEP_MS);
    calls++;
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
      if (res.status === 403 || res.status === 429) { log(`  rate-limited (${res.status}), backing off`); await sleep(15000); continue; }
      if (!res.ok) { log(`  HTTP ${res.status} ${url}`); return null; }
      const text = await res.text();
      if (!text.trim()) return null;
      return JSON.parse(text);
    } catch (e) {
      log(`  fetch error (${e.message}) attempt ${i + 1}`);
      await sleep(3000);
    }
  }
  return null;
}

const matchesVendor = (vendor, rec) => {
  const bundle = (rec.bundleId || '').toLowerCase();
  const seller = (rec.sellerName || '').toLowerCase();
  if (vendor.bundlePrefixes.some((p) => bundle.startsWith(p.toLowerCase()))) return true;
  const token = vendor.key.replace(/_/g, '');
  return seller.replace(/[^a-z0-9]/g, '').includes(token) && token.length > 4;
};

async function resolveArtistIds(vendor) {
  const found = new Map();
  for (const id of vendor.artistIds) found.set(id, 'seeded');
  for (const term of vendor.search) {
    for (const country of ['us', 'gb', 'de']) {
      const d = await api(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=software&limit=25&country=${country}`);
      for (const r of d?.results || []) {
        if (matchesVendor(vendor, r) && r.artistId && !found.has(r.artistId)) {
          found.set(r.artistId, `search "${term}" (${country}) -> ${r.sellerName} / ${r.bundleId}`);
        }
      }
      if (found.size > vendor.artistIds.length) break; // one hit is enough per term
    }
  }
  return found;
}

async function appsForArtist(artistId) {
  const byBundle = new Map();
  let truncated = false;
  for (const country of COUNTRIES) {
    const d = await api(`https://itunes.apple.com/lookup?id=${artistId}&entity=software&limit=200&country=${country}`);
    const apps = (d?.results || []).filter((r) => r.wrapperType === 'software');
    if (apps.length >= 200) truncated = true;
    for (const a of apps) if (!byBundle.has(a.bundleId)) byBundle.set(a.bundleId, { ...a, _country: country });
    // Storefronts almost always return the developer's full catalogue; stop
    // early once two consecutive countries add nothing new.
    if (country !== 'us' && apps.length && ![...byBundle.values()].some((x) => x._country === country)) break;
  }
  return { apps: [...byBundle.values()], truncated };
}

function customerNameFromBundle(vendor, bundleId) {
  for (const p of vendor.bundlePrefixes) {
    if (bundleId.toLowerCase().startsWith(p.toLowerCase())) {
      return bundleId.slice(p.length).replace(/\.(engage|ios|appstore|android)(\..*)?$/i, '').replace(/\.(ios|appstore)$/i, '');
    }
  }
  return null;
}

async function main() {
  await fs.mkdir(CACHE, { recursive: true });
  const rows = [];
  const vendorReport = [];
  let remaining = 0;

  for (const vendor of VENDORS) {
    const cacheFile = path.join(CACHE, `${vendor.key}.json`);
    const cached = await fs.readFile(cacheFile, 'utf8').then(JSON.parse).catch(() => null);
    if (cached) { rows.push(...cached.rows); vendorReport.push(cached.report); continue; }
    if (outOfTime()) { remaining++; continue; }

    log(`\n== ${vendor.name} (${vendor.tier})`);
    const artists = await resolveArtistIds(vendor);
    if (!artists.size) {
      const report = { key: vendor.key, name: vendor.name, tier: vendor.tier, artist_ids: [], apps: 0, customers: 0, note: 'no Apple developer account resolved' };
      log('   no developer account found');
      await fs.writeFile(cacheFile, JSON.stringify({ report, rows: [] }, null, 2));
      vendorReport.push(report);
      continue;
    }

    let apps = [], truncatedAny = false;
    for (const [artistId, how] of artists) {
      log(`   artistId ${artistId} (${how})`);
      const { apps: a, truncated } = await appsForArtist(artistId);
      truncatedAny = truncatedAny || truncated;
      apps.push(...a.map((x) => ({ ...x, _artistId: artistId })));
    }

    const vendorRows = [];
    let customers = 0;
    const vendorDomains = new Set([vendor.domain, ...(vendor.altDomains || [])].map(registrableDomain).filter(Boolean));
    for (const app of apps) {
      const sellerDomain = registrableDomain(app.sellerUrl);
      const sellerIsCustomer = Boolean(sellerDomain) && !vendorDomains.has(sellerDomain) && !NON_CUSTOMER_HOSTS.has(sellerDomain) && !BAD_SELLER_DOMAINS.has(sellerDomain);
      const nameToken = customerNameFromBundle(vendor, app.bundleId || '');
      // The vendor's flagship app: no customer token AND no third-party seller
      // domain. Several vendors (DSMN8, Ambassify) put their OWN url on every
      // customer app, so a vendor-owned sellerUrl must not disqualify a row --
      // the bundle token still identifies the customer.
      if (!sellerIsCustomer && (!nameToken || nameToken.length < 3)) continue;
      customers++;
      vendorRows.push({
        domain: sellerIsCustomer ? sellerDomain : null,
        domain_source: sellerIsCustomer ? 'app sellerUrl (vendor-declared)' : null,
        customer_token: nameToken,
        vendor_key: vendor.key,
        vendor_name: vendor.name,
        vendor_tier: vendor.tier,
        is_client_vendor: Boolean(vendor.isClient),
        evidence: {
          source: 'Apple App Store',
          app_name: app.trackName,
          bundle_id: app.bundleId,
          bundle_customer_token: nameToken,
          developer_account: app.sellerName,
          developer_id: app._artistId,
          seller_url: app.sellerUrl,
          app_url: app.trackViewUrl,
          first_released: app.releaseDate,
          last_updated: app.currentVersionReleaseDate,
          description_excerpt: (app.description || '').replace(/\s+/g, ' ').slice(0, 240),
        },
      });
    }
    log(`   ${apps.length} apps -> ${customers} customer rows${truncatedAny ? '  [WARN: hit 200-app cap, may be truncated]' : ''}`);
    const report = { key: vendor.key, name: vendor.name, tier: vendor.tier, artist_ids: [...artists.keys()], apps: apps.length, customers, truncated: truncatedAny };
    await fs.writeFile(cacheFile, JSON.stringify({ report, rows: vendorRows }, null, 2));
    rows.push(...vendorRows);
    vendorReport.push(report);
  }

  const byDomain = {};
  for (const r of rows) {
    if (!r.domain) continue;
    (byDomain[r.domain] ||= []).push(r);
  }

  const out = {
    schema: 1,
    built_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    api_calls: calls,
    method: 'Vendors publish their customers\' white-labeled apps under the vendor\'s own Apple developer account. Enumerating that account yields a customer list; the app record\'s sellerUrl gives the customer\'s own domain, which is the join key.',
    limitations: [
      'Absence from this index is NOT evidence that a company has no incumbent vendor. Many vendors have no white-label tier, many customers deploy web-only, and Android-only deployments are not covered here.',
      'An app proves a vendor relationship existed at first_released. It does not prove the contract is current.',
      'sellerUrl is supplied by the vendor at submission time and is occasionally the vendor\'s own domain rather than the customer\'s; those rows are dropped, which undercounts.',
      'Tier "comms" vendors sell intranet//frontline apps. A match proves the platform, not that the customer bought its advocacy module.',
    ],
    vendors: vendorReport,
    domains: byDomain,
    rows,
  };

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(out, null, 2));
  log(`\nWROTE ${OUT}`);
  log(`rows=${rows.length} distinct_domains=${Object.keys(byDomain).length} api_calls=${calls}`);
  if (remaining) log(`\n${remaining} vendor(s) still to do -- re-run this script to continue.`);
  else log('\nALL VENDORS CACHED.');
}

main().catch((e) => { console.error(e); process.exit(1); });
