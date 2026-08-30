#!/usr/bin/env node
// Google Play half of the incumbent index.
//
// Play's developer pages are plain HTML (no JS rendering, no ScrapingBee), and
// robots.txt allows both /store/apps/developer and /store/apps/details -- the
// only /store/apps rules are for datasafety, editorial and p3_details
// collections. Verified live 2026-08-28.
//
// What Play adds over iOS: Android-only customers. What it does NOT add is a
// domain -- a Play listing carries the VENDOR's website and privacy URL, never
// the customer's, so every Play row starts with a token and no domain and must
// go through the same verification as the iOS token rows.
//
// Resumable, one cache file per vendor.

import fs from 'node:fs/promises';
import path from 'node:path';
import { VENDORS } from '../lib/vendors.js';

const CACHE = path.resolve(process.cwd(), 'data/.play-cache');
const OUT = path.resolve(process.cwd(), 'data/play-app-index.json');
const BUDGET_MS = Number(process.env.BUDGET_MS || 33000);
const t0 = Date.now();
const outOfTime = () => Date.now() - t0 > BUDGET_MS;
const log = (...a) => console.error(...a);
// Play serves a stripped page to unknown agents; this is a plain read of a
// robots-allowed public page, at one request at a time.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  await sleep(700);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status, text: await res.text() };
  } catch (e) { return { ok: false, error: e.message }; }
}

const PLAY_PREFIXES = (v) => {
  // Android package ids are not the iOS bundle ids. Derive plausible prefixes
  // from both, plus the bare vendor key (sociabble.mobile.<customer>).
  const out = new Set();
  for (const p of v.bundlePrefixes) {
    out.add(p.toLowerCase());
    const parts = p.toLowerCase().replace(/\.$/, '').split('.');
    if (parts.length > 1) out.add(parts.slice(1).join('.') + '.');
  }
  out.add(v.key.replace(/_/g, '') + '.');
  return [...out];
};

function tokenFrom(pkg, prefixes, vendorKey) {
  const p = pkg.toLowerCase();
  for (const pre of prefixes.sort((a, b) => b.length - a.length)) {
    if (p.startsWith(pre)) {
      const rest = p.slice(pre.length);
      if (rest) return rest;
    }
  }
  // Android package ids do not always start with the vendor: Beekeeper ships
  // ch.beekeeper.<customer>, Staffbase ships several shapes. Find the vendor
  // segment anywhere in the id and take what follows it.
  const segs = p.split('.');
  const i = segs.findIndex((sg) => sg === vendorKey.replace(/_/g, '') || sg === vendorKey);
  if (i >= 0 && segs.length > i + 1) return segs.slice(i + 1).join('.');
  return null;
}

async function main() {
  await fs.mkdir(CACHE, { recursive: true });
  const all = [];
  let remaining = 0;

  for (const vendor of VENDORS) {
    const cacheFile = path.join(CACHE, `${vendor.key}.json`);
    const cached = await fs.readFile(cacheFile, 'utf8').then(JSON.parse).catch(() => null);
    if (cached) { all.push(...cached.rows); continue; }
    if (outOfTime()) { remaining++; continue; }

    log(`\n== ${vendor.name}`);
    const names = [...new Set([vendor.name.replace(/\s*\(.*\)\s*/, '').trim(), vendor.playDeveloper].filter(Boolean))];
    let pkgs = new Set(), usedName = null;
    for (const n of names) {
      const r = await get(`https://play.google.com/store/apps/developer?id=${encodeURIComponent(n)}`);
      if (!r.ok) { log(`   developer?id=${n} -> ${r.status || r.error}`); continue; }
      const found = [...r.text.matchAll(/\/store\/apps\/details\?id=([A-Za-z0-9._]+)/g)].map((m) => m[1]);
      if (found.length) { usedName = n; found.forEach((f) => pkgs.add(f)); break; }
    }
    if (!pkgs.size) {
      log('   no Play developer page found');
      await fs.writeFile(cacheFile, JSON.stringify({ rows: [] }, null, 2));
      continue;
    }

    const prefixes = PLAY_PREFIXES(vendor);
    const rows = [];
    for (const pkg of pkgs) {
      const token = tokenFrom(pkg, prefixes, vendor.key);
      if (!token) continue;
      rows.push({
        vendor_key: vendor.key, vendor_name: vendor.name, vendor_tier: vendor.tier,
        is_client_vendor: Boolean(vendor.isClient),
        domain: null, domain_source: null, customer_token: token,
        evidence: {
          source: 'Google Play',
          app_name: null, // filled in below only for tokens iOS did not already have
          bundle_id: pkg,
          bundle_customer_token: token,
          developer_account: usedName,
          developer_id: null,
          seller_url: null,
          app_url: `https://play.google.com/store/apps/details?id=${pkg}`,
          first_released: null, last_updated: null, description_excerpt: '',
        },
      });
    }
    log(`   ${pkgs.size} package(s) -> ${rows.length} customer rows (developer "${usedName}")`);
    await fs.writeFile(cacheFile, JSON.stringify({ rows }, null, 2));
    all.push(...rows);
  }

  await fs.writeFile(OUT, JSON.stringify({ schema: 1, built_at: new Date().toISOString(), rows: all }, null, 2));
  log(`\nWROTE ${OUT} rows=${all.length}`);
  if (remaining) log(`${remaining} vendor(s) left -- re-run.`); else log('ALL VENDORS CACHED.');
}
main().catch((e) => { console.error(e); process.exit(1); });
